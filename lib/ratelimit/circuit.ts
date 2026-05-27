import { Redis } from "@upstash/redis";
import { hasRateLimit, serverEnv } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/config";

/**
 * Layer 4 — circuit breaker per provider.
 *
 * Counts recent failures in a rolling window; once we cross the failure
 * threshold the circuit "opens" for `cooldownMs`. While open, callers
 * should skip that provider entirely and use the fallback chain.
 *
 * State is stored in Upstash so it's shared across Vercel function
 * instances. If Upstash isn't configured the circuit is always closed
 * (best-effort; the gemini provider still has its own retry+fallback).
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

interface CircuitState {
  failures: number[];
  openUntil: number;
}

function key(provider: string): string {
  return `ss:rl:circuit:${provider}`;
}

async function readState(provider: string): Promise<CircuitState> {
  const r = getRedis();
  if (!r) return { failures: [], openUntil: 0 };
  const raw = (await r.get(key(provider))) as CircuitState | string | null;
  if (!raw) return { failures: [], openUntil: 0 };
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as CircuitState;
    } catch {
      return { failures: [], openUntil: 0 };
    }
  }
  return raw;
}

async function writeState(provider: string, state: CircuitState): Promise<void> {
  const r = getRedis();
  if (!r) return;
  // Expire well past cooldown so stale circuits clean themselves up.
  const ttlSeconds = Math.max(60, Math.ceil((RATE_LIMITS.circuitBreaker.cooldownMs * 4) / 1000));
  await r.set(key(provider), JSON.stringify(state), { ex: ttlSeconds });
}

export type Provider = "gemini" | "groq";

export interface CircuitDecision {
  /** True if the caller should attempt this provider. */
  closed: boolean;
  /** Seconds until the circuit can be retried (0 if already closed). */
  retryAfterSeconds: number;
  failures: number;
}

/** Inspect circuit state for a provider. */
export async function checkCircuit(provider: Provider): Promise<CircuitDecision> {
  const s = await readState(provider);
  const now = Date.now();
  if (s.openUntil > now) {
    return {
      closed: false,
      retryAfterSeconds: Math.ceil((s.openUntil - now) / 1000),
      failures: s.failures.length
    };
  }
  return { closed: true, retryAfterSeconds: 0, failures: s.failures.length };
}

/** Record a successful call → resets failure history. */
export async function recordSuccess(provider: Provider): Promise<void> {
  await writeState(provider, { failures: [], openUntil: 0 });
}

/** Record a failure. Trips the circuit if threshold is reached within window. */
export async function recordFailure(provider: Provider): Promise<CircuitDecision> {
  const cfg = RATE_LIMITS.circuitBreaker;
  const now = Date.now();
  const s = await readState(provider);
  // Drop expired failures.
  const fresh = s.failures.filter((t) => now - t <= cfg.failureWindowMs);
  fresh.push(now);
  let openUntil = s.openUntil;
  if (fresh.length >= cfg.failureThreshold && openUntil <= now) {
    openUntil = now + cfg.cooldownMs;
  }
  await writeState(provider, { failures: fresh, openUntil });
  return {
    closed: openUntil <= now,
    retryAfterSeconds: openUntil > now ? Math.ceil((openUntil - now) / 1000) : 0,
    failures: fresh.length
  };
}
