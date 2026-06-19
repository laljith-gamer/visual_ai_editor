// =====================================================================
// lib/agentic-intake/promptCompiler.ts
//
// Turns a (sufficiently complete) EditBrief into:
//   1. a CLEAN, professional, structured model-facing prompt, and
//   2. a short, friendly human-facing summary for the chat surface.
//
// The compiled prompt is what we send to the local LLM / cloud planner —
// NOT the user's raw messy text. It is short, well-structured, and HONEST:
// unsupported effects are listed as REQUESTS for a future effect system,
// never claimed as rendered.
//
// PURE: no React, no store, no API.
// =====================================================================

import {
  classifyEffects,
  type EffectSupportSplit
} from "./capabilityMatrix";
import type {
  EditBrief,
  OutputFormat,
  OutputPlatform,
  OutputType
} from "./editBrief";

function formatLabel(fmt?: OutputFormat): string {
  switch (fmt) {
    case "vertical":
      return "vertical 9:16";
    case "horizontal":
      return "horizontal 16:9";
    case "square":
      return "square 1:1";
    default:
      return "vertical 9:16";
  }
}

function platformLabel(p?: OutputPlatform): string | null {
  switch (p) {
    case "youtube_shorts":
      return "YouTube Shorts";
    case "instagram_reels":
      return "Instagram Reels";
    case "tiktok":
      return "TikTok";
    case "youtube":
      return "YouTube";
    case "linkedin":
      return "LinkedIn";
    default:
      return null;
  }
}

function outputTypeLabel(t?: OutputType): string {
  switch (t) {
    case "single_continuous":
      return "one continuous clip";
    case "multi_clip":
      return "a multi-clip highlight reel";
    case "as_is_merge":
      return "merge the sources as-is (whole clips, in order)";
    default:
      return "best-judgement structure";
  }
}

function sourceScopeLabel(brief: EditBrief): string {
  switch (brief.sourceScope.type) {
    case "current":
      return "the current video only";
    case "selected":
      return "the selected videos";
    case "all":
      return "all uploaded videos";
    case "explicit":
      return brief.sourceScope.sourceIds && brief.sourceScope.sourceIds.length > 0
        ? `the specified videos (${brief.sourceScope.sourceIds.length})`
        : "the specified videos";
    default:
      return "the current video";
  }
}

function durationLabel(brief: EditBrief): string | null {
  if (typeof brief.output.durationSeconds === "number") {
    return `${brief.output.durationSeconds} seconds`;
  }
  if (brief.output.durationRange) {
    return `${brief.output.durationRange.min}-${brief.output.durationRange.max} seconds`;
  }
  return null;
}

/**
 * Compile the brief into a clean planner prompt. Only honest, structured
 * content — never the raw user text. Returns a multi-line string.
 */
export function compileBriefPrompt(brief: EditBrief): string {
  const lines: string[] = [];

  // ---- 1. The deliverable sentence ----
  const fmt = formatLabel(brief.output.format);
  const platform = platformLabel(brief.output.platform);
  const platformPart = platform ? ` for ${platform}` : "";
  lines.push(
    `Create a ${fmt} short from ${sourceScopeLabel(brief)}${platformPart}.`
  );

  // ---- 2. Output structure ----
  lines.push(`Output type: ${outputTypeLabel(brief.output.outputType)}.`);

  // ---- 3. Duration ----
  const dur = durationLabel(brief);
  if (dur) {
    lines.push(`Duration: ${dur}.`);
  } else {
    lines.push("Duration: use the best natural length for the content.");
  }

  // ---- 4. Content focus ----
  if (brief.content.momentDescription) {
    lines.push(`Content focus: the specific moment/range the user described.`);
  } else if (brief.content.focus) {
    lines.push(`Content focus: ${brief.content.focus}, if present in the footage.`);
  } else if (brief.content.genericBestParts) {
    lines.push(
      "Content focus: the most visually engaging moments (broad visual-interest selection; no fixed subject)."
    );
  }
  if (brief.content.transcriptNeed === "captions") {
    lines.push("Transcript: generate captions from speech if available.");
  } else if (brief.content.transcriptNeed === "quotes") {
    lines.push("Transcript: surface key spoken quotes/points if available.");
  }

  // ---- 5. Mood / pacing ----
  const styleBits: string[] = [];
  if (brief.style.mood) styleBits.push(brief.style.mood);
  if (brief.style.pacing && brief.style.pacing !== "unknown") {
    styleBits.push(`${brief.style.pacing} pacing`);
  }
  if (brief.style.visualTone && brief.style.visualTone.length > 0) {
    styleBits.push(brief.style.visualTone.join(", "));
  }
  if (styleBits.length > 0) {
    lines.push(`Mood: ${styleBits.join("; ")}.`);
  }

  // ---- 6. Requested effects (capability-honest) ----
  const split = classifyEffects(
    brief.effects.requestedVisualEffects ?? [],
    brief.effects.requestedAudioEffects ?? []
  );
  const requestedAll = [
    ...(brief.effects.requestedVisualEffects ?? []),
    ...(brief.effects.requestedAudioEffects ?? [])
  ];
  if (requestedAll.length > 0) {
    lines.push(
      `Requested effects: ${requestedAll.map(humanize).join(", ")}.`
    );
  }

  // ---- 7. Text overlays ----
  if (brief.effects.textOverlays && brief.effects.textOverlays.length > 0) {
    lines.push("Requested text overlays:");
    brief.effects.textOverlays.forEach((o, i) => {
      lines.push(`${i + 1}. ${o.text}`);
    });
  }

  // ---- 8. Audio ----
  lines.push(audioLine(brief, split));

  // ---- 9. Avoid ----
  if (brief.content.avoid && brief.content.avoid.length > 0) {
    lines.push(`Avoid: ${brief.content.avoid.join(", ")}.`);
  }

  // ---- 10. Constraints ----
  const constraintBits = constraintLines(brief);
  if (constraintBits.length > 0) {
    lines.push(`Constraints: ${constraintBits.join("; ")}.`);
  }

  // ---- 11. Capability honesty ----
  if (split.unsupported.length > 0 || split.partial.length > 0) {
    lines.push(capabilityHonestyLine(split));
  }

  return lines.join("\n");
}

