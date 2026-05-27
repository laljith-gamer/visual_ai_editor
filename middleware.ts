import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware. Currently lightweight — adds COOP/COEP headers for
 * SharedArrayBuffer (also set in next.config.mjs as a backstop) and lets
 * everything else through. Per-route rate limits and session validation
 * live in the route handlers themselves where they have access to the
 * full Node.js runtime.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return res;
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next/static|_next/image|favicon.ico|icons|sw.js|manifest.webmanifest).*)"
  ]
};
