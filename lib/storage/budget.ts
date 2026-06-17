/**
 * Phase 3 — storage budget logic (pure, testable).
 *
 * Decides which cap applies (mobile vs desktop), whether any category is
 * over budget, and whether a model download is large enough to warrant a
 * permission prompt. No browser APIs here — `lib/storage/manager.ts` does
 * the actual measurement + cleanup. Imports config via a relative path so
 * it runs under `node --test`.
 */

import { STORAGE_BUDGET } from "../config";

export interface StorageBreakdown {
  /** Cached AI model weights (transformers.js / Whisper / etc.). */
  modelBytes: number;
  /** Sampled-frame prediction cache. */
  frameBytes: number;
  /** Local transcript cache. */
  transcriptBytes: number;
  /** Rendered output files held locally. */
  renderBytes: number;
  /** Project/session/log/agent-memory data. */
  projectBytes: number;
  /** Total measured (may exceed the sum when the platform reports more). */
  totalBytes: number;
}

export function emptyBreakdown(): StorageBreakdown {
  return {
    modelBytes: 0,
    frameBytes: 0,
    transcriptBytes: 0,
    renderBytes: 0,
    projectBytes: 0,
    totalBytes: 0
  };
}

export type BudgetCategory = "model" | "frame" | "render";

export interface BudgetCaps {
  modelBytes: number;
  frameBytes: number;
  renderBytes: number;
}

/** Pick the cap set for the device class. */
export function selectBudget(isMobile: boolean): BudgetCaps {
  return isMobile ? STORAGE_BUDGET.mobile : STORAGE_BUDGET.desktop;
}

/** Categories currently over their cap (for warnings / cleanup prompts). */
export function overBudgetCategories(
  breakdown: StorageBreakdown,
  isMobile: boolean
): BudgetCategory[] {
  const caps = selectBudget(isMobile);
  const out: BudgetCategory[] = [];
  if (breakdown.modelBytes > caps.modelBytes) out.push("model");
  if (breakdown.frameBytes > caps.frameBytes) out.push("frame");
  if (breakdown.renderBytes > caps.renderBytes) out.push("render");
  return out;
}

/** True when a model about to download is large enough to warrant a
 *  permission prompt (so the site never silently pulls a big model). */
export function shouldWarnBeforeModelDownload(sizeBytes: number): boolean {
  return sizeBytes > STORAGE_BUDGET.modelDownloadWarnBytes;
}

/** Human-readable bytes ("142 MB", "1.3 GB"). */
export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
