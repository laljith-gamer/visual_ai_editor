import { NextRequest, NextResponse } from "next/server";
import { checkIpRateLimit, clientIp } from "@/lib/ratelimit/edge";
import { SECURITY_HEADERS } from "@/lib/config";

/**
 * Edge middleware. Two responsibilities:
 *
 *   1. **Layer-1 rate limit**. Per-IP token bucket, runs at the edge
 *      before any Node runtime spins up. Cheap, broad protection.
 *
 *   2. **Security headers**. CORS isolation (COOP/COEP for SAB), CSP,
 *      HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy.
 *
 * Per-route session limits and the global LLM-budget guard live in the
 * route handlers (`lib/ratelimit/index.ts → checkAllLimits()`), where
 * they have access to the iron-session cookie.
 */

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons|sw.js|manifest.webmanifest).*)"
  ]
};

const LOCAL_MODEL_CONNECT_SRC =
  "https://*.xethub.hf.co https://*.cdn.hf.co https://cdn-lfs.hf.co https://*.hf.co";

function contentSecurityPolicy(): string {
  return SECURITY_HEADERS.contentSecurityPolicy.replace(
    "https://unpkg.com https://cdn.jsdelivr.net;",
    `https://unpkg.com https://cdn.jsdelivr.net ${LOCAL_MODEL_CONNECT_SRC};`
  );
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const isApi = pathname.startsWith("/api/");
  const isAgent = pathname.startsWith("/api/agent");

  // ---- Layer 1: IP rate limit on /api/* ---------------------------
  if (isApi && req.method !== "GET" && req.method !== "HEAD") {
    const ip = clientIp(req);
    const scope = isAgent ? "agent" : "api";
    try {
      const rl = await checkIpRateLimit(ip, scope);
      if (!rl.allowed) {
        return new NextResponse(
          JSON.stringify({
            mode: "error",
            error: "Too many requests from your IP. Please slow down.",
            transient: true
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "Retry-After": String(rl.retryAfterSeconds),
              "X-RateLimit-Limit-Layer": "ip",
              "X-RateLimit-Remaining": String(rl.remaining)
            }
          }
        );
      }
    } catch {
      // If the limiter itself fails (e.g., Upstash transient), fail open —
      // we'd rather serve the user than kill the request because of an
      // operational glitch. Subsequent layers still defend.
    }
  }

  const res = NextResponse.next();
  // Cross-origin isolation (required for SharedArrayBuffer)
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  // Security
  res.headers.set("Strict-Transport-Security", SECURITY_HEADERS.hsts);
  res.headers.set("Content-Security-Policy", contentSecurityPolicy());
  res.headers.set("Permissions-Policy", SECURITY_HEADERS.permissionsPolicy);
  res.headers.set("Referrer-Policy", SECURITY_HEADERS.referrerPolicy);
  res.headers.set("X-Frame-Options", SECURITY_HEADERS.xFrameOptions);
  res.headers.set("X-Content-Type-Options", SECURITY_HEADERS.xContentTypeOptions);
  return res;
}
