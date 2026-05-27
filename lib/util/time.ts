/** Format seconds as mm:ss or h:mm:ss. */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Compact one-decimal seconds string. */
export function formatSeconds(seconds: number, digits = 1): string {
  if (!isFinite(seconds)) return "0.0s";
  return `${seconds.toFixed(digits)}s`;
}

/** Clamp helper. */
export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
