import type { SessionOptions } from "iron-session";
import { serverEnv } from "@/lib/env";

export interface SessionData {
  sid?: string;
  createdAt?: number;
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
