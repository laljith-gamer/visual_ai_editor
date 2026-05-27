"use client";

import { Compass, Crosshair, HelpCircle } from "lucide-react";
import type { IntentMode } from "@/lib/types";

interface Props {
  mode: IntentMode | null;
}

/**
 * Pill that tells the user which conversational mode the planner picked
 * for the latest turn. Helps make the implicit explicit.
 */
export function ModeBadge({ mode }: Props) {
  if (!mode) return null;
  if (mode === "plan") {
    return (
      <span className="pill accent" title="Multi-clip highlight reel">
        <Compass size={12} /> Plan
      </span>
    );
  }
  if (mode === "moment") {
    return (
      <span className="pill info" title="Single-clip moment retrieval">
        <Crosshair size={12} /> Moment
      </span>
    );
  }
  return (
    <span className="pill warn" title="Waiting on a clarification from you">
      <HelpCircle size={12} /> Clarify
    </span>
  );
}
