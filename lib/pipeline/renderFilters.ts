/**
 * PR 59 — pure ffmpeg filter-graph builder (extracted from render.worker.ts).
 *
 * Self-contained (NO app imports) so the worker can import it AND it stays
 * unit-testable with `node --test`. Behaviour-preserving for the existing
 * GLOBAL transition path; adds an OPTIONAL per-boundary path.
 *
 * Two modes:
 *   - GLOBAL (back-compat): pass `transition`. Every clip gets fade-in +
 *     fade-out when transition is fade/crossfade — byte-identical to the
 *     previous worker output.
 *   - PER-BOUNDARY: pass `boundaryRenders` (length = clip count), where
 *     `boundaryRenders[i]` is the renderable transition at the boundary
 *     immediately BEFORE clip i (index 0 = lead-in, normally "none").
 *     Clip i fades IN iff boundaryRenders[i] is fade/crossfade, and fades
 *     OUT iff boundaryRenders[i+1] is fade/crossfade.
 *
 * HONESTY: the worker renders both `fade` and `crossfade` as a fade dip at
 * the boundary (a true overlap crossfade via xfade is future work). cut/
 * none = no fade. Unsupported effects must already be mapped DOWN to one of
 * none/fade/crossfade before they reach here (lib/transitions/map.ts).
 */

export type RenderableTransition = "none" | "fade" | "crossfade";
export type RenderFormat = "vertical" | "horizontal" | "square";

export interface FilterHighlight {
  start: number;
  end: number;
  /** Index into the ffmpeg `-i` input list. Defaults to 0. */
  inputIndex?: number;
}

export interface RenderFilterConfig {
  fadeFractionOfClip: number;
  fadeMaxSeconds: number;
  outputDimensions: Record<RenderFormat, { w: number; h: number }>;
}

/** Default config — mirrors lib/config.ts → RENDER (kept here so the helper
 *  has zero imports, matching the worker's self-contained style). */
export const DEFAULT_RENDER_FILTER_CONFIG: RenderFilterConfig = {
  fadeFractionOfClip: 0.25,
  fadeMaxSeconds: 0.4,
  outputDimensions: {
    vertical: { w: 1080, h: 1920 },
    horizontal: { w: 1920, h: 1080 },
    square: { w: 1080, h: 1080 }
  }
};

export interface BuildFilterArgs {
  highlights: FilterHighlight[];
  format: RenderFormat;
  withAudio: boolean;
  /** GLOBAL transition (used only when `boundaryRenders` is absent). */
  transition?: RenderableTransition;
  /** PER-BOUNDARY transitions (length = highlights.length). Takes priority
   *  over `transition` when present and non-empty. */
  boundaryRenders?: RenderableTransition[];
  config?: RenderFilterConfig;
}

function isFadeish(t: RenderableTransition | undefined): boolean {
  return t === "fade" || t === "crossfade";
}

/** Compute per-clip {in,out} fade flags for the chosen mode. */
export function computeClipFades(
  count: number,
  args: Pick<BuildFilterArgs, "transition" | "boundaryRenders">
): Array<{ in: boolean; out: boolean }> {
  const out: Array<{ in: boolean; out: boolean }> = [];
  const perBoundary = args.boundaryRenders && args.boundaryRenders.length > 0;
  for (let i = 0; i < count; i++) {
    if (perBoundary) {
      const before = args.boundaryRenders![i] ?? "none";
      const after = args.boundaryRenders![i + 1] ?? "none"; // undefined for last clip
      out.push({ in: isFadeish(before), out: isFadeish(after) });
    } else {
      const fade = isFadeish(args.transition);
      out.push({ in: fade, out: fade });
    }
  }
  return out;
}

/** Build the full filter_complex graph string. */
export function buildFilterComplex(args: BuildFilterArgs): string {
  const config = args.config ?? DEFAULT_RENDER_FILTER_CONFIG;
  const dim = config.outputDimensions[args.format] ?? config.outputDimensions.horizontal;
  const scale = scaleExpr(args.format, dim);
  const fades = computeClipFades(args.highlights.length, args);

  const chains: string[] = [];
  const concatInputs: string[] = [];

  args.highlights.forEach((h, i) => {
    const dur = Math.max(0.1, h.end - h.start);
    const maxFade = Math.min(config.fadeMaxSeconds, dur * config.fadeFractionOfClip);
    const idx = Math.max(0, Math.floor(h.inputIndex ?? 0));
    const fadeIn = fades[i].in ? maxFade : 0;
    const fadeOut = fades[i].out ? maxFade : 0;

    let v =
      `[${idx}:v]trim=start=${fmt(h.start)}:end=${fmt(h.end)},` +
      `setpts=PTS-STARTPTS,${scale}`;
    if (fadeIn > 0) v += `,fade=t=in:st=0:d=${fmt(fadeIn)}`;
    if (fadeOut > 0) v += `,fade=t=out:st=${fmt(dur - fadeOut)}:d=${fmt(fadeOut)}`;
    v += `[v${i}]`;
    chains.push(v);
    concatInputs.push(`[v${i}]`);

    if (args.withAudio) {
      let a =
        `[${idx}:a]atrim=start=${fmt(h.start)}:end=${fmt(h.end)},` +
        `asetpts=PTS-STARTPTS`;
      if (fadeIn > 0) a += `,afade=t=in:st=0:d=${fmt(fadeIn)}`;
      if (fadeOut > 0) a += `,afade=t=out:st=${fmt(dur - fadeOut)}:d=${fmt(fadeOut)}`;
      a += `[a${i}]`;
      chains.push(a);
      concatInputs.push(`[a${i}]`);
    }
  });

  const a = args.withAudio ? 1 : 0;
  const concatOut = args.withAudio ? `[outv][outa]` : `[outv]`;
  chains.push(
    `${concatInputs.join("")}concat=n=${args.highlights.length}:v=1:a=${a}${concatOut}`
  );
  return chains.join(";");
}

export function scaleExpr(format: RenderFormat, d: { w: number; h: number }): string {
  switch (format) {
    case "vertical":
    case "square":
      return (
        `scale=${d.w}:${d.h}:force_original_aspect_ratio=increase,` +
        `crop=${d.w}:${d.h}`
      );
    case "horizontal":
    default:
      return (
        `scale=${d.w}:${d.h}:force_original_aspect_ratio=decrease,` +
        `pad=${d.w}:${d.h}:(ow-iw)/2:(oh-ih)/2:black`
      );
  }
}

function fmt(n: number): string {
  return n.toFixed(3);
}
