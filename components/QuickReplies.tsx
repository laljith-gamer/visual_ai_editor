"use client";

import type { ClarifyQuestion } from "@/lib/types";
import styles from "./QuickReplies.module.css";

interface Props {
  questions: ClarifyQuestion[];
  /** Called when the user picks a suggestion. Receives the suggestion text. */
  onPick: (suggestion: string, question: ClarifyQuestion) => void;
  /** Disabled while a pipeline turn is in flight. */
  disabled?: boolean;
}

/**
 * Quick-reply chips for clarify mode. Each question renders its prompt
 * and a row of suggestion chips. Tapping a chip sends that text as the
 * user's next message — no typing required on mobile.
 */
export function QuickReplies({ questions, onPick, disabled }: Props) {
  if (questions.length === 0) return null;
  return (
    <div className={styles.host}>
      {questions.map((q) => (
        <div key={q.id} className={styles.question}>
          <p className={styles.prompt}>{q.prompt}</p>
          <div className={styles.row}>
            {q.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className={`btn ${styles.chip}`}
                onClick={() => onPick(s, q)}
                disabled={disabled}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