function audioLine(brief: EditBrief, split: EffectSupportSplit): string {
  const audio = brief.effects.requestedAudioEffects ?? [];
  if (brief.constraints.preserveOriginalAudio === false || audio.includes("mute_original")) {
    return "Audio: mute the original audio (note: muting is not implemented yet, so the original may be preserved).";
  }
  if (audio.includes("background_music") || audio.includes("voiceover") || audio.includes("bass_hit") || audio.includes("whoosh")) {
    return "Audio: keep the original audio. Added music/SFX/voiceover are requests only — they are not mixed yet.";
  }
  void split;
  return "Audio: keep the original audio.";
}

function constraintLines(brief: EditBrief): string[] {
  const out: string[] = [];
  if (brief.constraints.noExtraSources) out.push("do not use another source");
  if (brief.constraints.doNotAskForAnotherClip) out.push("do not ask for another clip");
  if (brief.constraints.userSaidContinuous || brief.output.outputType === "single_continuous") {
    out.push("keep it as one continuous clip");
  }
  if (brief.constraints.noTransitionsBetweenClips && brief.output.outputType === "single_continuous") {
    out.push("do not create transitions inside a single continuous clip");
  }
  if (brief.constraints.mustUseTimelineOnly) out.push("use the existing timeline clips only");
  return out;
}

function capabilityHonestyLine(split: EffectSupportSplit): string {
  const parts: string[] = [];
  if (split.unsupported.length > 0) {
    parts.push(
      `The following requested effects are NOT implemented yet and must be preserved as requests, never claimed as rendered: ${split.unsupported.map(humanize).join(", ")}.`
    );
  }
  if (split.partial.length > 0) {
    parts.push(
      `Partially supported (approximate only): ${split.partial.map(humanize).join(", ")}.`
    );
  }
  if (split.notes.length > 0) {
    parts.push(`Notes: ${split.notes.join("; ")}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------
// Human-facing summary ("Got it — …"). Never echoes raw messy text.
// ---------------------------------------------------------------------

/**
 * A short, friendly confirmation built from the brief (per the spec's
 * human-facing message rules). Never echoes the user's raw text.
 */
export function briefSummaryMessage(brief: EditBrief): string {
  const dur = typeof brief.output.durationSeconds === "number"
    ? `${brief.output.durationSeconds}s `
    : "";
  const fmt =
    brief.output.format === "horizontal"
      ? "horizontal "
      : brief.output.format === "square"
        ? "square "
        : "vertical ";

  const structure =
    brief.output.outputType === "single_continuous"
      ? "continuous clip"
      : brief.output.outputType === "as_is_merge"
        ? "merge"
        : "short";

  const scope =
    brief.sourceScope.type === "all"
      ? "from all uploaded videos"
      : brief.sourceScope.type === "selected"
        ? "from the selected videos"
        : "from the current video";

  const focusBit = brief.content.momentDescription
    ? " of the moment you described"
    : brief.content.focus
      ? ` focused on ${brief.content.focus}`
      : brief.content.genericBestParts
        ? " of the best moments"
        : "";

  const moodBit = brief.style.mood ? `${brief.style.mood} ` : "";

  let msg = `Got it \u2014 I\u2019ll make a ${dur}${fmt}${moodBit}${structure} ${scope}${focusBit}.`;

  // Honest caveat for unsupported requested effects.
  const split = classifyEffects(
    brief.effects.requestedVisualEffects ?? [],
    brief.effects.requestedAudioEffects ?? []
  );
  if (split.unsupported.length > 0) {
    msg += ` Heads up: ${split.unsupported.map(humanize).join(", ")} ${split.unsupported.length === 1 ? "isn\u2019t" : "aren\u2019t"} rendered yet, so I\u2019ll note ${split.unsupported.length === 1 ? "it" : "them"} but can\u2019t apply ${split.unsupported.length === 1 ? "it" : "them"} for now.`;
  }
  return msg;
}

function humanize(id: string): string {
  return id.replace(/_/g, " ");
}
