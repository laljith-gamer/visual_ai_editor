"use client";

import { useMemo } from "react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { mapTransition } from "@/lib/transitions/map";
import { ALL_TRANSITION_TYPES, type TransitionType } from "@/lib/transitions/types";

/**
 * PR 59 — per-boundary transition picker.
 *
 * Shows one chip per boundary in RENDER ORDER (clip i → clip i+1). Each
 * chip surfaces the auto pick + reason and lets the user override it. It is
 * HONEST: when a chosen transition isn't truly rendered (zoom/glitch/etc.)
 * the chip says "Not rendered yet — using <renderable>". Picking "Auto"
 * hands the boundary back to the deterministic offline selector.
 */

interface Choice {
  value: TransitionType | "auto";
  label: string;
}

const CHOICES: Choice[] = [
  { value: "auto", label: "Auto" },
  ...ALL_TRANSITION_TYPES.map((t) => ({
    value: t,
    label: mapTransition(t).label
  }))
];

export function TransitionsBar() {
  const highlights = useEditorStore((s) => s.highlights);
  const boundaryTransitions = useEditorStore((s) => s.boundaryTransitions);
  const updateBoundaryTransition = useEditorStore((s) => s.updateBoundaryTransition);
  const recomputeAutoTransitions = useEditorStore((s) => s.recomputeAutoTransitions);

  // Map boundary index → transition for quick lookup.
  const byIndex = useMemo(() => {
    const m = new Map<number, (typeof boundaryTransitions)[number]>();
    for (const bt of boundaryTransitions) m.set(bt.index, bt);
    return m;
  }, [boundaryTransitions]);

  if (highlights.length < 2) return null;

  const onSelect = (index: number, value: string) => {
    if (value === "auto") {
      updateBoundaryTransition(index, { mode: "auto" });
      recomputeAutoTransitions();
      return;
    }
    updateBoundaryTransition(index, { type: value as TransitionType, mode: "manual" });
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "stretch",
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid color-mix(in srgb, currentColor 12%, transparent)"
      }}
    >
      <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
        Transitions
      </span>
      {Array.from({ length: highlights.length - 1 }, (_, k) => {
        const index = k + 1; // boundary between clip k+1 and k+2 (1-based)
        const bt = byIndex.get(index);
        const type = (bt?.type ?? "cut") as TransitionType;
        const mapped = mapTransition(type);
        const isAuto = bt?.mode !== "manual";
        const value: string = isAuto && bt ? "auto" : type;
        const tooltip = [
          bt?.reason ? `Why: ${bt.reason}` : null,
          !mapped.exact && mapped.note ? mapped.note : null
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <label
            key={index}
            title={tooltip || undefined}
            style={{
              display: "inline-flex",
              flexDirection: "column",
              gap: 2,
              padding: "4px 8px",
              borderRadius: 8,
              border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
              background: "color-mix(in srgb, currentColor 5%, transparent)",
              fontSize: 11,
              minWidth: 92
            }}
          >
            <span className="faint" style={{ fontSize: 10 }}>
              clip {index} → {index + 1}
            </span>
            <select
              value={value}
              onChange={(e) => onSelect(index, e.target.value)}
              style={{
                background: "transparent",
                border: "none",
                font: "inherit",
                fontSize: 12,
                fontWeight: 600,
                color: "inherit",
                cursor: "pointer",
                padding: 0
              }}
            >
              {CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value === "auto" && bt?.mode !== "manual"
                    ? `Auto: ${mapped.label}`
                    : c.label}
                </option>
              ))}
            </select>
            {!mapped.exact && (
              <span className="faint" style={{ fontSize: 10, color: "var(--warning, #E0AF68)" }}>
                → {mapped.render} (mapped)
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
