// =====================================================================
// Activity log — documented event kinds and their payload shapes.
//
// The `ActivityEvent.kind` field is a free-form string at the type level
// (so adding a new kind doesn't require a type-system migration), but the
// canonical set lives here. Anything not in this list will still be
// recorded; it just won't get a custom icon/summary.
// =====================================================================

/** User-initiated events. */
export const USER_KINDS = [
  "chat.sent",
  "quickreply.picked",
  "clip.moved",
  "clip.resized",
  "clip.removed",
  "clip.nudged",
  "clip.selected",
  "inferred.overridden",
  "video.uploaded",
  "video.removed",
  "render.requested",
  "export.shared",
  "export.downloaded",
  "session.reset",
  "memory.cleared"
] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** AI / pipeline events. */
export const AI_KINDS = [
  "plan.created",
  "plan.refined",
  "mode.classified",
  "frames.sampled",
  "frames.scored",
  "events.detected",
  "temporal.verdict",
  "highlights.built",
  "render.completed",
  "provider.fallback",
  "provider.error",
  "moment.localized"
] as const;
export type AiKind = (typeof AI_KINDS)[number];

/** System / operational events. */
export const SYSTEM_KINDS = [
  "cache.hit",
  "cache.miss",
  "ratelimit.hit",
  "quota.warning",
  "circuit.opened",
  "circuit.closed",
  "error.network",
  "error.unhandled"
] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

export type AnyKind = UserKind | AiKind | SystemKind;

// ---------------------------------------------------------------------
// Payload shapes for documentation. These are intentionally NOT applied
// to the `ActivityEvent.payload` type so that ad-hoc kinds can be added
// without ceremony.
// ---------------------------------------------------------------------

export interface ChatSentPayload { text: string; mode?: string }
export interface QuickReplyPickedPayload { questionId: string; suggestion: string }
export interface ClipMovedPayload { clipId: string; from: number; to: number }
export interface ClipResizedPayload { clipId: string; edge: "left" | "right"; from: number; to: number }
export interface ClipRemovedPayload { clipId: string; start: number; end: number }
export interface VideoUploadedPayload { name: string; sizeBytes: number; durationSeconds: number; width: number; height: number }
export interface PlanCreatedPayload {
  mode: "plan" | "moment";
  scenarios: Array<{ id: string; prompt: string }>;
  targetShortSeconds: number;
  format: string;
  transition: string;
  selectionStrategy: string;
  inferred: Array<{ field: string; value: unknown; reason: string }>;
  warnings: string[];
}
export interface FramesSampledPayload { count: number; everySeconds: number; widthPx: number }
export interface FramesScoredPayload {
  count: number;
  tier: "siglip-local" | "cloud";
  cacheHit: boolean;
  tookMs: number;
}
export interface EventsDetectedPayload {
  candidateCount: number;
  thresholdValue: number;
  meanScore: number;
}
export interface TemporalVerdictPayload {
  start: number;
  end: number;
  keepScore: number;
  reason: string;
}
export interface HighlightsBuiltPayload {
  count: number;
  totalSeconds: number;
}
export interface RenderCompletedPayload {
  format: string;
  outputBytes: number;
  tookMs: number;
}
export interface ProviderFallbackPayload { from: string; to: string; reason: string }
export interface RatelimitHitPayload {
  layer: "ip" | "session" | "global" | "circuit" | "punish";
  scope: string;
  retryAfterSeconds?: number;
}
export interface QuotaWarningPayload {
  layer: "global";
  usage: number;
  limit: number;
  fraction: number;
}
export interface CircuitEventPayload { provider: string; failures?: number; openMs?: number }
