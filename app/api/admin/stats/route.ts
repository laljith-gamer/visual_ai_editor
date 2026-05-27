import { NextRequest, NextResponse } from "next/server";
import { hasAdminAccess, serverEnv } from "@/lib/env";
import {
  checkCircuit,
  getGlobalBudget
} from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Admin-only stats endpoint. Auth gated by ADMIN_TOKEN env var; the request
 * must include the same value in the `X-Admin-Token` header.
 *
 *   curl -H "X-Admin-Token: <token>" https://your-app.vercel.app/api/admin/stats
 *
 * If ADMIN_TOKEN is not set, the endpoint returns 404 (we don't even hint
 * that it exists). This makes it safe to leave deployed without leaking
 * operational info.
 */
export async function GET(req: NextRequest) {
  if (!hasAdminAccess()) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const provided = req.headers.get("x-admin-token") ?? req.headers.get("X-Admin-Token");
  if (!provided || provided !== serverEnv.ADMIN_TOKEN) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const [budget, geminiCircuit, groqCircuit] = await Promise.all([
    getGlobalBudget(),
    checkCircuit("gemini"),
    checkCircuit("groq")
  ]);

  return NextResponse.json({
    timestamp: Date.now(),
    geminiBudget: {
      usage: budget.usage,
      limit: budget.limit,
      fraction: budget.fraction,
      tier: budget.tier
    },
    circuits: {
      gemini: {
        closed: geminiCircuit.closed,
        retryAfterSeconds: geminiCircuit.retryAfterSeconds,
        failures: geminiCircuit.failures
      },
      groq: {
        closed: groqCircuit.closed,
        retryAfterSeconds: groqCircuit.retryAfterSeconds,
        failures: groqCircuit.failures
      }
    },
    env: {
      gemini: Boolean(serverEnv.GEMINI_API_KEY),
      groq: Boolean(serverEnv.GROQ_API_KEY),
      upstash: Boolean(serverEnv.UPSTASH_REDIS_REST_URL),
      sessionSecretSet: Boolean(serverEnv.SESSION_SECRET)
    }
  });
}
