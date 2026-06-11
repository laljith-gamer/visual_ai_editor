"use client";

import { useMemo } from "react";
import { Clock, Lightbulb, MousePointerClick, Play, Sparkles } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { logUser } from "@/lib/log/recorders";
import { normalizeBriefingFollowUps } from "@/lib/briefing/followups";
import type { BestPart, BriefingFollowUp } from "@/lib/types";
import styles from "./BriefingCard.module.css";

interface Props {
  bestParts: BestPart[];
  /** v1.8.1 — raw follow-ups: plain strings (legacy / current briefing
   *  API) and/or structured actions. Normalized to structured actions
   *  for rendering. */
  followUps: Array<string | BriefingFollowUp>;
  /** v1.8.1 — structured action callback. Strings are upgraded to actions
   *  before this fires, so the click always carries intent. */
  onPickFollowUp: (action: BriefingFollowUp) => void;
  /** Source the briefing was about — grounds plan_topic / extract_range
   *  actions when normalizing legacy string follow-ups. */
  sourceId?: string;
  disabled?: boolean;
}

/**
 * v1.7.0 — Renders the structured briefing the planner returns when
 * the user wants a description of the video instead of a render.
 *
 * Three regions:
 *   1. Best parts list — clickable items that scrub the preview to
 *      that timestamp on the active source. Each shows a rank, the
 *      time range, the label, and the one-sentence "why".
 *   2. Follow-up actions — pill buttons. v1.8.1: each follow-up is a
 *      structured `BriefingFollowUp` (promote / plan_topic /
 *      extract_range / chat). Legacy string follow-ups are normalized
 *      into actions before rendering, so a click dispatches INTENT, not
 *      raw text — only `chat` actions still go through the chat pipe.
 *   3. A subtle hint reminding the user that nothing was rendered.
 *
 * The card NEVER mutates the timeline on its own — clicking a best
 * part only scrubs the preview. Follow-up actions are dispatched to the
 * caller (AssistantPanel → editor page), which runs the deterministic
 * path (or chat) for each.
 */
export function BriefingCard({
  bestParts,
  followUps,
  onPickFollowUp,
  sourceId,
  disabled
}: Props) {
  const sessionId = useEditorStore((s) => s.sessionId);
  const setActiveSource = useEditorStore((s) => s.setActiveSource);
  const sources = useEditorStore((s) => s.sources);

  // v1.8.1 — Upgrade raw follow-ups (strings and/or structured) into typed
  // actions once per change. Stable ids keep React keys steady; the click
  // handler then dispatches a structured action instead of raw text.
  const actions = useMemo(
    () => normalizeBriefingFollowUps(followUps, { sourceId }),
    [followUps, sourceId]
  );

  function handleScrubTo(part: BestPart) {
    // Pick the right source first when the briefing pinned one.
    if (part.sourceId) {
      const exists = sources.some((s) => s.id === part.sourceId);
      if (exists) setActiveSource(part.sourceId);
    }
    // Defer the seek to the next frame so the source switch (which
    // re-mounts the <video class="preview">) has a chance to render
    // before we touch its currentTime. PreviewToolbar uses the same
    // querySelector handle, so we follow the established pattern.
    requestAnimationFrame(() => {
      const v = document.querySelector(
        "video.preview"
      ) as HTMLVideoElement | null;
      if (!v) return;
      const apply = () => {
        try {
          v.currentTime = Math.max(0, part.startSeconds);
          v.play().catch(() => {});
        } catch {
          // Some browsers throw when readyState < HAVE_METADATA.
          // The loadedmetadata listener below catches that case.
        }
      };
      if (v.readyState >= 1) {
        apply();
      } else {
        v.addEventListener("loadedmetadata", apply, { once: true });
      }
    });
    logUser({
      sessionId,
      kind: "briefing.scrub",
      payload: {
        partId: part.id,
        label: part.label,
        startSeconds: part.startSeconds,
        endSeconds: part.endSeconds
      },
      summary: `Scrubbed to "${part.label}" at ${formatT(part.startSeconds)}`
    });
  }

  function handleFollowUp(action: BriefingFollowUp) {
    if (disabled) return;
    onPickFollowUp(action);
  }

  if (bestParts.length === 0 && actions.length === 0) return null;

  return (
    <div className={styles.card} role="group" aria-label="Smart summary">
      {bestParts.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionIcon}>
              <Sparkles size={11} />
            </span>
            <span className={styles.sectionLabel}>Best parts</span>
            <span className={styles.sectionCount}>{bestParts.length}</span>
          </div>
          <ul className={styles.list}>
            {bestParts.map((p, i) => (
              <li key={p.id} className={styles.item}>
                <button
                  type="button"
                  className={styles.itemBody}
                  onClick={() => handleScrubTo(p)}
                  title={`Jump preview to ${formatT(p.startSeconds)}`}
                >
                  <span className={styles.rank} aria-hidden>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className={styles.itemMain}>
                    <span className={styles.itemTitle}>{p.label}</span>
                    <span className={styles.itemMeta}>
                      <Clock size={10} aria-hidden />
                      <span className="mono">
                        {formatT(p.startSeconds)} \u2013 {formatT(p.endSeconds)}
                      </span>
                      <span className={styles.dotSep} aria-hidden />
                      <span>{(p.endSeconds - p.startSeconds).toFixed(1)}s</span>
                    </span>
                    <span className={styles.itemWhy}>{p.why}</span>
                  </span>
                  <span className={styles.itemPlay} aria-hidden>
                    <Play size={12} strokeWidth={2.5} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {actions.length > 0 && (
        <div className={styles.followUps}>
          <span className={styles.followLabel}>
            <Lightbulb size={11} aria-hidden />
            What next?
          </span>
          <div className={styles.followRow}>
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={styles.followBtn}
                onClick={() => handleFollowUp(action)}
                disabled={disabled}
              >
                <MousePointerClick size={11} aria-hidden />
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className={styles.foot}>
        Nothing was rendered \u2014 this is just an overview. Tap a moment
        to scrub the preview.
      </p>
    </div>
  );
}

function formatT(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
