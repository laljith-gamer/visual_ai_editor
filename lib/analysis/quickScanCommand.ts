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

// Low-confidence remedy. After a weak result the assistant offers to "run a
// deeper local scan" to raise match confidence. A reply that mentions
// CONFIDENCE (the metric just surfaced) together with an analysis/quality verb
// — "ok analyse for high confidence", "improve confidence", "scan for higher
// confidence", "recheck for better accuracy" — is the user ACCEPTING that
// offer. Route it to a DEEP scan instead of letting the planner treat
// "confidence"/"analys" as content topics. "confidence" (and "accuracy") are
// virtually never a video subject, so this is high-precision.
const CONFIDENCE_METRIC_RE = /\b(confidence|accuracy)\b/i;
const RESCAN_ACTION_RE =
  /\b(analys\w*|analyz\w*|re-?analy\w*|scans?|rescans?|re-?scan\w*|deeper?|improv\w*|increas\w*|rais\w*|boost\w*|higher|high|better|strong\w*|accurate|reliab\w*|re-?check|recheck|verif\w*)\b/i;

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
  // Accepting the "run a deeper local scan" offer, phrased around confidence
  // ("ok analyse for high confidence") → deeper scan, never a content search.
  if (CONFIDENCE_METRIC_RE.test(s) && RESCAN_ACTION_RE.test(s)) {
    return { kind: "deep" };
  }
  return null;
}
