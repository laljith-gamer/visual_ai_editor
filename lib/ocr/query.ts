/**
 * Phase 6 — OCR query (currently UNAVAILABLE by design).
 *
 * No OCR engine is registered yet, so `queryOnScreenText` returns
 * `available: false` with a clear status. The agent uses this to respond
 * honestly to "the screen where it says X" requests and fall back to
 * transcript / visual search instead of fabricating a result.
 *
 * TODO (future, gated on a bundle-size review):
 *   - Add an in-browser OCR engine (Tesseract.js or a transformers.js
 *     TrOCR model), capability-gated like SigLIP/Whisper, lazy-loaded,
 *     local-only (no upload). Register it via `registerOcrEngine` and
 *     this function will start returning real hits with no call-site
 *     changes.
 *   - Do NOT add a heavy OCR dependency without checking the current
 *     package size / first-load JS budget first.
 */

import type { OcrEngine, OcrQueryArgs, OcrQueryResult } from "./types";

let engine: OcrEngine | null = null;

/** Register a real OCR engine (future). Until then, none is set. */
export function registerOcrEngine(e: OcrEngine | null): void {
  engine = e;
}

/** Is on-screen-text reading available on this device right now? */
export async function isOcrAvailable(): Promise<boolean> {
  if (!engine) return false;
  try {
    return await engine.isAvailable();
  } catch {
    return false;
  }
}

const UNAVAILABLE: OcrQueryResult = {
  available: false,
  hits: [],
  status:
    "On-screen text reading (OCR) isn't enabled yet, so I can't search for exact text shown on screen. I can try matching it in the spoken transcript or by visual scene instead."
};

export async function queryOnScreenText(args: OcrQueryArgs): Promise<OcrQueryResult> {
  if (!engine) return UNAVAILABLE;
  try {
    if (!(await engine.isAvailable())) return UNAVAILABLE;
    return await engine.query(args);
  } catch {
    return UNAVAILABLE;
  }
}
