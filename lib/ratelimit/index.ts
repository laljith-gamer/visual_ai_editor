import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { hasRateLimit, serverEnv } from "@/lib/env";

let limiter: Ratelimit | null = null;

function getLimiter(): Ratelimit | null {
  if (!hasRateLimit()) return null;
  if (limiter) return limiter;
  const redis = new Redis({
    url: serverEnv.UPSTASH_REDIS_REST_URL!,
    token: serverEnv.UPSTASH_REDIS_REST_TOKEN!
  });
  limiter = new Ratelimit({
    redis,
    // 30 requests per minute per identifier
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    analytics: false,
    prefix: "ss:rl"
  });
  return limiter;
}

/** Returns true if the request is allowed, false if it should be rejected. */
export async function checkRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  const l = getLimiter();
  if (!l) return { allowed: true, remaining: -1, reset: 0 };
  const r = await l.limit(identifier);
  return { allowed: r.success, remaining: r.remaining, reset: r.reset };
}
