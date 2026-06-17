/**
 * Phase 6 — OCR adapter interface (NOT yet implemented).
 *
 * On-screen text reading ("add the screen where it says SALE") needs a
 * real OCR model. We do NOT ship one yet because a capable in-browser OCR
 * (e.g. Tesseract.js ~2-4 MB wasm + language data, or a transformers.js
 * TrOCR model) is a meaningful download/perf cost that must be weighed
 * against the existing bundle. This file defines the contract so a real
 * engine can drop in later WITHOUT touching call sites, and so the agent
 * can answer text-on-screen requests HONESTLY ("OCR isn't ready yet")
 * instead of pretending it read the screen.
 *
 * See lib/ocr/query.ts for the current (unavailable) implementation.
 */

export interface OcrTextHit {
  /** The recognized on-screen text. */
  text: string;
  /** Seconds from start of the source where the text appears. */
  start: number;
  end: number;
  /** 0..1 recognition confidence. */
  confidence: number;
  /** Source the hit belongs to. */
  sourceId?: string;
}

export interface OcrQueryArgs {
  /** What on-screen text the user is looking for ("SALE", "subscribe"). */
  query: string;
  sourceId?: string;
  /** Optional time window to restrict the search. */
  range?: { startSeconds: number; endSeconds: number };
}

export interface OcrQueryResult {
  /** Whether an OCR engine is actually available + ran. When false the
   *  agent must fall back (visual / transcript) and SAY OCR isn't ready —
   *  never claim it read the screen. */
  available: boolean;
  hits: OcrTextHit[];
  /** Human-readable status for the agent to relay when unavailable. */
  status: string;
}

/** Pluggable OCR engine. A future implementation registers one of these. */
export interface OcrEngine {
  readonly id: string;
  isAvailable(): boolean | Promise<boolean>;
  query(args: OcrQueryArgs): Promise<OcrQueryResult>;
}
