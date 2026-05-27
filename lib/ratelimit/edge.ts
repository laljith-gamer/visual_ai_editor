import { hasRateLimit, serverEnv } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/config";

/**
 * Layer 1 — IP-based throttle, applied at the edge (middleware).
 *
 * IMPORTANT: middleware runs in Vercel's Edge Runtime where Node.js APIs
 * like `process.version` are unavailable. The `@upstash/redis` package's
 * default import path uses Node APIs, so this module cannot import it.
 * Instead we hit the Upstash REST API directly via `fetch`, which is
 * universally available across runtimes.
 *
 * Two scopes:
 *   - "api"   — every /api/* request (cheap, blanket protection)
 *   - "agent" — stricter, applied to /api/agent (the LLM-cost endpoint)
 *
 * If Upstash is not configured we fall back to a per-region in-memory
 * fixed-window counter. That's less effective than Upstash (each Edge
 * region has its own memory) but it's never zero — a single bad actor
 * still gets throttled within their region.
 */

export interface IpRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetEpochMs: number;
  retryAfterSeconds: number;
}

/** Best-effort client-IP extraction from a Request. Falls back to "anon". */
export function clientIp(req: Request): string {
  const h = req.headers;
  const forwarded =
    h.get("x-forwarded-for") ||
    h.get("x-real-ip") ||
    h.get("cf-connecting-ip") ||
    h.get("fly-client-ip") ||
    "";
  const first = forwarded.split(",")[0]?.trim();
  return first || "anon";
}

export async function checkIpRateLimit(
  ip: string,
  scope: "api" | "agent"
): Promise<IpRateLimitResult> {
  const cfg = RATE_LIMITS.ip[scope];
  if (hasRateLimit()) {
    return checkIpUpstash(ip, scope, cfg.limit, cfg.windowSeconds);
  }
  return checkIpMemory(ip, scope, cfg.limit, cfg.windowSeconds);
}

// ---------------------------------------------------------------------
// In-memory fallback. Per-region instance; not shared across regions.
// ---------------------------------------------------------------------

const memBuckets = new Map<string, { count: number; resetAt: number }>();

function checkIpMemory(
  ip: string,
  scope: string,
  limit: number,
  windowSeconds: number
): IpRateLimitResult {
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const b = memBuckets.get(key);
  if (!b || b.resetAt <= now) {
    memBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: limit - 1,
      resetEpochMs: now + windowMs,
      retryAfterSeconds: 0
    };
  }
  if (b.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetEpochMs: b.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000))
    };
  }
  b.count += 1;
  return {
    allowed: true,
    remaining: limit - b.count,
    resetEpochMs: b.resetAt,
    retryAfterSeconds: 0
  };
}

// ---------------------------------------------------------------------
// Upstash REST API path. Pure fetch — Edge-Runtime safe.
//
// Algorithm: fixed-window counter keyed by floor(now/window). Cheap (1
// pipelined RTT per check) and good enough for blanket IP throttling.
// ---------------------------------------------------------------------

async function checkIpUpstash(
  ip: string,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<IpRateLimitResult> {
  const now = Date.now();
  const bucketStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const resetEpochMs = (bucketStart + windowSeconds) * 1000;
  const key = `ss:rl:ip:${scope}:${ip}:${bucketStart}`;

  try {
    // Pipeline INCR + EXPIRE in a single round trip via the REST API.
    const result = await upstashPipeline([
      ["INCR", key],
      ["EXPIRE", key, String(windowSeconds + 5)]
    ]);
    const count = Number(result?.[0] ?? 0);
    if (count > limit) {
      return {
        allowed: false,
        remaining: 0,
        resetEpochMs,
        retryAfterSeconds: Math.max(1, Math.ceil((resetEpochMs - now) / 1000))
      };
    }
    return {
      allowed: true,
      remaining: Math.max(0, limit - count),
      resetEpochMs,
      retryAfterSeconds: 0
    };
  } catch {
    // Fail open if Upstash itself is down. The session-level limiter in
    // the Node runtime route handlers will still defend.
    return {
      allowed: true,
      remaining: -1,
      resetEpochMs,
      retryAfterSeconds: 0
    };
  }
}

/** Minimal Upstash REST pipeline call. */
async function upstashPipeline(
  commands: Array<Array<string>>
): Promise<unknown[] | null> {
  const url = serverEnv.UPSTASH_REDIS_REST_URL;
  const token = serverEnv.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands),
    cache: "no-store"
  });
  if (!res.ok) {
    throw new Error(`upstash ${res.status}`);
  }
  const json = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  return json.map((step) => step?.result ?? null);
}
