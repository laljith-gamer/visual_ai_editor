// =====================================================================
// app/api/agent/intent/route.ts
//
// TEXT-ONLY Chat Brain endpoint. Two tasks:
//
//   { "task": "warmup" }   → cheaply warm the cloud text provider (so the
//                            first real resolve is fast) and report readiness.
//   { "task": "resolve", ... }  → classify an ambiguous chat turn / free-text
//                            answer into a strict ChatBrainIntent JSON.
//
// PRIVACY: this route accepts ONLY compact text state. It rejects any body
// containing media/secret-shaped keys (defense in depth) and never receives
// video bytes, frames, thumbnails, audio, or transcript bodies. Keys stay
// server-only via the existing provider dispatcher.
//
// When no cloud provider is configured (the default for this repo) warmup
// returns { status: "unavailable" } and resolve returns { intent: null } —
// the client then stays in deterministic mode with no error surfaced.
// =====================================================================

import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session/cookie";
import { checkAllLimits } from "@/lib/ratelimit";
import { cloudAiDisabled, hasAnyChatProvider, serverEnv } from "@/lib/env";
import { cloudPlannerJson } from "@/lib/providers/cloud";
import { extractJsonObject } from "@/lib/util/safeJson";
import { newId } from "@/lib/util/id";
import {
  parseChatBrainIntent,
  payloadHasForbiddenKeys,
  type ChatBrainIntent
} from "@/lib/llm/chatBrainSchema";

export const runtime = "nodejs";

interface WarmupResponse {
  status: "ready" | "unavailable";
}
interface ResolveResponse {
  intent: ChatBrainIntent | null;
  /** Present only when the brain is unavailable, for client logging. */
  unavailable?: boolean;
}

const RESOLVE_SYSTEM_PROMPT = [
  "You are the intent router for a browser-first AI video editor.",
  "You ONLY receive compact text state — never video, frames, audio, or transcripts.",
  "Classify the user's latest message into ONE route and extract any editing slots you can.",
  "If a pendingQuestion is present, decide whether the message ANSWERS it (set answersPendingQuestion + route 'answer_pending_question').",
  "",
  "RUNNING GOAL / MEMORY: the payload may include activeTargetSeconds (a duration the user set on an earlier turn) and activeSubject (the current edit's focus). Treat these as the conversation's standing goal:",
  "- If the new message only adds/changes the SUBJECT (e.g. 'combat scene') and states no duration, KEEP activeTargetSeconds as targetSeconds.",
  "- If the new message only states a DURATION (e.g. 'make it 1 min') and names no subject, keep working on activeSubject.",
  "- A later explicit value always overrides the remembered one. Never silently drop a duration the user already gave.",
  "",
  "Return STRICT JSON ONLY (no prose, no markdown) matching this TypeScript type:",
  "{",
  '  "route": "answer_pending_question" | "describe_video" | "create_highlight" | "refine_timeline" | "trim_to_target" | "read_only" | "confirm_pending" | "cancel_pending" | "passthrough" | "ask_clarifying_question",',
  '  "confidence": number,            // 0..1',
  '  "outputType"?: "best_moments_reel" | "one_continuous_short" | "specific_scene" | "merge_as_is" | "unknown",',
  '  "sourceScope"?: "current_video" | "current_timeline" | "selected_videos" | "all_uploaded" | "unspecified",',
  '  "contentFocus"?: string[],       // user topics, e.g. ["travel","places"]',
  '  "includeConcepts"?: string[],',
  '  "excludeConcepts"?: string[],',
  '  "targetSeconds"?: number | null,',
  '  "style"?: string | null,',
  '  "answersPendingQuestion"?: boolean,',
  '  "pendingQuestionId"?: string | null,',
  '  "shouldAsk"?: boolean,',
  '  "askMessage"?: string | null,   // one short useful question if shouldAsk',
  '  "suggestions"?: string[],',
  '  "normalizedUserText": string,   // typo-fixed, e.g. "one continuos" -> "one continuous"',
  '  "reason": string',
  "}",
  "Rules: never invent on-screen content you cannot know from text; prefer 'passthrough' when unsure; keep contentFocus to the user's own words."
].join("\n");

