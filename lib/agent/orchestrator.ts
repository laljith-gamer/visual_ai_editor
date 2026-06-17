/**
 * Phase 4 — command execution orchestrator.
 *
 * The brain of the agentic layer. Given a user turn + a context snapshot
 * + the agent memory store, it:
 *
 *   1. Observes the turn into memory (durable facts).
 *   2. Detects reinforcement ("not this", "more like clip 2", …).
 *   3. Parses a structured EditCommand (deterministic first).
 *   4. Resolves source / clip / time / placement / concept references,
 *      using memory for anaphora and inference.
 *   5. Applies the confidence policy (execute / note / clarify).
 *   6. Returns an AgentDecision the client runner applies to the store.
 *
 * It is React-free and (aside from async OCR/transcript concept lookup)
 * pure, so it can be exercised from tests / the dev tester. It NEVER
 * mutates the timeline itself — it emits resolved operations. On anything
 * it can't confidently handle it returns `{ kind: "fallthrough" }` so the
 * existing quickMatch gate + cloud planner stay the fallback.
 */

import type { Transcript } from "@/lib/audio/types";
import type { AgentCommandContext, EditCommand } from "@/lib/intent/command";
import { parseEditCommand } from "@/lib/intent/editCommandParser";
import { resolveSource } from "@/lib/intent/sourceResolver";
import { resolveClip } from "@/lib/intent/clipResolver";
import { resolvePlacement } from "@/lib/intent/placementResolver";
import { resolveTimeRange } from "@/lib/intent/timeRangeParser";
import { observeUserMessage } from "@/lib/agent-memory/observer";
import { combineConfidence, decideAction } from "@/lib/agent-memory/policy";
import type { AgentMemoryStore } from "@/lib/agent-memory/store";
import { resolveConcept } from "./conceptResolver";
import { detectReinforcement } from "./reinforcement";
import type { NewClipInput } from "@/lib/timeline/operations";
import { AGENT_GUARDRAILS } from "@/lib/config";

// ---------------------------------------------------------------------
// Resolved operations the client runner applies to the store
// ---------------------------------------------------------------------

export type ResolvedOp =
  | { type: "add_clips"; sourceId: string; clips: NewClipInput[]; placementIndex?: number; allowOverlap: boolean }
  | { type: "add_clip_ref"; clipId: string; placementIndex: number }
  | { type: "move_clip"; clipId: string; placementIndex: number }
  | { type: "remove_clip"; clipId: string }
  | { type: "replace_clip"; targetId: string; replacement: NewClipInput }
  | { type: "extend_clip"; clipId: string; beforeSeconds?: number; afterSeconds?: number; sourceDuration?: number }
  | { type: "trim_clip"; clipId: string; start?: number; end?: number }
  | { type: "render" };

export type AgentDecision =
  | {
      kind: "operations";
      ops: ResolvedOp[];
      /** Assumptions surfaced to the user (never silent). */
      assumptions: string[];
      /** Confirmation message for chat. */
      message: string;
      /** Evidence label for the primary action (Phase 8 UI). */
      evidence?: string;
      confidence: number;
    }
  | {
      kind: "clarify";
      message: string;
      suggestions: string[];
    }
  | {
      kind: "reinforcement_only";
      message: string;
      /** True when the user wants a fresh search informed by feedback. */
      wantsResearch: boolean;
    }
  | {
      kind: "needs_visual";
      /** Resolved source(s) to scan. */
      sourceIds: string[];
      concept: string;
      placementIndex?: number;
      assumptions: string[];
      reason: string;
    }
  | { kind: "fallthrough" };

export interface OrchestrateArgs {
  text: string;
  ctx: AgentCommandContext;
  memory: AgentMemoryStore;
  /** Look up a local transcript by source id (runner maps hash→id). */
  getTranscript?: (sourceId: string) => Transcript | null | undefined;
}

