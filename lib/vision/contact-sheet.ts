import type { SampledFrame } from "@/lib/pipeline/sample";
import { CONTACT_SHEET } from "@/lib/config";

/**
 * Build a single image from up to N frames. Default grid (4×3 = 12 cells)
 * is configured in lib/config.ts → CONTACT_SHEET.
 *
 * The temporal pass gets ONE Gemini call instead of N, dramatically cutting
 * cost while still letting the VLM see motion across the window.
 */
export async function buildContactSheet(
  frames: SampledFrame[],
  options: { columns?: number; rows?: number; cellWidth?: number } = {}
): Promise<Blob> {
  const cols = options.columns ?? CONTACT_SHEET.cols;
  const rows = options.rows ?? CONTACT_SHEET.rows;
  const cellW = options.cellWidth ?? CONTACT_SHEET.cellWidth;

  const aspect =
    frames[0]?.height && frames[0]?.width
      ? frames[0].height / Math.max(frames[0].width, 1)
      : 9 / 16;
  const cellH = Math.max(2, Math.round(cellW * aspect));

  const sheetW = cellW * cols;
  const sheetH = cellH * rows;
  const canvas = new OffscreenCanvas(sheetW, sheetH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, sheetW, sheetH);

  const stride = Math.max(1, Math.floor(frames.length / (cols * rows)));
  let placed = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = Math.min(frames.length - 1, placed * stride);
      const f = frames[idx];
      if (!f) continue;
      const bitmap = await createImageBitmap(f.blob);
      const x = c * cellW;
      const y = r * cellH;
      ctx.drawImage(bitmap, x, y, cellW, cellH);
      // Overlay timestamp so the VLM can refer to specific frames.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x, y + cellH - 16, 60, 16);
      ctx.fillStyle = "#f4f2ed";
      ctx.font = "11px monospace";
      ctx.fillText(`${f.t.toFixed(1)}s`, x + 4, y + cellH - 4);
      bitmap.close();
      placed++;
    }
  }

  return await canvas.convertToBlob({
    type: "image/jpeg",
    quality: CONTACT_SHEET.jpegQuality
  });
}
