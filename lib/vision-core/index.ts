// =====================================================================
// lib/vision-core/index.ts
//
// Public surface for VISION-EDIT-CORE — the offline, deterministic
// reasoning engine that runs PRIMARY, before any cloud LLM call.
//
// Intended call flow (additive; does not replace existing logic):
//
//   import { runVisionCore, gateVisionCore, segmentsToHighlights }
//     from "@/lib/vision-core";
//
//   const output   = runVisionCore(input);          // pure, offline
//   const decision = gateVisionCore(output, {        // confidence gate
//     hasCloudFallback: hasAnyChatProvider()
//   });
//
//   if (decision.useLocal && decision.result) {
//     const clips = segmentsToHighlights(decision.result, { ... });
//     // → feed `clips` into the SAME timeline / render path as today.
//   } else {
//     // → fall through to POST /api/agent (Gemini → Groq), UNCHANGED.
//   }
//
// Everything here is tree-shakeable and free of side effects.
// =====================================================================

export { runVisionCore } from "@/lib/vision-core/engine";

export {
  gateVisionCore,
  type GateContext,
  type GateDecision,
  type GateReason
} from "@/lib/vision-core/gate";

export {
  segmentsToHighlights,
  resultToEditPlan,
  type AdaptToHighlightsOptions,
  type AdaptToPlanOptions
} from "@/lib/vision-core/adapt";

export type {
  VisionCoreInput,
  VisionCoreFrame,
  VisionCoreFrameTags,
  VisionCoreTree,
  VisionCoreVideo,
  VisionCoreMode,
  VisionCoreParams,
  VisionCoreRequest,
  VisionCoreOutput,
  VisionCoreResult,
  VisionCoreError,
  VisionCoreSegment,
  VisionCoreScores,
  VisionCoreSentiment,
  VisionCoreSentimentLabel,
  VisionCoreStats,
  VisionCoreCustomResult
} from "@/lib/vision-core/types";
