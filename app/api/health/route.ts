import { NextResponse } from "next/server";
import { hasAnyChatProvider, hasGemini, hasRateLimit } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0",
    chat: hasAnyChatProvider(),
    vision: hasGemini(),
    rateLimit: hasRateLimit(),
    timestamp: Date.now()
  });
}