// ChatGPT-style conversational persona, grounded in THIS editing tool. Used
// by the { task: "chat" } lane for greetings / questions / general chat.
const CHAT_SYSTEM_PROMPT = [
  "You are the friendly, concise in-app assistant for a browser video editor (Shorts Studio).",
  "Chat naturally and helpfully like ChatGPT, but stay grounded in this tool.",
  "",
  "What the tool CAN do: import videos; find/clip the best moments; build highlight reels;",
  "keep one continuous clip; trim to a target length; merge multiple videos; output",
  "vertical / horizontal / square; apply cut / fade / crossfade; render and export.",
  "It plans edits from the user's words and scores video frames on-device.",
  "What it CANNOT do yet: reliably watch/describe raw frames in local mode; music/SFX;",
  "burned-in captions; heavy color grading.",
  "",
  "Style: warm, direct, 1-4 sentences. Answer the user's question first. If they seem to",
  "want an edit, guide them with ONE natural follow-up (never dump a menu). NEVER claim you",
  "performed an edit — you only chat here; the editor performs edits when the user instructs it.",
  "",
  "You receive recent conversation as JSON {messages:[{role,content}...]}. Reply to the LAST",
  "user message in context.",
  "",
  'Return STRICT JSON ONLY (no markdown): {"reply": "<your message>"}'
].join("\n");

