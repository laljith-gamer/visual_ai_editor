"use client";

// =====================================================================
// lib/agent/conversationalReply.ts
//
// ChatGPT-style conversational replies, grounded in this editing tool.
// Used for turns that are NOT concrete edit/control commands (greetings,
// "what is this about?", open questions). It answers with the SELECTED
// brain:
//   - OpenRouter (cloud) via /api/agent/intent { task: "chat" }
//   - WebLLM (local) — ONLY when the engine is already loaded (never starts
//     a fresh multi-hundred-MB download just to chat)
//
// Returns null when no brain is available, so the caller falls back to the
// existing deterministic flow (no regression when there's no model).
//
// Read-only by contract: it never mutates the store or performs edits.
// =====================================================================

import { useEditorStore } from "@/hooks/useEditorStore";
import { getAIBrain } from "@/lib/ai/brainPreference";

export interface ConversationalReply {
  text: string;
  brain: "cloud" | "local";
}

/** Persona for the on-device (WebLLM) free-text path. The cloud path uses
 *  the server-side prompt in /api/agent/intent. */
const LOCAL_SYSTEM = [
  "You are the friendly in-app assistant for a browser video editor.",
  "Chat naturally and concisely (1-3 sentences), like a helpful editor.",
  "The app can: import videos, find/clip best moments, build highlight reels,",
  "keep one continuous clip, trim to a length, merge videos, pick",
  "vertical/horizontal/square, apply cut/fade/crossfade, and render/export.",
  "It plans edits from the user's words and scores frames on-device; it can't",
  "watch raw video frames in local mode, and doesn't do music/captions/heavy",
  "color grading yet. Never claim you performed an edit here — you only chat;",
  "the editor performs edits when the user gives an instruction. If they seem",
  "to want an edit, ask ONE short, natural follow-up."
].join(" ");

/** Recent chat context (text only), newest last. */
function recentMessages(limit = 8): Array<{ role: string; content: string }> {
  const msgs = useEditorStore.getState().messages;
  return msgs.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}

export async function tryConversationalReply(
  userText: string
): Promise<ConversationalReply | null> {
  const messages = [...recentMessages(), { role: "user", content: userText }];
  const brain = getAIBrain();

  // 1) Cloud (OpenRouter) — preferred when selected.
  if (brain === "cloud") {
    try {
      const res = await fetch("/api/agent/intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "chat", messages })
      });
      if (res.ok) {
        const data = (await res.json()) as { reply?: string; unavailable?: boolean };
        if (data?.reply && data.reply.trim()) {
          return { text: data.reply.trim(), brain: "cloud" };
        }
      }
    } catch {
      /* fall through to local */
    }
  }

  // 2) WebLLM (local) — only if the engine is ALREADY loaded.
  try {
    const { isWebGPUAvailable, isLocalEngineReady, localChatText } = await import(
      "@/lib/local-llm/webllm"
    );
    if (isWebGPUAvailable() && isLocalEngineReady()) {
      const convo = messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
      const out = await localChatText(LOCAL_SYSTEM, `${convo}\nAssistant:`, {
        maxTokens: 320,
        temperature: 0.5
      });
      if (out && out.trim()) return { text: out.trim(), brain: "local" };
    }
  } catch {
    /* no local engine → fall through */
  }

  return null;
}
