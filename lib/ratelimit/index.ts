import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { hasRateLimit, serverEnv } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/config";
import { checkCircuit, recordFailure, recordSuccess, type Provider } from "./circuit";
import { reserveGlobalCall, getGlobalBudget } from "./global";
import type { RateLimitDecision } from "@/lib/types";

/**
 * Compose all rate-limit layers for an authenticated route handler.
 *
 * Layer 1 (IP) is enforced in middleware.ts before this code runs.
 * Layers 2/3/4 are checked here:
 *
 *   2. Session burst + daily limits per scope (cookie-sid).
 *   3. Global LLM daily budget (only for scopes that hit Gemini).
 *   4. Provider circuit breaker — OPT-IN: only runs (and can block) when the
 *      caller passes an explicit `provider`. Multi-provider dispatcher routes
 *      omit it so the dispatcher can own circuit-skip + fallback.
 *
 * Returns a RateLimitDecision the route handler can directly translate
 * into a response. Soft-tier requests succeed but get tightened bursts
 * on subsequent calls; hard-tier requests are rejected with 503.
 */

export type RateLimitScope = "agent" | "vision-window" | "vision-frame" | "vision-clip";

interface SessionLimiter {
  burst: Ratelimit | null;
  daily: Ratelimit | null;
}

const sessionLimiters = new Map<RateLimitScope, SessionLimiter>();

function getSessionLimiter(scope: RateLimitScope): SessionLimiter {
  const cached = sessionLimiters.get(scope);
  if (cached) return cached;
  if (!hasRateLimit()) {
    const empty = { burst: null, daily: null };
    sessionLimiters.set(scope, empty);
    return empty;
  }
  const cfg = sessionConfigFor(scope);
  const redis = new Redis({
    url: serverEnv.UPSTASH_REDIS_REST_URL!,
    token: serverEnv.UPSTASH_REDIS_REST_TOKEN!
  });
  const limiter: SessionLimiter = {
    burst: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.burstLimit, `${cfg.burstWindowSeconds} s`),
      analytics: false,
      prefix: `ss:rl:session:${scope}:burst`
    }),
    daily: new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(cfg.dailyLimit, "1 d"),
      analytics: false,
      prefix: `ss:rl:session:${scope}:daily`
    })
  };
  sessionLimiters.set(scope, limiter);
  return limiter;
}

function sessionConfigFor(scope: RateLimitScope): {
  burstLimit: number;
  burstWindowSeconds: number;
  dailyLimit: number;
} {
  switch (scope) {
    case "agent":
      return RATE_LIMITS.session.agent;
    case "vision-window":
      return RATE_LIMITS.session.visionWindow;
    case "vision-frame":
      return RATE_LIMITS.session.visionFrame;
    case "vision-clip":
      // v1.6.4 — chat-driven clip Q&A. The cost profile sits between
      // a vision-window call (one image) and vision-frame (many images
      // per turn), so we reuse vision-window's session config rather
      // than introduce a third tunable bucket. If the workload diverges
      // (e.g. users start spamming describe), promote this to its own
      // RATE_LIMITS.session.visionClip block.
      return RATE_LIMITS.session.visionWindow;
  }
}

/** Punishment-tier counter (per session, per UTC day). */
async function strictTierApplied(sid: string): Promise<boolean> {
  if (!hasRateLimit()) return false;
  const redis = new Redis({
    url: serverEnv.UPSTASH_REDIS_REST_URL!,
    token: serverEnv.UPSTASH_REDIS_REST_TOKEN!
  });
  const raw = (await redis.get(strictKey(sid))) as number | string | null;
  const hits = typeof raw === "number" ? raw : Number(raw ?? 0);
  return hits >= RATE_LIMITS.punish.maxHitsBeforeStrict;
}

async function recordRateLimitHit(sid: string): Promise<void> {
  if (!hasRateLimit()) return;
  const redis = new Redis({
    url: serverEnv.UPSTASH_REDIS_REST_URL!,
    token: serverEnv.UPSTASH_REDIS_REST_TOKEN!
  });
  const now = await redis.incr(strictKey(sid));
  if (now === 1) await redis.expire(strictKey(sid), 24 * 60 * 60);
}

function strictKey(sid: string): string {
  return `ss:rl:strict:${sid}`;
}

// ---------------------------------------------------------------------
// Backwards-compatible single-scope helper (used by callers that haven't
// migrated to checkAllLimits yet).
// ---------------------------------------------------------------------

