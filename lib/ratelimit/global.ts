import { Redis } from "@upstash/redis";
import { hasRateLimit, serverEnv } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/config";

/**
 * Layer 3 — global daily LLM budget guard.
 *
 * Counts every Gemini call across all users in a single Upstash counter,
 * keyed by UTC date. Returns a tier:
 *   - "ok"   → request allowed at full session limits
 *   - "soft" → allowed but with tightened per-session burst (caller decides)
 *   - "hard" → reject with 503; we're at capacity for today
 *
 * This is what keeps the deployed instance up under viral load: a single
 * spike can never blow through the daily provider quota and crash the
 * site for everyone.
 */

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (!hasRateLimit()) return null;
  if (redis) return redis;
  redis = new Redis({
    url: serverEnv.UPSTASH_REDIS_REST_URL!,
    token: serverEnv.UPSTASH_REDIS_REST_TOKEN!
  });
  return redis;
}

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `ss:rl:global:gemini:${yyyy}-${mm}-${dd}`;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export interface GlobalBudgetState {
  usage: number;
  limit: number;
  fraction: number;
  tier: "ok" | "soft" | "hard";
}

/** Inspect current usage without consuming a slot. */
export async function getGlobalBudget(): Promise<GlobalBudgetState> {
  const r = getRedis();
  const limit = RATE_LIMITS.global.geminiDailyBudget;
  if (!r) return { usage: 0, limit, fraction: 0, tier: "ok" };
  const raw = (await r.get(todayKey())) as number | string | null;
  const usage = typeof raw === "number" ? raw : Number(raw ?? 0);
  return computeTier(usage, limit);
}

/** Reserve one slot. Returns the resulting state. If `tier === "hard"`,
 *  the caller MUST reject the request. */
export async function reserveGlobalCall(): Promise<GlobalBudgetState> {
  const r = getRedis();
  const limit = RATE_LIMITS.global.geminiDailyBudget;
  if (!r) return { usage: 0, limit, fraction: 0, tier: "ok" };

  // Read first to short-circuit hard tier without burning a write.
  const before = await getGlobalBudget();
  if (before.tier === "hard") return before;

  const newUsage = (await r.incr(todayKey())) as number;
  // Set TTL on first write so the counter naturally rolls over at UTC midnight.
  if (newUsage === 1) {
    await r.expire(todayKey(), secondsUntilUtcMidnight());
  }
  return computeTier(newUsage, limit);
}

function computeTier(usage: number, limit: number): GlobalBudgetState {
  const fraction = limit > 0 ? usage / limit : 0;
  let tier: GlobalBudgetState["tier"] = "ok";
  if (fraction >= RATE_LIMITS.global.hardThreshold) tier = "hard";
  else if (fraction >= RATE_LIMITS.global.softThreshold) tier = "soft";
  return { usage, limit, fraction, tier };
}
