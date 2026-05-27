"use client";

import { Play, Pencil } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import styles from "./PlanPreview.module.css";

interface Props {
  /** Called when the user confirms the plan and wants the pipeline to run. */
  onRun: () => void;
  /** Optional callback fired when the user clicks "Adjust" — typically to focus the chat composer. */
  onAdjust?: () => void;
  disabled?: boolean;
}

/**
 * Plan-first-then-execute confirmation card. Shown when the planner has
 * produced a plan but the pipeline has not yet been kicked off. Renders
 * the key plan parameters as chips so the user can sanity-check before
 * paying for the expensive frame analysis.
 *
 * Hidden when there's no plan, or when `pendingExecution` is false.
 */
export function PlanPreview({ onRun, onAdjust, disabled }: Props) {
  const plan = useEditorStore((s) => s.plan);
  const pending = useEditorStore((s) => s.pendingExecution);
  const hasVideo = useEditorStore((s) => Boolean(s.videoBlob));
  const mode = useEditorStore((s) => s.mode);

  if (!plan || !pending) return null;

  const isMoment = mode === "moment";

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.tag}>{isMoment ? "Moment ready" : "Plan ready"}</span>
        <span className="faint">
          {plan.targetShortSeconds}s · {plan.format} · {plan.transition} · {plan.selectionStrategy}
        </span>
      </div>

      <div className={styles.section}>
        <p className={styles.sectionLabel}>Looking for</p>
        <div className={styles.chipRow}>
          {plan.scenarios.map((s) => (
            <span key={s.id} className={`pill accent ${styles.chip}`} title={s.prompt}>
              {s.prompt}
            </span>
          ))}
        </div>
      </div>

      {plan.avoid.length > 0 && (
        <div className={styles.section}>
          <p className={styles.sectionLabel}>Avoiding</p>
          <div className={styles.chipRow}>
            {plan.avoid.map((a) => (
              <span key={a} className={`pill warn ${styles.chip}`}>
                {a}
              </span>
            ))}
          </div>
        </div>
      )}

      {plan.rationale && (
        <p className={`muted ${styles.rationale}`}>{plan.rationale}</p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className="btn"
          onClick={onAdjust}
          disabled={disabled}
        >
          <Pencil size={14} /> Adjust
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn primary"
          onClick={onRun}
          disabled={disabled || !hasVideo}
          title={!hasVideo ? "Upload a video first" : undefined}
        >
          <Play size={14} />
          {hasVideo ? "Run analysis" : "Upload a video to run"}
        </button>
      </div>
    </div>
  );
}