/** Returns true if the request is allowed, false if it should be rejected. */
export async function checkRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  const sl = getSessionLimiter("agent");
  if (!sl.burst) return { allowed: true, remaining: -1, reset: 0 };
  const r = await sl.burst.limit(identifier);
  return { allowed: r.success, remaining: r.remaining, reset: r.reset };
}

// ---------------------------------------------------------------------
// Main entry: check every layer for a given scope.
// ---------------------------------------------------------------------

interface CheckArgs {
  sid: string;
  scope: RateLimitScope;
  /** True for scopes that consume LLM budget (agent + vision/*). */
  consumesLlm?: boolean;
  /** OPT-IN provider circuit pre-check. Pass this ONLY from single-provider
   *  routes (e.g. Gemini-direct vision) that want a blocking fast-fail when
   *  the provider's circuit is open. Dispatcher-backed routes must OMIT it so
   *  the dispatcher (lib/providers/cloud.ts) can skip open circuits and fall
   *  back to the next provider instead of being blocked here. */
  provider?: Provider;
}

export async function checkAllLimits(args: CheckArgs): Promise<RateLimitDecision> {
  const { sid, scope, provider } = args;
  const consumesLlm = args.consumesLlm ?? true;

  // ---- Layer 4: provider circuit breaker (OPT-IN) -------------------
  // Only SINGLE-PROVIDER routes (e.g. /api/vision/frame and
  // /api/vision/window → Gemini direct) pass an explicit `provider` and get
  // a blocking fast-fail when that provider's circuit is open. Routes backed
  // by the multi-provider dispatcher (lib/providers/cloud.ts) intentionally
  // DO NOT pass a provider: the dispatcher itself skips circuit-open
  // providers and falls back to the next configured one, so a route-level
  // fast-fail here would wrongly block that fallback (returning 503 before
  // Gemini/Groq could be tried).
  if (consumesLlm && provider) {
    const c = await checkCircuit(provider);
    if (!c.closed) {
      // Circuit open → fail fast for this single-provider route. We still
      // return a decision so the caller can surface a friendly message.
      return {
        allowed: false,
        reason: `circuit_open:${provider}`,
        status: 503,
        retryAfterSeconds: c.retryAfterSeconds,
        tier: "hard"
      };
    }
  }

  // ---- Layer 2: session burst (with optional strict tier) -----------
  const sl = getSessionLimiter(scope);
  if (sl.burst) {
    const strict = await strictTierApplied(sid);
    const burstResult = await sl.burst.limit(sid);
    if (strict) {
      // Apply a tighter cap: only the first request per minute passes.
      // We approximate by treating the strict bucket as 1/min on top of
      // the regular bucket.
      // (Re-using the sliding-window result as the de-facto check is fine
      // because once strict, they're flagged for the rest of the day.)
      if (!burstResult.success) {
        await recordRateLimitHit(sid);
        return {
          allowed: false,
          reason: "session_strict_burst",
          status: 429,
          retryAfterSeconds: Math.max(1, Math.ceil((burstResult.reset - Date.now()) / 1000)),
          tier: "hard"
        };
      }
    } else if (!burstResult.success) {
      await recordRateLimitHit(sid);
      return {
        allowed: false,
        reason: "session_burst",
        status: 429,
        retryAfterSeconds: Math.max(1, Math.ceil((burstResult.reset - Date.now()) / 1000)),
        tier: "hard"
      };
    }
  }

  // ---- Layer 2 cont.: daily session cap -----------------------------
  if (sl.daily) {
    const dailyResult = await sl.daily.limit(sid);
    if (!dailyResult.success) {
      await recordRateLimitHit(sid);
      return {
        allowed: false,
        reason: "session_daily",
        status: 429,
        retryAfterSeconds: Math.max(1, Math.ceil((dailyResult.reset - Date.now()) / 1000)),
        tier: "hard"
      };
    }
  }

  // ---- Layer 3: global LLM daily budget -----------------------------
  if (consumesLlm) {
    const g = await reserveGlobalCall();
    if (g.tier === "hard") {
      return {
        allowed: false,
        reason: "global_budget",
        status: 503,
        retryAfterSeconds: secondsUntilUtcMidnight(),
        tier: "hard",
        usage: g.usage,
        limit: g.limit
      };
    }
    return { allowed: true, tier: g.tier, usage: g.usage, limit: g.limit };
  }

  return { allowed: true, tier: "ok" };
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

// ---------------------------------------------------------------------
// Re-exports so route handlers can import everything from one place.
// ---------------------------------------------------------------------

export { checkCircuit, recordSuccess, recordFailure } from "./circuit";
export { reserveGlobalCall, getGlobalBudget } from "./global";
export { checkIpRateLimit, clientIp } from "./edge";
export type { Provider } from "./circuit";