export async function orchestrate(args: OrchestrateArgs): Promise<AgentDecision> {
  const { text, ctx, memory } = args;

  // 1. Observe durable facts.
  observeUserMessage(memory, text);

  // 2. Parse a structured command first.
  const parsed = parseEditCommand(text);

  // 3. Reinforcement (may co-occur with a command, e.g. "remove this,
  //    more like clip 2"). When there's NO structured command, a pure
  //    reinforcement turn updates memory and (optionally) asks the
  //    caller to re-search.
  const reinforce = detectReinforcement(text, ctx);
  if (reinforce.isReinforcement) {
    memory.applyReinforcement(reinforce.patch);
    if (reinforce.rejectSelected && ctx.selectedClipId) {
      const sel = ctx.highlights.find((h) => h.id === ctx.selectedClipId);
      memory.applyReinforcement({
        rejectedClipIds: [ctx.selectedClipId],
        rejectedRanges: sel ? [{ sourceId: sel.sourceId, start: sel.start, end: sel.end }] : []
      });
    }
    if (reinforce.likeSelected && ctx.selectedClipId) {
      const sel = ctx.highlights.find((h) => h.id === ctx.selectedClipId);
      memory.applyReinforcement({
        likedClipIds: [ctx.selectedClipId],
        likedRanges: sel ? [{ sourceId: sel.sourceId, start: sel.start, end: sel.end }] : []
      });
    }
    if (!parsed.command) {
      return { kind: "reinforcement_only", message: reinforce.message, wantsResearch: reinforce.wantsResearch };
    }
  }

  if (parsed.needsClarification) {
    return { kind: "clarify", message: parsed.clarification ?? "Could you clarify that?", suggestions: parsed.suggestions ?? [] };
  }
  if (!parsed.command) {
    return { kind: "fallthrough" };
  }

  return resolveCommand(parsed.command, parsed.confidence, args);
}

// ---------------------------------------------------------------------
// Per-command resolution
// ---------------------------------------------------------------------

