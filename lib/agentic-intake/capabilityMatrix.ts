// =====================================================================
// lib/agentic-intake/capabilityMatrix.ts
//
// HONEST description of what the editor can actually do TODAY. The
// agentic intake layer uses this so the assistant never claims an effect
// it cannot render. A requested-but-unsupported effect is preserved in
// the EditBrief (and surfaced to the planner as a *request* for the
// future effect system) but the UI/compiled prompt must say plainly that
// it is not yet rendered.
//
// Source of truth for "supported": the real render path
// (lib/pipeline/renderFilters.ts + lib/pipeline/render.worker.ts) and the
// existing intent paths (extract / highlights / compose). When a new
// renderer ships (Phase 3), flip the relevant entry here — nothing else
// in the intake layer needs to change.
//
// Pure module: no imports, no React, no API.
// =====================================================================

import type { VisualEffect, AudioEffect } from "./editBrief";

export type CapabilityStatus = "supported" | "partial" | "unsupported";

export interface CapabilityInfo {
  status: CapabilityStatus;
  /** Honest note shown to the user / folded into the compiled prompt. */
  note?: string;
}

/**
 * Capability keys are stable internal ids. Effect enums map onto these
 * via EFFECT_CAPABILITY below.
 */
export const CAPABILITY_MATRIX: Record<string, CapabilityInfo> = {
  // ---- output framing (real: scale + crop/pad in renderFilters) -------
  vertical_output: { status: "supported" },
  horizontal_output: { status: "supported" },
  square_output: { status: "supported" },

  // ---- structural editing --------------------------------------------
  trim_extract: { status: "supported" },
  highlight_reel: { status: "supported" },
  continuous_clip: { status: "supported" },
  specific_moment: { status: "supported" },
  merge_sources: { status: "supported" },
  compose_montage: { status: "supported" },

  // ---- transitions (real: fade dip; crossfade maps down) --------------
  fade: { status: "supported" },
  crossfade: {
    status: "partial",
    note: "rendered as a fade dip at the cut; a true overlap crossfade is not implemented yet"
  },

  // ---- audio ----------------------------------------------------------
  keep_original_audio: { status: "supported" },
  lower_original_audio: {
    status: "unsupported",
    note: "per-clip audio ducking is not implemented yet"
  },
  mute_original_audio: {
    status: "unsupported",
    note: "muting the original track is not implemented yet"
  },
  audio_sfx: {
    status: "unsupported",
    note: "added SFX / music / voiceover mixing is not implemented yet"
  },

  // ---- visual effects (no effect renderer yet) ------------------------
  slow_zoom: { status: "unsupported", note: "the Ken-Burns / zoom effect renderer is not built yet" },
  speed_change: { status: "unsupported", note: "speed re-timing is not implemented yet" },
  speed_ramp: { status: "unsupported", note: "speed ramping is not implemented yet" },
  color_grade: { status: "unsupported", note: "color grading is not implemented yet" },
  camera_shake: { status: "unsupported", note: "camera shake is not implemented yet" },
  letterbox: { status: "unsupported", note: "letterbox bars are not implemented yet" },
  text_overlay: { status: "unsupported", note: "on-screen text overlays are not rendered yet" },
  captions: { status: "unsupported", note: "burned-in captions are not rendered yet" },
  blur: { status: "unsupported", note: "blur effects are not implemented yet" },
  crop_reframe: {
    status: "partial",
    note: "automatic crop to the chosen aspect ratio is applied; manual reframing/keyframed crop is not implemented yet"
  }
};

/** Map a brief's VisualEffect enum onto a capability key. */
const VISUAL_EFFECT_KEY: Record<VisualEffect, string> = {
  slow_zoom: "slow_zoom",
  speed_change: "speed_change",
  speed_ramp: "speed_ramp",
  color_grade: "color_grade",
  camera_shake: "camera_shake",
  letterbox: "letterbox",
  text_overlay: "text_overlay",
  captions: "captions",
  blur: "blur",
  crop_reframe: "crop_reframe"
};

/** Map a brief's AudioEffect enum onto a capability key. */
const AUDIO_EFFECT_KEY: Record<AudioEffect, string> = {
  keep_original: "keep_original_audio",
  lower_original: "lower_original_audio",
  mute_original: "mute_original_audio",
  bass_hit: "audio_sfx",
  whoosh: "audio_sfx",
  background_music: "audio_sfx",
  voiceover: "audio_sfx"
};

export function capabilityOf(key: string): CapabilityInfo {
  return CAPABILITY_MATRIX[key] ?? { status: "unsupported" };
}

export function visualEffectStatus(effect: VisualEffect): CapabilityInfo {
  return capabilityOf(VISUAL_EFFECT_KEY[effect]);
}

export function audioEffectStatus(effect: AudioEffect): CapabilityInfo {
  return capabilityOf(AUDIO_EFFECT_KEY[effect]);
}

export interface EffectSupportSplit {
  supported: string[];
  partial: string[];
  unsupported: string[];
  /** Honest, human-readable notes for partial/unsupported items. */
  notes: string[];
}

/**
 * Classify a list of requested effects (visual + audio) by support level.
 * The intake layer uses this to (a) keep supported requests, (b) preserve
 * unsupported ones as *future requests* in the compiled prompt, and (c)
 * surface an honest note so we never claim an effect was rendered.
 */
export function classifyEffects(
  visual: VisualEffect[] = [],
  audio: AudioEffect[] = []
): EffectSupportSplit {
  const split: EffectSupportSplit = {
    supported: [],
    partial: [],
    unsupported: [],
    notes: []
  };
  const seenNote = new Set<string>();

  const add = (label: string, info: CapabilityInfo) => {
    if (info.status === "supported") split.supported.push(label);
    else if (info.status === "partial") split.partial.push(label);
    else split.unsupported.push(label);
    if (info.note && !seenNote.has(info.note)) {
      seenNote.add(info.note);
      split.notes.push(`${humanize(label)}: ${info.note}`);
    }
  };

  for (const e of visual) add(e, visualEffectStatus(e));
  for (const e of audio) add(e, audioEffectStatus(e));
  return split;
}

function humanize(id: string): string {
  return id.replace(/_/g, " ");
}
