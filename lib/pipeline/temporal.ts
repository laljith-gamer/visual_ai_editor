import type {
  CandidateWindow,
  EditPlan,
  TemporalVerdict
} from "@/lib/types";
import { sampleFrames, blobToBase64 } from "@/lib/pipeline/sample";
import { buildContactSheet } from "@/lib/vision/contact-sheet";
import { CONTACT_SHEET, HIGHLIGHT_SCORING } from "@/lib/config";

interface RunArgs {
  videoBlob: Blob;
  candidates: CandidateWindow[];
  plan: EditPlan;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * For each candidate window: build a contact sheet, post it to
 * /api/vision/window, collect a keep_score in [0,1] and a short reason.
 *
 * On any per-window failure we synthesize a neutral verdict so the pipeline
 * still completes. Aggregate quality of the short is barely affected if 1–2
 * windows fall back, but we never block on a single 5xx.
 */
export async function runTemporalPass({
  videoBlob,
  candidates,
  plan,
  signal,
  onProgress
}: RunArgs): Promise<TemporalVerdict[]> {
  const verdicts: TemporalVerdict[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const c = candidates[i];
    onProgress?.(i, candidates.length);
    try {
      const denseEvery = Math.max(
        (c.end - c.start) / CONTACT_SHEET.framesPerWindow,
        CONTACT_SHEET.minDenseSampleSeconds
      );
      const dense = await sampleFrames(videoBlob, {
        every: denseEvery,
        width: CONTACT_SHEET.cellWidth,
        maxFrames: CONTACT_SHEET.framesPerWindow,
        signal
      });
      // Constrain to within the candidate range with a small padding.
      const within = dense.filter(
        (f) => f.t >= c.start - 0.1 && f.t <= c.end + 0.1
      );
      if (within.length === 0) {
        verdicts.push(neutralVerdict(c));
        continue;
      }
      const sheet = await buildContactSheet(within);
      const sheetB64 = await blobToBase64(sheet);
      const resp = await fetch("/api/vision/window", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageBase64: sheetB64,
          windowStart: c.start,
          windowEnd: c.end,
          scenarios: plan.scenarios.map((s) => ({ id: s.id, prompt: s.prompt })),
          avoid: plan.avoid
        }),
        signal
      });
      if (!resp.ok) {
        verdicts.push(neutralVerdict(c));
        continue;
      }
      const json = (await resp.json()) as {
        keepScore?: number;
        reason?: string;
        label?: string;
      };
      verdicts.push({
        start: c.start,
        end: c.end,
        keepScore:
          typeof json.keepScore === "number"
            ? clamp01(json.keepScore)
            : HIGHLIGHT_SCORING.neutralKeepScore,
        reason: json.reason ?? "Strong window",
        label: json.label
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      verdicts.push(neutralVerdict(c));
    }
  }
  onProgress?.(candidates.length, candidates.length);
  return verdicts;
}

function neutralVerdict(c: CandidateWindow): TemporalVerdict {
  return {
    start: c.start,
    end: c.end,
    keepScore: HIGHLIGHT_SCORING.neutralKeepScore,
    reason: "Vision verdict unavailable; defaulted to neutral"
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