async function resolveCommand(
  command: EditCommand,
  parseConfidence: number,
  args: OrchestrateArgs
): Promise<AgentDecision> {
  const { ctx, memory } = args;
  const assumptions: string[] = [];

  const durationOf = (sourceId: string): number =>
    ctx.sources.find((s) => s.id === sourceId)?.duration ?? 0;

  switch (command.op) {
    case "render":
      return { kind: "operations", ops: [{ type: "render" }], assumptions, message: "Rendering the timeline now.", confidence: parseConfidence };

    case "add_range": {
      const src = resolveSource(command.sourceRef ?? null, ctx);
      if (src.needsClarification) return clarify(src.clarification, src.suggestions);
      assumptions.push(...src.assumptions);
      const sourceId = src.sourceIds[0];
      const dur = durationOf(sourceId);

      let anchor: { start: number; end: number } | null = null;
      if (command.range.kind === "relative_to_clip") {
        const a = resolveClip(command.range.anchor, ctx);
        if (a.needsClarification || !a.bounds) return clarify(a.clarification ?? "Which clip?", []);
        anchor = { start: a.bounds.start, end: a.bounds.end };
        assumptions.push(...a.assumptions);
      }

      const resolved = resolveTimeRange({ spec: command.range, durationSeconds: dur, anchorClip: anchor });
      if (!resolved) return clarify("That range doesn't fit inside the video. Try different times.", []);

      const placement = resolvePlacement(command.placement, ctx);
      if (placement.needsClarification) return clarify(placement.clarification, []);
      assumptions.push(...placement.assumptions);

      const evidence = resolved.exact ? "exact range" : "time range";
      const clip: NewClipInput = {
        sourceId,
        start: resolved.start,
        end: resolved.end,
        reason: titleCase(command.range.spoken),
        label: command.range.spoken,
        score: 1,
        confidence: "high"
      };
      memory.setFlow({ activeSourceId: sourceId });
      return finishOps(
        [{ type: "add_clips", sourceId, clips: [clip], placementIndex: placement.index, allowOverlap: resolved.exact }],
        assumptions,
        `Added ${fmt(resolved.start)}\u2013${fmt(resolved.end)} from "${nameOf(ctx, sourceId)}".`,
        combineConfidence([parseConfidence, src.confidence, placement.confidence]),
        evidence
      );
    }

    case "add_concept": {
      const src = resolveSource(command.sourceRef ?? null, ctx);
      if (src.needsClarification) return clarify(src.clarification, src.suggestions);
      assumptions.push(...src.assumptions);
      const sourceId = src.sourceIds[0];
      const dur = durationOf(sourceId);
      const placement = resolvePlacement(command.placement, ctx);
      if (placement.needsClarification) return clarify(placement.clarification, []);
      assumptions.push(...placement.assumptions);

      memory.setFlow({ activeSourceId: sourceId, lastMentionedConcept: command.concept });

      const concept = await resolveConcept({
        concept: command.concept,
        sourceId,
        durationSeconds: dur,
        transcript: args.getTranscript?.(sourceId) ?? null
      });

      if (concept.matches.length > 0) {
        const clips: NewClipInput[] = concept.matches
          .slice(0, AGENT_GUARDRAILS.maxConceptMatchesPerTurn)
          .map((m) => ({
            sourceId: m.sourceId,
            start: m.start,
            end: m.end,
            reason: m.reason,
            label: command.concept,
            score: m.confidence,
            confidence: m.confidence >= 0.75 ? "high" : "medium"
          }));
        const ev = concept.matches[0].evidenceType;
        return finishOps(
          [{ type: "add_clips", sourceId, clips, placementIndex: placement.index, allowOverlap: true }],
          assumptions,
          `${concept.reason} Added ${clips.length} clip${clips.length === 1 ? "" : "s"}.`,
          combineConfidence([parseConfidence, src.confidence]),
          evidenceLabel(ev)
        );
      }

      // No deterministic match → hand off to the visual pipeline.
      return {
        kind: "needs_visual",
        sourceIds: src.sourceIds,
        concept: command.concept,
        placementIndex: placement.index,
        assumptions,
        reason: concept.reason
      };
    }

    case "add_clip_ref": {
      const r = resolveClip(command.clipRef, ctx);
      if (r.needsClarification || !r.clipId) return clarify(r.clarification ?? "Which clip?", []);
      const placement = resolvePlacement(command.placement, ctx);
      if (placement.needsClarification) return clarify(placement.clarification, []);
      return finishOps(
        [{ type: "add_clip_ref", clipId: r.clipId, placementIndex: placement.index }],
        [...r.assumptions, ...placement.assumptions],
        "Duplicated that clip into the new position.",
        combineConfidence([parseConfidence, r.confidence, placement.confidence])
      );
    }

    case "move_clip": {
      const r = resolveClip(command.clipRef, ctx);
      if (r.needsClarification || !r.clipId) return clarify(r.clarification ?? "Which clip should I move?", []);
      const placement = resolvePlacement(command.placement, ctx);
      if (placement.needsClarification) return clarify(placement.clarification, []);
      const note =
        ctx.highlights.length > 1
          ? "Note: the timeline may re-group clips by source on the next AI run."
          : undefined;
      const dec = finishOps(
        [{ type: "move_clip", clipId: r.clipId, placementIndex: placement.index }],
        [...r.assumptions, ...placement.assumptions],
        `Moved the clip.${note ? ` ${note}` : ""}`,
        combineConfidence([parseConfidence, r.confidence, placement.confidence])
      );
      return dec;
    }

    case "remove_clip": {
      const r = resolveClip(command.clipRef, ctx);
      if (r.needsClarification || !r.clipId) return clarify(r.clarification ?? "Which clip should I remove?", []);
      // Removing is also a reject signal.
      if (r.bounds) memory.applyReinforcement({ rejectedClipIds: [r.clipId], rejectedRanges: [{ sourceId: r.bounds.sourceId, start: r.bounds.start, end: r.bounds.end }] });
      return finishOps(
        [{ type: "remove_clip", clipId: r.clipId }],
        r.assumptions,
        "Removed that clip. You can say 'undo' to bring it back.",
        combineConfidence([parseConfidence, r.confidence])
      );
    }

    case "replace_clip": {
      const target = resolveClip(command.target, ctx);
      if (target.needsClarification || !target.clipId || !target.bounds) return clarify(target.clarification ?? "Which clip should I replace?", []);
      const repl = command.replacement;
      const replSrcId = repl.sourceRef
        ? resolveSource(repl.sourceRef, ctx).sourceIds[0]
        : target.bounds.sourceId ?? ctx.activeSourceId ?? ctx.sources[0]?.id;
      if (!replSrcId) return clarify("Which video should the replacement come from?", []);
      const dur = durationOf(replSrcId);

      if (repl.kind === "range") {
        const resolved = resolveTimeRange({ spec: repl.range, durationSeconds: dur });
        if (!resolved) return clarify("That replacement range doesn't fit the video.", []);
        const replacement: NewClipInput = { sourceId: replSrcId, start: resolved.start, end: resolved.end, reason: `Replaced with ${repl.range.spoken}`, label: repl.range.spoken, score: 1 };
        return finishOps([{ type: "replace_clip", targetId: target.clipId, replacement }], target.assumptions, "Replaced the clip with the range you gave.", combineConfidence([parseConfidence, target.confidence]), "exact range");
      }
      // concept replacement
      const concept = await resolveConcept({ concept: repl.concept, sourceId: replSrcId, durationSeconds: dur, transcript: args.getTranscript?.(replSrcId) ?? null });
      if (concept.matches.length > 0) {
        const m = concept.matches[0];
        const replacement: NewClipInput = { sourceId: m.sourceId, start: m.start, end: m.end, reason: m.reason, label: repl.concept, score: m.confidence };
        return finishOps([{ type: "replace_clip", targetId: target.clipId, replacement }], target.assumptions, `Replaced the clip. ${concept.reason}`, combineConfidence([parseConfidence, target.confidence]), evidenceLabel(m.evidenceType));
      }
      // Need vision to find the replacement concept.
      return { kind: "needs_visual", sourceIds: [replSrcId], concept: repl.concept, assumptions: target.assumptions, reason: `I'll scan "${nameOf(ctx, replSrcId)}" to find that, then replace the clip.` };
    }

    case "extend_clip": {
      const r = resolveClip(command.clipRef, ctx);
      if (r.needsClarification || !r.clipId) return clarify(r.clarification ?? "Which clip should I extend?", []);
      const before = command.beforeSeconds;
      const after = command.afterSeconds ?? (before == null ? AGENT_GUARDRAILS.defaultExtendSeconds : undefined);
      const srcDur = r.bounds?.sourceId ? durationOf(r.bounds.sourceId) : undefined;
      return finishOps(
        [{ type: "extend_clip", clipId: r.clipId, beforeSeconds: before, afterSeconds: after, sourceDuration: srcDur }],
        r.assumptions,
        "Extended the clip.",
        combineConfidence([parseConfidence, r.confidence])
      );
    }

    case "trim_clip": {
      const r = resolveClip(command.clipRef, ctx);
      if (r.needsClarification || !r.clipId) return clarify(r.clarification ?? "Which clip should I trim?", []);
      return finishOps(
        [{ type: "trim_clip", clipId: r.clipId, start: command.start, end: command.end }],
        r.assumptions,
        "Trimmed the clip.",
        combineConfidence([parseConfidence, r.confidence])
      );
    }

    case "reorder": {
      const r = resolveClip(command.clipRef, ctx);
      if (r.needsClarification || !r.clipId) return clarify(r.clarification ?? "Which clip?", []);
      const placement = resolvePlacement(command.placement, ctx);
      if (placement.needsClarification) return clarify(placement.clarification, []);
      return finishOps([{ type: "move_clip", clipId: r.clipId, placementIndex: placement.index }], [...r.assumptions, ...placement.assumptions], "Reordered the timeline.", combineConfidence([parseConfidence, r.confidence, placement.confidence]));
    }

    default:
      return { kind: "fallthrough" };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function finishOps(
  ops: ResolvedOp[],
  assumptions: string[],
  message: string,
  confidence: number,
  evidence?: string
): AgentDecision {
  // Apply the confidence policy: low confidence → clarify instead of act.
  const decision = decideAction(confidence);
  if (decision === "clarify") {
    return { kind: "clarify", message: `${message} — but I'm not fully sure. Want me to go ahead?`, suggestions: ["Yes, do it", "No, let me rephrase"] };
  }
  // For medium confidence we still execute but the assumptions are
  // surfaced (already collected). High confidence executes cleanly.
  return { kind: "operations", ops, assumptions, message, evidence, confidence };
}

function clarify(message: string | undefined, suggestions: string[] | undefined): AgentDecision {
  return { kind: "clarify", message: message ?? "Could you clarify that?", suggestions: suggestions ?? [] };
}

function nameOf(ctx: AgentCommandContext, id: string): string {
  return ctx.sources.find((s) => s.id === id)?.name ?? "that video";
}

function evidenceLabel(ev: string): string {
  switch (ev) {
    case "range":
      return "exact range";
    case "transcript":
      return "transcript match";
    case "ocr":
      return "on-screen text";
    case "video-memory":
      return "video memory";
    case "vision":
      return "visual match";
    case "motion":
      return "motion/saliency";
    default:
      return ev;
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
