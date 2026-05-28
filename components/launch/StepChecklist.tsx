"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import styles from "./StepChecklist.module.css";

export type StepStatus = "pending" | "active" | "done" | "error";

export interface ChecklistStep {
  id: string;
  label: string;
  detail?: string;
  status: StepStatus;
}

interface Props {
  steps: ChecklistStep[];
}

/**
 * Vertical checklist used on the /launch page. Each step is one of
 * pending → active → done. The active step shows a spinner; done
 * steps tick in with a quick scale animation. Error states surface
 * with a red rim so the user notices something stalled.
 */
export function StepChecklist({ steps }: Props) {
  return (
    <ol className={styles.list}>
      {steps.map((step) => (
        <li
          key={step.id}
          className={`${styles.row} ${styles[step.status]}`}
          aria-current={step.status === "active" ? "step" : undefined}
        >
          <span className={styles.iconWrap} aria-hidden>
            {step.status === "done" ? (
              <Check size={14} strokeWidth={3} />
            ) : step.status === "active" ? (
              <Loader2 size={14} className={styles.spin} />
            ) : step.status === "error" ? (
              <Circle size={14} />
            ) : (
              <Circle size={14} />
            )}
          </span>
          <span className={styles.body}>
            <span className={styles.label}>{step.label}</span>
            {step.detail && (
              <span className={styles.detail}>{step.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