async function rateLimited(): Promise<boolean> {
  try {
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    if (!session.sid) {
      session.sid = newId("u");
      session.createdAt = Date.now();
      await session.save();
    }
    const rl = await checkAllLimits({ sid: session.sid, scope: "agent", consumesLlm: true });
    return !rl.allowed;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Defense in depth: never accept media/secret-shaped keys.
  if (payloadHasForbiddenKeys(body)) {
    return NextResponse.json({ error: "Payload contains disallowed fields" }, { status: 400 });
  }

  const task = typeof body.task === "string" ? body.task : "";

  // ---- STATUS ------------------------------------------------------------
  // Cheap, side-effect-free readiness check for the chat brain toggle. It
  // reports whether a cloud provider is CONFIGURED (cloud enabled + a key),
  // WITHOUT a model call, and the SPECIFIC reason when it isn't — so the
  // toggle can tell the user exactly what to fix (no key vs cloud disabled).
  if (task === "status") {
    const cloudEnabled = !cloudAiDisabled();
    const hasProviderKey = Boolean(
      serverEnv.OPENROUTER_API_KEY ||
        serverEnv.CUSTOM_OPENAI_API_KEY ||
        serverEnv.GEMINI_API_KEY ||
        serverEnv.GROQ_API_KEY
    );
    return NextResponse.json({
      configured: cloudEnabled && hasProviderKey,
      cloudEnabled,
      hasProviderKey
    });
  }

  // ---- CHAT --------------------------------------------------------------
  // ChatGPT-style conversational reply, grounded in this editing tool. Used
  // for greetings / open questions / anything that isn't a concrete edit.
  // Text-only + privacy-safe; returns { reply } or { unavailable }.
  if (task === "chat") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json({ reply: null, unavailable: true });
    }
    if (await rateLimited()) {
      return NextResponse.json({ reply: null, unavailable: true });
    }
    const convo = JSON.stringify({ messages: body.messages ?? [] }).slice(0, 6000);
    try {
      const result = await cloudPlannerJson(CHAT_SYSTEM_PROMPT, convo, {
        temperature: 0.5
      });
      const parsed = extractJsonObject<{ reply?: unknown }>(result.raw);
      const reply =
        parsed && typeof parsed.reply === "string" ? parsed.reply.slice(0, 1200) : null;
      return NextResponse.json({ reply });
    } catch {
      return NextResponse.json({ reply: null, unavailable: true });
    }
  }

  // ---- UNDERSTAND --------------------------------------------------------
  // NEW: AI-powered intent understanding with system prompt. Used by the
  // dev intent tester and can replace hardcoded patterns. Returns structured
  // JSON describing what the user wants to do.
  if (task === "understand") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json({ 
        action: "unavailable",
        target: "",
        parameters: {},
        confidence: 0,
        needs_clarification: false,
        question: "Cloud AI is not configured"
      });
    }
    if (await rateLimited()) {
      return NextResponse.json({
        action: "rate_limited",
        target: "",
        parameters: {},
        confidence: 0,
        needs_clarification: false
      });
    }

    const UNDERSTAND_SYSTEM_PROMPT = [
      "You are an AI assistant for a video editor.",
      "Understand what the user wants to do.",
      "Return only JSON.",
      "",
      "Available actions:",
      "- merge: Combine multiple videos without editing",
      "- clip_range: Extract a specific time range (first N seconds, last N seconds, from X to Y)",
      "- trim: Remove parts from a clip",
      "- create_highlights: Make a highlight reel from best parts",
      "- describe: Analyze what's in the video",
      "- format_change: Change output format (vertical/horizontal/square)",
      "- confirm: User agreeing to proceed",
      "- cancel: User canceling an action",
      "- sequence: Multiple actions in order",
      "",
      "Return strict JSON matching:",
      "{",
      '  "action": string,              // primary action type',
      '  "target": string,               // what the action applies to',
      '  "parameters": {                 // action-specific params',
      '    "duration"?: number,          // seconds',
      '    "start_time"?: number,',
      '    "end_time"?: number,',
      '    "videos"?: string[],          // which videos by index/name',
      '    "format"?: "vertical" | "horizontal" | "square",',
      '    "sequence"?: Array<{action, target, parameters}>',
      '  },',
      '  "confidence": number,           // 0.0 to 1.0',
      '  "needs_clarification": boolean,',
      '  "question"?: string,            // if clarification needed',
      '  "reasoning"?: string            // why you chose this interpretation',
      "}"
    ].join("\n");

    const userMessage = typeof body.userMessage === "string" ? body.userMessage : "";
    const context = (body.context ?? {}) as Record<string, unknown>;
    
    const payload = JSON.stringify({
      user_message: userMessage,
      context: {
        uploaded_videos: context.uploadedVideos ?? 0,
        selected_videos: context.selectedVideos ?? 0,
        timeline_clips: context.timelineClips ?? 0,
        timeline_empty: context.timelineEmpty ?? true,
        has_pending_action: context.hasPendingAction ?? false
      }
    });

    try {
      const result = await cloudPlannerJson(UNDERSTAND_SYSTEM_PROMPT, payload, {
        temperature: 0.3
      });
      const parsed = extractJsonObject<Record<string, unknown>>(result.raw);
      
      return NextResponse.json({
        action: typeof parsed?.action === "string" ? parsed.action : "unknown",
        target: typeof parsed?.target === "string" ? parsed.target : "",
        parameters: typeof parsed?.parameters === "object" ? parsed.parameters : {},
        confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0.5,
        needs_clarification: parsed?.needs_clarification === true,
        question: typeof parsed?.question === "string" ? parsed.question : undefined,
        reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : undefined
      });
    } catch (err) {
      return NextResponse.json({
        action: "error",
        target: "",
        parameters: { error: err instanceof Error ? err.message : String(err) },
        confidence: 0,
        needs_clarification: false
      });
    }
  }

  // ---- WARMUP ------------------------------------------------------------
  if (task === "warmup") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json<WarmupResponse>({ status: "unavailable" });
    }
    if (await rateLimited()) {
      // Don't fail — just report not-ready so the client retries later.
      return NextResponse.json<WarmupResponse>({ status: "unavailable" });
    }
    try {
      // Tiny, cheap request that primes the provider connection.
      await cloudPlannerJson(
        'Reply with strict JSON only: {"ok":true}',
        '{"task":"warmup"}',
        { temperature: 0 }
      );
      return NextResponse.json<WarmupResponse>({ status: "ready" });
    } catch {
      return NextResponse.json<WarmupResponse>({ status: "unavailable" });
    }
  }

  // ---- RESOLVE -----------------------------------------------------------
  if (task === "resolve") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json<ResolveResponse>({ intent: null, unavailable: true });
    }
    if (await rateLimited()) {
      return NextResponse.json<ResolveResponse>({ intent: null, unavailable: true });
    }
    // The body itself is the privacy-safe payload (already forbidden-key
    // checked). Serialize it as the user content for the model.
    const userContent = JSON.stringify(body).slice(0, 4000);
    try {
      const result = await cloudPlannerJson(RESOLVE_SYSTEM_PROMPT, userContent, {
        temperature: 0
      });
      const parsed = extractJsonObject<Record<string, unknown>>(result.raw);
      const intent = parseChatBrainIntent(parsed);
      return NextResponse.json<ResolveResponse>({ intent });
    } catch {
      // Any provider failure → null (client falls back to deterministic).
      return NextResponse.json<ResolveResponse>({ intent: null, unavailable: true });
    }
  }

  // ---- ROUTE (v3.0) -------------------------------------------------------
  // Unified AI intent router. Replaces the ~15 regex/keyword classifiers with
  // a single LLM call that returns structured, actionable JSON for ANY user
  // message. This is the PRIMARY brain for understanding what the user wants.
  //
  // The system prompt covers ALL editor actions: timeline editing, creation,
  // multi-source, transitions, format, source control, conversation, and
  // control commands. It understands context (pending questions, active
  // targets, source names) and returns typed parameters (time ranges, source
  // refs, clip refs, durations, topics, formats).
  if (task === "route") {
    if (cloudAiDisabled() || !hasAnyChatProvider()) {
      return NextResponse.json({
        action: "unavailable",
        confidence: 0,
        reasoning: "Cloud AI is not configured",
        normalizedText: ""
      });
    }
    if (await rateLimited()) {
      return NextResponse.json({
        action: "unavailable",
        confidence: 0,
        reasoning: "Rate limited",
        normalizedText: ""
      });
    }

    const ROUTE_SYSTEM_PROMPT = [
      "You are the intent router for Shorts Studio, a browser-first AI video editor.",
      "You receive ONLY compact text state — never video, frames, audio, or API keys.",
      "",
      "Your job: understand the user's latest message in context and classify it into",
      "ONE structured action with typed parameters. You handle typo correction, multi-step",
      "commands, context awareness, and slot extraction — all in one call.",
      "",
      "AVAILABLE ACTIONS (choose exactly one):",
      "",
      "Timeline mutations:",
      "- add_clip: Add footage to the timeline (time range or topic search)",
      "- remove_clip: Remove a clip from the timeline",
      "- move_clip: Reorder a clip (move clip N before/after clip M)",
      "- trim_clip: Shorten a specific clip",
      "- extend_clip: Lengthen a specific clip",
      "- replace_clip: Swap a clip with different footage",
      "- split_clip: Split a clip at a time point",
      "",
      "Creation / analysis:",
      "- create_highlight: Make a highlight reel / best parts / reel of specific topic",
      "- find_moment: Find one specific moment in the video",
      "- describe_video: User wants to know what's in the video (watch/describe/what's happening)",
      "- scan_video: Run a quick structural scan of the video",
      "",
      "Multi-source:",
      "- merge_videos: Concatenate multiple whole videos",
      "- compose_montage: Create a montage picking from multiple sources by topic",
      "",
      "Timeline-wide:",
      "- trim_to_target: Trim the current timeline to fit a target duration",
      "- refine_timeline: Filter/change the current timeline (remove boring parts, keep only X)",
      "",
      "Transitions:",
      "- set_transition: Set a specific transition between clips",
      "- auto_transitions: Auto-pick transitions for all boundaries",
      "- remove_transitions: Remove all transitions",
      "",
      "Control:",
      "- render: Render/assemble the video",
      "- export: Export/download/save the rendered video",
      "- undo: Undo the last action",
      "- redo: Redo the last undone action",
      "",
      "Tool commands:",
      "- set_format: Change output format (vertical/horizontal/square/9:16/16:9/1:1)",
      "- select_source: Change which videos are selected for editing (use all / only video 2 / etc.)",
      "- switch_source: Switch which video is shown in preview",
      "",
      "Conversation:",
      "- confirm_pending: User is confirming/agreeing (yes/ok/go ahead/do it) — WITH a pending action",
      "- cancel_pending: User is canceling (no/cancel/stop) — WITH a pending action",
      "- answer_question: User is answering a pending clarification question",
      "- chat: Greeting, general question, or conversational turn (not an edit command)",
      "- read_only_question: Question about what the editor did/can do (explain/why/how/what happened)",
      "",
      "Fallback:",
      "- clarify: You need to ask the user a question to understand their intent",
      "- passthrough: You're not confident enough to classify (let the fallback handle it)",
      "",
      "CONTEXT AWARENESS:",
      "- If hasPendingQuestion is true and the message looks like an answer, use answer_question",
      "- If hasPendingAction is true and the message is 'yes'/'ok'/'go', use confirm_pending",
      "- If hasPendingAction is true and the message is 'no'/'cancel', use cancel_pending",
      "- activeTargetSeconds is the duration from a previous turn — carry it forward if the new",
      "  message doesn't override it",
      "- activeSubject is what the user is editing — carry it forward if not overridden",
      "",
      "TYPO HANDLING: Fix common typos in normalizedText (vedio→video, verticle→vertical,",
      "combact→combat, atleast→at least, etc.). The user types casually.",
      "",
      "TOPIC EXTRACTION: For create_highlight/find_moment/compose_montage, extract the user's",
      "ACTUAL content topics into the topics field. Don't include editing vocabulary (best/clips/",
      "highlights/make/create) as topics — only real content subjects (cooking, fighting, travel,",
      "sunset, interview, etc.). If the request is generic ('best parts', 'highlights') with no",
      "specific content topic, set topics to [] and the pipeline will use visual interest scoring.",
      "",
      "MULTI-STEP: For 'merge then trim the first 30 seconds', return action='merge_videos'",
      "with parameters.sequence containing the trim step.",
      "",
      "Return STRICT JSON ONLY (no markdown, no prose) matching this shape:",
      "{",
      '  "action": string,              // one of the actions above',
      '  "confidence": number,           // 0.0 to 1.0',
      '  "reasoning": string,            // brief explanation of your classification',
      '  "normalizedText": string,       // typo-corrected user text',
      '  "parameters": {                 // action-specific (all fields optional)',
      '    "duration": number,            // seconds for create_highlight, trim_to_target',
      '    "startTime": number,           // seconds for time ranges',
      '    "endTime": number,             // seconds for time ranges',
      '    "timeRange": { "kind": "first"|"last"|"middle"|"absolute", "startSeconds": N, "endSeconds": N, "durationSeconds": N },',
      '    "topics": string[],            // content topics the user wants',
      '    "excludeTopics": string[],     // things to avoid',
      '    "format": "vertical"|"horizontal"|"square",',
      '    "sourceRef": { "type": "index"|"name"|"active"|"all"|"selected", "index": N, "name": "..." },',
      '    "clipRef": { "type": "index"|"first"|"last"|"selected"|"all", "index": N },',
      '    "targetClipRef": { "type": "index", "index": N },',
      '    "placement": "before"|"after"|"start"|"end",',
      '    "transitionType": "cut"|"fade"|"crossfade"|"dissolve"|"dip_to_black"|"slide"|"zoom"|"glitch"|"auto",',
      '    "replaceTimeline": boolean,    // true = replace current clips, false = append',
      '    "sequence": [{ action, parameters, ... }]  // for multi-step commands',
      '  },',
      '  "clarifyMessage": string,        // if action=clarify, the question to ask',
      '  "suggestions": string[],         // quick reply chips for clarify',
      '  "chatReply": string              // if action=chat, your conversational reply',
      "}",
      "",
      "SAFETY: When unsure between a mutation and a read-only question, prefer read_only_question.",
      "When unsure about any classification, prefer passthrough (confidence < 0.5).",
      "Never invent content you cannot know from text. Keep topics to the user's own words."
    ].join("\n");

    const userMessage = typeof body.userMessage === "string" ? body.userMessage : "";
    const context = (body.context ?? {}) as Record<string, unknown>;

    const payload = JSON.stringify({
      user_message: userMessage,
      context: {
        uploaded_videos: context.uploadedVideos ?? 0,
        selected_videos: context.selectedVideos ?? 0,
        timeline_clips: context.timelineClips ?? 0,
        has_rendered_output: context.hasRenderedOutput ?? false,
        has_pending_action: context.hasPendingAction ?? false,
        pending_action_kind: context.pendingActionKind ?? null,
        has_pending_question: context.hasPendingQuestion ?? false,
        pending_question_text: context.pendingQuestionText ?? null,
        pending_question_suggestions: context.pendingQuestionSuggestions ?? null,
        active_target_seconds: context.activeTargetSeconds ?? null,
        active_subject: context.activeSubject ?? null,
        source_names: context.sourceNames ?? [],
        previous_assistant_message: typeof context.previousAssistantMessage === "string"
          ? context.previousAssistantMessage.slice(0, 500) : null
      }
    }).slice(0, 6000);

    try {
      const result = await cloudPlannerJson(ROUTE_SYSTEM_PROMPT, payload, {
        temperature: 0.2
      });
      const parsed = extractJsonObject<Record<string, unknown>>(result.raw);

      if (!parsed) {
        return NextResponse.json({
          action: "passthrough",
          confidence: 0,
          reasoning: "Failed to parse AI response",
          normalizedText: userMessage
        });
      }

      return NextResponse.json({
        action: typeof parsed.action === "string" ? parsed.action : "passthrough",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        normalizedText: typeof parsed.normalizedText === "string"
          ? parsed.normalizedText : userMessage,
        parameters: typeof parsed.parameters === "object" ? parsed.parameters : {},
        clarifyMessage: typeof parsed.clarifyMessage === "string"
          ? parsed.clarifyMessage : undefined,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : undefined,
        chatReply: typeof parsed.chatReply === "string" ? parsed.chatReply : undefined
      });
    } catch (err) {
      return NextResponse.json({
        action: "passthrough",
        confidence: 0,
        reasoning: `AI router error: ${err instanceof Error ? err.message : String(err)}`,
        normalizedText: userMessage,
        parameters: {}
      });
    }
  }

  return NextResponse.json({ error: "Unknown task" }, { status: 400 });
}
