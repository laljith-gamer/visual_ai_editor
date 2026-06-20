// =====================================================================
// lib/analysis/quickScanCommand.ts
//
// PURE detector for the explicit "scan this video" command (the describe
// responder's "Run a quick local scan" / "Run a deeper local scan" chips,
// or the user typing it). It must run BEFORE the planner so the chip
// actually triggers a bounded LOCAL scan instead of being treated as a
// content topic. Anchored matching: it only fires on a clear scan command,
// never on "scan for the part where he scores".
//
// PURE: no imports. Unit-tested.
// =====================================================================

export type QuickScanCommandKind = "quick" | "deep";

export interface QuickScanCommand {
  kind: QuickScanCommandKind;
}

const QUICK =
  /^\s*(?:please\s+)?(?:run\s+(?:a\s+)?)?(?:quick\s+(?:local\s+)?scan|local\s+scan|scan\s+(?:this\s+|the\s+)?video|scan\s+it|do\s+a\s+(?:quick\s+)?(?:local\s+)?scan)\s*[.!]?\s*$/i;

const DEEP =
  /^\s*(?:please\s+)?(?:run\s+(?:a\s+)?)?(?:deeper?\s+(?:local\s+)?scan|scan\s+(?:it\s+)?deeper|deep\s+(?:local\s+)?scan|more\s+(?:thorough|detailed)\s+scan)\s*[.!]?\s*$/i;

/**
 * Detect an explicit local-scan command. Returns the scan depth, or null
 * when the text isn't a scan command (so the caller falls through to the
 * normal planner path).
 */
export function detectQuickScanCommand(text: string): QuickScanCommand | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  if (DEEP.test(s)) return { kind: "deep" };
  if (QUICK.test(s)) return { kind: "quick" };
  return null;
}
