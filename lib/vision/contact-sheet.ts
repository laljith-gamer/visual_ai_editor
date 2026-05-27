import type { SampledFrame } from "@/lib/pipeline/sample";

/**
 * Build a single image (4 columns × 3 rows by default) from up to 12 frames.
 * The temporal pass gets ONE Gemini call instead of 12, dramatically cutting
 * cost while still letting the VLM see motion across the window.
 */
export async function buildContactSheet(
  frames: SampledFrame[],
  options: { columns?: number; rows?: number; cellWidth?: number } = {}
): Promise<Blob> {
  const cols = options.columns ?? 4;
  const rows = options.rows ?? 3;
  const cellW = options.cellWidth ?? 256;
  const cellH = Math.round(cellW * (frames[0]?.height / Math.max(frames[0]?.width || 1, 1) || 0.5625));

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
      // overlay timestamp for the LLM to reference
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x, y + cellH - 16, 60, 16);
      ctx.fillStyle = "#f4f2ed";
      ctx.font = "11px monospace";
      ctx.fillText(`${f.t.toFixed(1)}s`, x + 4, y + cellH - 4);
      bitmap.close();
      placed++;
    }
  }

  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
}
