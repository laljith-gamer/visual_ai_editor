import type { SessionOptions } from "iron-session";
import type { MemoryFact } from "@/lib/types";
import { serverEnv } from "@/lib/env";

export interface SessionData {
  sid?: string;
  createdAt?: number;
  /** v1.7.0 — Persistent memory facts extracted from prior planner
   *  turns. Capped at ~10 entries by lib/memory/store.ts so the
   *  encrypted iron-session cookie stays comfortably under 4 KB.
   *  See lib/memory/* for read/merge/inject lifecycle. */
  facts?: MemoryFact[];
}

// In dev with no secret set, fall back to a stable but obviously-insecure
// development secret. Production deployments MUST set SESSION_SECRET.
const password =
  serverEnv.SESSION_SECRET ??
  "dev_only_session_secret_please_set_SESSION_SECRET_in_production_xx";

export const sessionOptions: SessionOptions = {
  password,
  cookieName: "shorts_studio_sid",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30 // 30 days
  }
};
