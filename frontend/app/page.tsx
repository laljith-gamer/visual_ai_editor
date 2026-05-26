"use client";

import {
  CheckCircle2,
  Clock3,
  Download,
  Film,
  FileVideo,
  Gauge,
  GripVertical,
  History,
  Layers,
  Loader2,
  ListVideo,
  MessageSquare,
  Minus,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { type DragEvent, type FormEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const SESSION_STORAGE_KEY = "visual_ai_editor.sessions.v1";
const ACTIVE_SESSION_KEY = "visual_ai_editor.active_session.v1";
const MAX_LOCAL_SESSIONS = 12;
const MAX_BROWSER_SAMPLES = 72;
const MAX_EVENT_WINDOWS = 12;
const CONTACT_SHEET_FRAMES = 12;
const EVENT_KEEP_THRESHOLD = 0.55;
const MAX_BROWSER_RENDER_SECONDS = 360;
const MAX_BROWSER_HEAVY_RENDER_SECONDS = 60;
const HEAVY_SOURCE_BYTES = 1500 * 1024 * 1024;
const INITIAL_ASSISTANT_MESSAGE =
  "Upload any video and tell me what kind of short you want. If details are missing, I'll ask before spending time on analysis.";

type Highlight = {
  clip_id?: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  score: number;
  labels: string[];
  matched_labels?: string[];
  reason?: string;
  boundary_reason?: string;
  why_not_longer?: string;
  transition?: {
    type?: string;
    duration_seconds?: number;
  };
  preview_url?: string;
  event_label?: string;
  keep_score?: number;
  skip_score?: number;
  confidence?: number;
  title_overlay?: string;
  title_overlay_start_offset_seconds?: number;
  title_overlay_end_offset_seconds?: number;
};

type ProgressPayload = {
  stage?: string;
  percent?: number;
  message?: string;
  details?: Record<string, unknown>;
};

type JobPayload = {
  job_id: string;
  status: "created" | "running" | "completed" | "failed";
  prompt: string;
  resolved_prompt?: string;
  memory?: EditorMemory;
  source_job_id?: string;
  files: {
    input?: string;
    vertical?: string;
    horizontal?: string;
    report?: string;
    clip_review?: string;
  };
  highlights: Highlight[];
  edit_plan?: EditPlan;
  clip_review?: ClipReview;
  progress?: ProgressPayload;
  manual_updated_at?: string;
  predictions_count: number;
  report: string;
  stdout: string;
  stderr: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  memory: EditorMemory;
  conversationBrief: string;
  jobSnapshot?: JobPayload | null;
};

type EditorMemory = {
  duration_seconds?: number;
  format?: string;
  styles?: string[];
  keep?: string[];
  skip?: string[];
  last_prompt?: string;
  selection_strategy?: Record<string, unknown>;
};

type EditPlan = {
  request?: string;
  roboflow_scenarios?: string[];
  request_scenarios?: string[];
  label_weights?: Record<string, number>;
  target_short_seconds?: number;
  clip_seconds?: number;
  export_format?: string;
  selection_strategy?: Record<string, unknown>;
  preview_policy?: Record<string, unknown>;
  transition_policy?: Record<string, unknown>;
  planner_source?: string;
};

type ClipReview = {
  approved_for_render?: boolean;
  selected_duration?: number;
  clip_count?: number;
  export_format?: string;
  warnings?: string[];
  issues?: string[];
};

type AgentCheck = {
  ready: boolean;
  message: string;
  questions: string[];
  memory: EditorMemory;
  resolved_prompt: string;
  plan?: EditPlan;
};

type BrowserPrediction = {
  second: number;
  frame?: number;
  scene?: string;
  confidence?: number;
  all_scores?: number[];
  scenarios?: string[];
};

type CandidateWindow = {
  start: number;
  end: number;
  peak: number;
  score: number;
  labels: string[];
};

type BrowserEventAnalysis = {
  window_start: number;
  window_end: number;
  event_label?: string;
  keep_score?: number;
  skip_score?: number;
  confidence?: number;
  suggested_clip_start_offset_seconds?: number;
  suggested_clip_end_offset_seconds?: number;
  reason?: string;
  title_overlay?: string;
  title_overlay_start_offset_seconds?: number;
  title_overlay_end_offset_seconds?: number;
  fallback?: boolean;
  error_status?: boolean;
};

type PreviewClip = {
  src: string;
  start?: number;
  end?: number;
};

function absoluteUrl(path?: string) {
  if (!path) return "";
  if (path.startsWith("http") || path.startsWith("blob:") || path.startsWith("data:")) return path;
  return `${API_BASE}${path}`;
}

function formatTime(seconds: number) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function responseErrorMessage(response: Response) {
  const text = await response.text();
  const status = `${response.status} ${response.statusText}`.trim();
  if (!text) return status;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
    const detail = parsed.detail ?? parsed.message ?? parsed.error;
    if (typeof detail === "string") return detail === "Not Found" ? `${status}: ${detail}` : detail;
    if (Array.isArray(detail)) return detail.map((item) => item?.msg ?? JSON.stringify(item)).join("; ");
    if (detail) return JSON.stringify(detail);
  } catch {
    // The backend may return plain text from proxies or platform errors.
  }
  return text;
}

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs = 120000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const message = await responseErrorMessage(response);
      if (response.status === 404 && url.includes("/api/browser/event-analyze")) {
        throw new Error(
          "Backend is missing /api/browser/event-analyze. Redeploy the backend from the latest GitHub commit and make sure its Vercel project root is the repo root.",
        );
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The backend request timed out. The unified analyzer took too long to respond.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function requirePositiveNumber(value: unknown, message: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(message);
  return number;
}

function temporalResultIsEmpty(event: BrowserEventAnalysis) {
  const values = [
    event.event_label,
    event.keep_score,
    event.skip_score,
    event.confidence,
    event.suggested_clip_start_offset_seconds,
    event.suggested_clip_end_offset_seconds,
    event.reason,
  ];
  return values.every((value) => value === undefined || value === null || value === "");
}

function totalHighlightSeconds(highlights: Highlight[]) {
  return highlights.reduce((total, clip) => total + Number(clip.duration || 0), 0);
}

function browserRenderRisk(fileToRender: File, highlights: Highlight[]) {
  const seconds = totalHighlightSeconds(highlights);
  if (seconds > MAX_BROWSER_RENDER_SECONDS) {
    return `This cut is ${seconds.toFixed(1)}s. Browser WebM export is reliable for short cuts only; long renders can stretch, stutter, or desync.`;
  }
  if (fileToRender.size > HEAVY_SOURCE_BYTES && seconds > MAX_BROWSER_HEAVY_RENDER_SECONDS) {
    return `The source is ${formatBytes(fileToRender.size)} and the cut is ${seconds.toFixed(1)}s. Chrome cannot reliably decode and record that much video in real time.`;
  }
  return "";
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function labelIsLowValue(label: string | undefined, weights?: Record<string, number>) {
  const lowered = (label ?? "").toLowerCase();
  return (
    (label ? (weights?.[label] ?? 0.75) <= 0.05 : false) ||
    ["black", "blank", "blur", "unusable", "boring", "static", "menu", "loading", "idle"].some((term) =>
      lowered.includes(term),
    )
  );
}

function predictionScore(prediction: BrowserPrediction, weights?: Record<string, number>) {
  const label = prediction.scene ?? "";
  const base = weights?.[label] ?? (labelIsLowValue(label, weights) ? 0 : 0.75);
  const confidence = typeof prediction.confidence === "number" ? prediction.confidence : 0.35;
  return base * (0.75 + confidence);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function bestKeepLabel(scenarios: string[], weights?: Record<string, number>) {
  return (
    [...scenarios]
      .filter((label) => !labelIsLowValue(label, weights))
      .sort((left, right) => (weights?.[right] ?? 0.75) - (weights?.[left] ?? 0.75))[0] ||
    scenarios[0] ||
    "selected moment"
  );
}

function lowestValueLabel(scenarios: string[], weights?: Record<string, number>) {
  return (
    [...scenarios].sort((left, right) => (weights?.[left] ?? 0.75) - (weights?.[right] ?? 0.75))[0] ||
    scenarios[0] ||
    "low value footage"
  );
}

async function captureScoutPrediction(
  video: HTMLVideoElement,
  second: number,
  frame: number,
  scenarios: string[],
  weights?: Record<string, number>,
  previousPixels?: Uint8ClampedArray,
): Promise<{ prediction: BrowserPrediction; pixels: Uint8ClampedArray }> {
  await seekVideo(video, second);
  await delay(16);

  const canvas = document.createElement("canvas");
  const targetWidth = 96;
  canvas.width = targetWidth;
  canvas.height = Math.max(54, Math.round((video.videoHeight / video.videoWidth) * targetWidth));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is not available in this browser.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const pixels = new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data);
  const count = pixels.length / 4;
  let sum = 0;
  let sumSquares = 0;
  let delta = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
    sum += luminance;
    sumSquares += luminance * luminance;
    if (previousPixels && previousPixels.length === pixels.length) {
      const previous =
        (previousPixels[index] * 0.2126 + previousPixels[index + 1] * 0.7152 + previousPixels[index + 2] * 0.0722) /
        255;
      delta += Math.abs(luminance - previous);
    }
  }

  const brightness = sum / Math.max(count, 1);
  const contrast = Math.sqrt(Math.max(0, sumSquares / Math.max(count, 1) - brightness * brightness));
  const motion = previousPixels && previousPixels.length === pixels.length ? delta / Math.max(count, 1) : contrast * 0.75;
  const unusable = brightness < 0.045 || contrast < 0.018;
  const scene = unusable ? lowestValueLabel(scenarios, weights) : bestKeepLabel(scenarios, weights);
  const confidence = unusable
    ? 0.01
    : clamp01(motion * 3.2 + contrast * 1.35 + Math.min(0.18, Math.abs(brightness - 0.5) * 0.35));

  return {
    pixels,
    prediction: {
      second,
      frame,
      scene,
      confidence,
      all_scores: scenarios.map((label) => (label === scene ? confidence : Math.max(0.01, confidence * 0.18))),
      scenarios,
    },
  };
}

function buildCandidateWindows(predictions: BrowserPrediction[], duration: number, plan?: EditPlan): CandidateWindow[] {
  const weights = plan?.label_weights ?? {};
  const strategy = plan?.selection_strategy ?? {};
  const threshold = Number(strategy.broad_scan_threshold ?? 0.1);
  const windowSeconds = Math.max(2, Math.min(6, Number(strategy.event_window_seconds ?? 4)));
  const sorted = [...predictions]
    .map((item) => ({ ...item, score: predictionScore(item, weights) }))
    .filter((item) => !labelIsLowValue(item.scene, weights) && item.score > threshold)
    .sort((left, right) => left.second - right.second);

  if (!sorted.length || duration <= 0) return [];

  const desiredWindows = Math.min(MAX_EVENT_WINDOWS, sorted.length);
  const chosen = new Map<number, (typeof sorted)[number]>();
  const bucketSize = duration / desiredWindows;

  for (let bucket = 0; bucket < desiredWindows; bucket += 1) {
    const bucketStart = bucket * bucketSize;
    const bucketEnd = bucket === desiredWindows - 1 ? duration + 0.001 : bucketStart + bucketSize;
    const best = sorted
      .filter((item) => item.second >= bucketStart && item.second < bucketEnd)
      .sort((left, right) => right.score - left.score || Math.abs(left.second - (bucketStart + bucketSize / 2)) - Math.abs(right.second - (bucketStart + bucketSize / 2)))[0];
    if (best) chosen.set(best.frame ?? Math.round(best.second * 10), best);
  }

  for (const item of [...sorted].sort((left, right) => right.score - left.score || left.second - right.second)) {
    if (chosen.size >= desiredWindows) break;
    const tooClose = [...chosen.values()].some((selected) => Math.abs(selected.second - item.second) < windowSeconds * 0.75);
    if (!tooClose) chosen.set(item.frame ?? Math.round(item.second * 10), item);
  }

  return [...chosen.values()]
    .map((item) => {
      const start = Math.max(0, item.second - windowSeconds / 2);
      const end = Math.min(duration, Math.max(start + 1, item.second + windowSeconds / 2));
      const near = sorted.filter((sample) => sample.second >= start && sample.second <= end);
      const labels = [...new Set(near.map((sample) => sample.scene).filter(Boolean) as string[])].slice(0, 5);
      const score = near.length
        ? near.reduce((total, sample) => total + sample.score, 0) / near.length
        : item.score;
      return {
        start,
        end,
        peak: item.second,
        score: Number(score.toFixed(4)),
        labels,
      };
    })
    .sort((left, right) => left.start - right.start);
}

function buildEventHighlights(events: BrowserEventAnalysis[], duration: number, plan?: EditPlan): Highlight[] {
  const strategy = plan?.selection_strategy ?? {};
  const targetSeconds = Math.max(3, Number(plan?.target_short_seconds));
  const minClip = Math.max(1.5, Number(strategy.minimum_clip_seconds || 3));
  const qualityThreshold = Math.max(0, Math.min(1, Number(strategy.quality_threshold ?? EVENT_KEEP_THRESHOLD)));
  const candidates = events
    .filter((event) => !event.fallback)
    .map((event) => {
      const keep = Number(event.keep_score ?? 0);
      const skip = Number(event.skip_score ?? 0);
      const confidence = Number(event.confidence ?? 0);
      const startOffset = Number(event.suggested_clip_start_offset_seconds ?? 0);
      const endOffset = Number(event.suggested_clip_end_offset_seconds ?? 0);
      const start = Math.max(0, Number(event.window_start || 0) + startOffset);
      let end = Math.min(duration, Number(event.window_end || start) + endOffset);
      if (end - start < minClip) {
        end = Math.min(duration, start + minClip);
      }
      return {
        event,
        start,
        end,
        duration: Math.max(0, end - start),
        score: keep * (0.7 + confidence * 0.3) - skip * 0.35,
      };
    })
    .filter((item) => {
      const keep = Number(item.event.keep_score ?? 0);
      const skip = Number(item.event.skip_score ?? 0);
      return item.duration >= 1 && keep >= qualityThreshold && keep > skip;
    })
    .sort((left, right) => right.score - left.score || left.start - right.start);

  const selected: typeof candidates = [];
  let total = 0;
  for (const candidate of candidates) {
    if (total >= targetSeconds) break;
    const overlaps = selected.some((clip) => candidate.start < clip.end && candidate.end > clip.start);
    if (overlaps) continue;
    let clip = candidate;
    const remaining = targetSeconds - total;
    if (clip.duration > remaining && remaining >= minClip) {
      clip = { ...clip, end: clip.start + remaining, duration: remaining };
    } else if (clip.duration > remaining && selected.length) {
      continue;
    }
    selected.push(clip);
    total += clip.duration;
  }

  return selected
    .sort((left, right) => left.start - right.start)
    .map((item, index) => {
      const label = item.event.event_label || "selected moment";
      return {
        index: index + 1,
        start: Number(item.start.toFixed(2)),
        end: Number(item.end.toFixed(2)),
        duration: Number(item.duration.toFixed(2)),
        score: Number(item.score.toFixed(4)),
        labels: [label],
        matched_labels: [label],
        reason: item.event.reason || `Kept because ${label} matched the edit request near ${formatTime(item.event.window_start)}.`,
        boundary_reason: "Bounds came from the temporal event analyzer offsets.",
        why_not_longer: total >= targetSeconds ? "Trimmed around the requested final duration." : "Kept only around the meaningful event window.",
        transition: { type: index ? "fade" : "cut", duration_seconds: index ? 0.3 : 0 },
        event_label: label,
        keep_score: Number(item.event.keep_score ?? 0),
        skip_score: Number(item.event.skip_score ?? 0),
        confidence: Number(item.event.confidence ?? 0),
        title_overlay: item.event.title_overlay || "",
        title_overlay_start_offset_seconds: Number(item.event.title_overlay_start_offset_seconds ?? 0),
        title_overlay_end_offset_seconds: Number(item.event.title_overlay_end_offset_seconds ?? 0),
      };
    });
}

function progressFromLog(job?: JobPayload) {
  if (!job) return 0;
  if (typeof job.progress?.percent === "number") {
    return Math.max(0, Math.min(100, Math.round(job.progress.percent)));
  }
  const matches = [...job.stdout.matchAll(/\[(\d+)\/(\d+)\]/g)];
  const last = matches.at(-1);
  if (!last) return job.status === "completed" ? 100 : 0;
  return Math.min(100, Math.round((Number(last[1]) / Number(last[2])) * 100));
}

function progressJob(
  jobId: string,
  prompt: string,
  inputUrl: string,
  memory: EditorMemory,
  plan: EditPlan | undefined,
  stage: string,
  percent: number,
  message: string,
  predictionsCount = 0,
  highlights: Highlight[] = [],
  files: JobPayload["files"] = {},
): JobPayload {
  return {
    job_id: jobId,
    status: percent >= 100 ? "completed" : "running",
    prompt,
    resolved_prompt: plan?.request || prompt,
    memory,
    files: { input: inputUrl, ...files },
    highlights,
    edit_plan: plan,
    predictions_count: predictionsCount,
    report: "",
    stdout: "",
    stderr: "",
    progress: { stage, percent, message },
  };
}

function normalizeHighlights(highlights: Highlight[]) {
  return highlights.map((clip, index) => {
    const start = Math.max(0, Number(clip.start || 0));
    const end = Math.max(start + 0.25, Number(clip.end || start + clip.duration || start + 0.25));
    return {
      ...clip,
      clip_id: clip.clip_id || `${start.toFixed(2)}-${end.toFixed(2)}-${clip.labels.join("|")}`,
      index: index + 1,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      duration: Number((end - start).toFixed(2)),
      transition: {
        type: index ? clip.transition?.type || "fade" : "cut",
        duration_seconds: index ? Number(clip.transition?.duration_seconds ?? 0.3) : 0,
      },
    };
  });
}

function clipIdentity(clip: Highlight) {
  return clip.clip_id || `${clip.start}-${clip.end}-${clip.labels.join("|")}`;
}

function isBrowserJobId(jobId?: string) {
  return Boolean(jobId?.startsWith("browser-"));
}

function statusLabel(status?: JobPayload["status"]) {
  if (!status) return "Ready";
  if (status === "created") return "Queued";
  return status;
}

function initialMessages(): ChatMessage[] {
  return [{ role: "assistant", content: INITIAL_ASSISTANT_MESSAGE }];
}

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sessionTitle(messages: ChatMessage[], conversationBrief: string) {
  const userMessage = messages.find((message) => message.role === "user")?.content || conversationBrief || "New edit";
  const compact = userMessage.replace(/\s+/g, " ").trim();
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact || "New edit";
}

function readStoredSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ChatSession => Boolean(item?.id && Array.isArray(item.messages)))
      .slice(0, MAX_LOCAL_SESSIONS);
  } catch {
    return [];
  }
}

function writeStoredSessions(sessions: ChatSession[], activeSessionId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_LOCAL_SESSIONS)));
  window.localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
}

async function loadVideoElement(file: File) {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not read video metadata in the browser."));
  });
  return video;
}

async function seekVideo(video: HTMLVideoElement, second: number) {
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    video.addEventListener("seeked", done, { once: true });
    video.currentTime = Math.min(Math.max(second, 0), Math.max(video.duration - 0.05, 0));
  });
}

function drawCoverFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  fade = 0,
) {
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  if (fade > 0) {
    context.fillStyle = `rgba(0,0,0,${Math.min(1, Math.max(0, fade))})`;
    context.fillRect(0, 0, width, height);
  }
}

function drawTitleOverlay(context: CanvasRenderingContext2D, width: number, height: number, text: string) {
  const title = text.trim().toUpperCase().slice(0, 28);
  if (!title) return;

  context.save();
  let fontSize = Math.round(width * 0.095);
  context.font = `900 ${fontSize}px Arial, sans-serif`;
  while (context.measureText(title).width > width * 0.86 && fontSize > 30) {
    fontSize -= 2;
    context.font = `900 ${fontSize}px Arial, sans-serif`;
  }

  const metrics = context.measureText(title);
  const paddingX = Math.round(width * 0.045);
  const paddingY = Math.round(height * 0.018);
  const boxWidth = Math.min(width * 0.92, metrics.width + paddingX * 2);
  const boxHeight = fontSize + paddingY * 2;
  const boxX = (width - boxWidth) / 2;
  const boxY = height * 0.12;
  const textX = width / 2;
  const textY = boxY + boxHeight / 2 + fontSize * 0.34;

  context.fillStyle = "rgba(0, 0, 0, 0.62)";
  context.fillRect(boxX, boxY, boxWidth, boxHeight);
  context.fillStyle = "#f3c84b";
  context.fillRect(boxX, boxY + boxHeight - 8, boxWidth, 8);
  context.textAlign = "center";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(0, 0, 0, 0.85)";
  context.lineWidth = Math.max(6, fontSize * 0.12);
  context.strokeText(title, textX, textY);
  context.fillStyle = "#fff9df";
  context.fillText(title, textX, textY);
  context.restore();
}

async function buildContactSheet(
  video: HTMLVideoElement,
  start: number,
  end: number,
  frameCount = CONTACT_SHEET_FRAMES,
) {
  const cols = 4;
  const thumbWidth = 320;
  const thumbHeight = 240;
  const rows = Math.ceil(frameCount / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * thumbWidth;
  canvas.height = rows * thumbHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available in this browser.");

  context.fillStyle = "#050505";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 0.1, end);
  for (let index = 0; index < frameCount; index += 1) {
    const progress = frameCount === 1 ? 0.5 : index / (frameCount - 1);
    const second = safeStart + (safeEnd - safeStart) * progress;
    await seekVideo(video, second);
    await delay(20);

    const column = index % cols;
    const row = Math.floor(index / cols);
    const x = column * thumbWidth;
    const y = row * thumbHeight;
    const scale = Math.max(thumbWidth / video.videoWidth, thumbHeight / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    context.drawImage(video, x + (thumbWidth - drawWidth) / 2, y + (thumbHeight - drawHeight) / 2, drawWidth, drawHeight);
    context.fillStyle = "rgba(0, 0, 0, 0.72)";
    context.fillRect(x + 8, y + 8, 34, 26);
    context.fillStyle = "#4df08b";
    context.font = "bold 17px Arial, sans-serif";
    context.fillText(String(index + 1), x + 18, y + 27);
  }

  return canvas.toDataURL("image/jpeg", 0.82).split(",", 2)[1];
}

async function pauseRecorder(recorder: MediaRecorder) {
  if (recorder.state !== "recording") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 250);
    recorder.addEventListener(
      "pause",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    recorder.pause();
  });
}

async function resumeRecorder(recorder: MediaRecorder) {
  if (recorder.state !== "paused") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 250);
    recorder.addEventListener(
      "resume",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    recorder.resume();
  });
}

function waitForNextVideoFrame(video: HTMLVideoElement) {
  return new Promise<void>((resolve) => {
    const withFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (withFrameCallback.requestVideoFrameCallback) {
      const timeout = window.setTimeout(resolve, 220);
      withFrameCallback.requestVideoFrameCallback(() => {
        window.clearTimeout(timeout);
        resolve();
      });
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

function drawClipFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  clip: Highlight,
) {
  const elapsed = Math.max(0, video.currentTime - clip.start);
  const remainingEnd = Math.max(0, clip.end - video.currentTime);
  const fade = Math.max(0, 1 - elapsed / 0.3, 1 - remainingEnd / 0.3);
  drawCoverFrame(context, video, width, height, fade);
  const overlayStart = Number(clip.title_overlay_start_offset_seconds ?? 0);
  const overlayEnd = Math.max(overlayStart + 0.2, Number(clip.title_overlay_end_offset_seconds ?? 1.5));
  if (clip.title_overlay && elapsed >= overlayStart && elapsed <= overlayEnd) {
    drawTitleOverlay(context, width, height, clip.title_overlay);
  }
}

async function renderClipToCanvas(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  clip: Highlight,
) {
  await new Promise<void>((resolve) => {
    let lastMediaTime = -1;
    let repeatedFrames = 0;

    const draw = () => {
      if (Math.abs(video.currentTime - lastMediaTime) < 0.001) {
        repeatedFrames += 1;
      } else {
        repeatedFrames = 0;
        lastMediaTime = video.currentTime;
      }

      drawClipFrame(context, video, width, height, clip);
      if (video.currentTime >= clip.end || video.ended) {
        video.pause();
        resolve();
        return;
      }

      if (repeatedFrames > 18) {
        requestAnimationFrame(draw);
        return;
      }

      void waitForNextVideoFrame(video).then(draw);
    };

    void waitForNextVideoFrame(video).then(draw);
  });
}

async function renderBrowserShort(file: File, highlights: Highlight[], format: string | undefined) {
  const video = await loadVideoElement(file);
  video.muted = true;
  video.playbackRate = 1;
  const vertical = format !== "horizontal";
  const width = vertical ? 720 : 1280;
  const height = vertical ? 1280 : 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available in this browser.");

  const stream = canvas.captureStream(30);

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start(1000);
  await pauseRecorder(recorder);

  for (const clip of highlights) {
    await pauseRecorder(recorder);
    video.pause();
    await seekVideo(video, clip.start);
    await waitForNextVideoFrame(video);
    drawClipFrame(context, video, width, height, clip);
    await resumeRecorder(recorder);
    await video.play();
    await renderClipToCanvas(video, context, width, height, clip);
  }

  await pauseRecorder(recorder);
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });
  URL.revokeObjectURL(video.src);
  return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<JobPayload | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<PreviewClip | null>(null);
  const [lockedPreview, setLockedPreview] = useState<PreviewClip | null>(null);
  const [memory, setMemory] = useState<EditorMemory>({});
  const [conversationBrief, setConversationBrief] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages());
  const [selectedClipIndex, setSelectedClipIndex] = useState(0);
  const [draggingClipIndex, setDraggingClipIndex] = useState<number | null>(null);
  const [manualSyncLabel, setManualSyncLabel] = useState("Synced locally");
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  const progress = useMemo(() => progressFromLog(job ?? undefined), [job]);
  const activePreview = hoverPreview ?? lockedPreview;
  const previewSource =
    activePreview?.src ||
    absoluteUrl(job?.files.vertical) ||
    absoluteUrl(job?.files.horizontal) ||
    absoluteUrl(job?.files.input) ||
    "";
  const selectedDuration = useMemo(
    () => (job?.highlights ?? []).reduce((total, item) => total + Number(item.duration || 0), 0),
    [job],
  );
  const selectedClip = job?.highlights?.[selectedClipIndex] ?? null;
  const activeFileName = file?.name ?? (job?.files.input ? "Source video loaded" : "No video selected");
  const isWorking = job?.status === "running" || isSubmitting;
  const hasRenderedOutput = Boolean(job?.files.vertical || job?.files.horizontal);

  useEffect(() => {
    const storedSessions = readStoredSessions();
    const activeId = window.localStorage.getItem(ACTIVE_SESSION_KEY);
    const restored = storedSessions.find((item) => item.id === activeId) ?? storedSessions[0];

    if (restored) {
      setSessions(storedSessions);
      setActiveSessionId(restored.id);
      setMessages(restored.messages.length ? restored.messages : initialMessages());
      setMemory(restored.memory ?? {});
      setConversationBrief(restored.conversationBrief ?? "");
      setJob(restored.jobSnapshot ?? null);
    } else {
      const newSession: ChatSession = {
        id: createSessionId(),
        title: "New edit",
        updatedAt: Date.now(),
        messages: initialMessages(),
        memory: {},
        conversationBrief: "",
        jobSnapshot: null,
      };
      setSessions([newSession]);
      setActiveSessionId(newSession.id);
      writeStoredSessions([newSession], newSession.id);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !activeSessionId) return;

    setSessions((current) => {
      const existing = current.find((item) => item.id === activeSessionId);
      const updated: ChatSession = {
        id: activeSessionId,
        title: sessionTitle(messages, conversationBrief),
        updatedAt: Date.now(),
        messages,
        memory,
        conversationBrief,
        jobSnapshot: job,
      };
      const next = [updated, ...current.filter((item) => item.id !== activeSessionId)]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_LOCAL_SESSIONS);
      if (!existing && current.length >= MAX_LOCAL_SESSIONS) {
        next.length = MAX_LOCAL_SESSIONS;
      }
      writeStoredSessions(next, activeSessionId);
      return next;
    });
  }, [activeSessionId, conversationBrief, hydrated, job, memory, messages]);

  useEffect(() => {
    const count = job?.highlights.length ?? 0;
    if (!count) {
      setSelectedClipIndex(0);
      return;
    }
    setSelectedClipIndex((current) => Math.min(current, count - 1));
  }, [job?.highlights.length]);

  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") {
      return;
    }
    if (isBrowserJobId(job.job_id)) {
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/jobs/${job.job_id}`);
        if (response.ok) {
          setJob(await response.json());
        }
      } catch {
        setMessages((current) => {
          const last = current.at(-1)?.content ?? "";
          if (last.includes("backend connection dropped")) {
            return current;
          }
          return [
            ...current,
            {
              role: "assistant",
              content:
                "The backend connection dropped for a moment. I will keep polling and recover when it responds again.",
            },
          ];
        });
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [job]);

  useEffect(() => {
    if (!timelineOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTimelineOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [timelineOpen]);

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video || !activePreview || typeof activePreview.start !== "number" || typeof activePreview.end !== "number") {
      return;
    }

    const start = Math.max(0, activePreview.start);
    const end = Math.max(start + 0.25, activePreview.end);

    function seekToClipStart() {
      if (!video) return;
      const safeStart = Number.isFinite(video.duration) ? Math.min(start, Math.max(video.duration - 0.05, 0)) : start;
      video.currentTime = safeStart;
      video.play().catch(() => undefined);
    }

    function keepInsideClip() {
      if (!video) return;
      if (video.currentTime >= end || video.ended) {
        video.currentTime = start;
        video.play().catch(() => undefined);
      }
    }

    if (video.readyState >= 1) {
      seekToClipStart();
    } else {
      video.addEventListener("loadedmetadata", seekToClipStart, { once: true });
    }
    video.addEventListener("timeupdate", keepInsideClip);

    return () => {
      video.removeEventListener("loadedmetadata", seekToClipStart);
      video.removeEventListener("timeupdate", keepInsideClip);
    };
  }, [activePreview]);

  function previewForHighlight(highlight: Highlight): PreviewClip | null {
    const src = absoluteUrl(highlight.preview_url) || absoluteUrl(job?.files.input);
    if (!src) return null;

    const inputSource = absoluteUrl(job?.files.input);
    if (inputSource && src === inputSource) {
      return { src, start: highlight.start, end: highlight.end };
    }

    return { src };
  }

  async function syncManualState(nextJob: JobPayload) {
    setManualSyncLabel("Saving");
    try {
      const response = await fetch(`${API_BASE}/api/jobs/${nextJob.job_id}/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: nextJob.prompt,
          resolved_prompt: nextJob.resolved_prompt,
          memory: nextJob.memory ?? memory,
          edit_plan: nextJob.edit_plan ?? {},
          highlights: nextJob.highlights,
        }),
      });
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response));
      }
      setManualSyncLabel("Saved");
    } catch {
      setManualSyncLabel("Local only");
    }
  }

  function commitManualHighlights(highlights: Highlight[], message = "Manual timeline updated.") {
    const normalized = normalizeHighlights(highlights);
    setJob((current) => {
      if (!current) return current;
      const nextJob: JobPayload = {
        ...current,
        highlights: normalized,
        progress: {
          ...(current.progress ?? {}),
          stage: "manual",
          percent: current.status === "completed" ? 100 : progressFromLog(current),
          message,
        },
      };
      void syncManualState(nextJob);
      return nextJob;
    });
  }

  function setManualHighlightsLocally(highlights: Highlight[], message = "Editing clip timing.") {
    const normalized = normalizeHighlights(highlights);
    setJob((current) => {
      if (!current) return current;
      return {
        ...current,
        highlights: normalized,
        progress: {
          ...(current.progress ?? {}),
          stage: "manual",
          percent: current.status === "completed" ? 100 : progressFromLog(current),
          message,
        },
      };
    });
  }

  function moveHighlight(fromIndex: number, toIndex: number) {
    const highlights = job?.highlights ?? [];
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= highlights.length || toIndex >= highlights.length) {
      return;
    }
    const next = [...highlights];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setSelectedClipIndex(toIndex);
    commitManualHighlights(next, "Manual clip order saved.");
  }

  function handleClipDragStart(event: DragEvent<HTMLElement>, index: number) {
    setDraggingClipIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }

  function handleClipDrop(event: DragEvent<HTMLElement>, index: number) {
    event.preventDefault();
    const fromIndex = Number(event.dataTransfer.getData("text/plain"));
    setDraggingClipIndex(null);
    moveHighlight(fromIndex, index);
  }

  function updateHighlightTime(index: number, field: "start" | "end", value: string) {
    const number = Number(value);
    if (!Number.isFinite(number) || !job?.highlights[index]) return;

    const next = job.highlights.map((clip, clipIndex) => {
      if (clipIndex !== index) return clip;
      const start = field === "start" ? Math.max(0, number) : clip.start;
      const end = field === "end" ? Math.max(start + 0.25, number) : Math.max(start + 0.25, clip.end);
      return {
        ...clip,
        start,
        end,
        duration: end - start,
        why_not_longer: "Adjusted manually by the editor.",
      };
    });
    commitManualHighlights(next, "Manual clip timing saved.");
  }

  function resizeHighlight(index: number, edge: "start" | "end", deltaSeconds: number, sync = true) {
    if (!job?.highlights[index]) return;
    const next = job.highlights.map((clip, clipIndex) => {
      if (clipIndex !== index) return clip;
      const start =
        edge === "start"
          ? Math.max(0, Math.min(clip.start + deltaSeconds, clip.end - 0.25))
          : clip.start;
      const end = edge === "end" ? Math.max(clip.start + 0.25, clip.end + deltaSeconds) : clip.end;
      return {
        ...clip,
        start,
        end,
        duration: end - start,
        why_not_longer: "Adjusted manually by the editor.",
      };
    });
    if (sync) {
      commitManualHighlights(next, "Manual clip timing saved.");
    } else {
      setManualHighlightsLocally(next);
    }
  }

  function shiftHighlight(index: number, deltaSeconds: number) {
    if (!job?.highlights[index]) return;
    const next = job.highlights.map((clip, clipIndex) => {
      if (clipIndex !== index) return clip;
      const start = Math.max(0, clip.start + deltaSeconds);
      const end = start + clip.duration;
      return {
        ...clip,
        start,
        end,
        why_not_longer: "Moved manually by the editor.",
      };
    });
    commitManualHighlights(next, "Manual clip position saved.");
  }

  function handleResizePointerDown(event: PointerEvent<HTMLButtonElement>, index: number, edge: "start" | "end") {
    const clip = job?.highlights[index];
    if (!clip || !job) return;

    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const clipWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 160;
    const secondsPerPixel = Math.max(0.025, clip.duration / Math.max(80, clipWidth));
    const baseHighlights = job.highlights;
    let latest = baseHighlights;

    const handleMove = (pointerEvent: globalThis.PointerEvent) => {
      const deltaSeconds = (pointerEvent.clientX - startX) * secondsPerPixel;
      latest = baseHighlights.map((item, clipIndex) => {
        if (clipIndex !== index) return item;
        const start =
          edge === "start"
            ? Math.max(0, Math.min(item.start + deltaSeconds, item.end - 0.25))
            : item.start;
        const end = edge === "end" ? Math.max(item.start + 0.25, item.end + deltaSeconds) : item.end;
        return {
          ...item,
          start,
          end,
          duration: end - start,
          why_not_longer: "Adjusted manually by dragging the clip edge.",
        };
      });
      setManualSyncLabel("Editing");
      setManualHighlightsLocally(latest);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      commitManualHighlights(latest, "Manual clip resize saved.");
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  function removeHighlight(index: number) {
    if (!job?.highlights.length) return;
    const next = job.highlights.filter((_, clipIndex) => clipIndex !== index);
    setSelectedClipIndex(Math.max(0, Math.min(index, next.length - 1)));
    commitManualHighlights(next, "Manual clip removed.");
  }

  async function renderManualEdit() {
    if (!file || !job?.highlights.length) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: "I need the source video in this browser before I can render the manual arrangement.",
        },
      ]);
      return;
    }

    setIsSubmitting(true);
    const currentJob = job;
    setJob({
      ...currentJob,
      status: "running",
      progress: {
        stage: "rendering",
        percent: 82,
        message: "Rendering the manual clip arrangement in your browser.",
      },
    });

    try {
      const risk = browserRenderRisk(file, currentJob.highlights);
      if (risk) {
        setJob({
          ...currentJob,
          status: "completed",
          progress: {
            stage: "manual",
            percent: 100,
            message: `Manual clips are saved, but browser export was paused: ${risk}`,
          },
        });
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            content:
              `I paused the browser render because it would likely create a broken WebM: ${risk} Shorten the cut, or export with a local/server FFmpeg worker for this size.`,
          },
        ]);
        return;
      }
      const outputUrl = await renderBrowserShort(file, currentJob.highlights, currentJob.edit_plan?.export_format);
      const selectedSeconds = totalHighlightSeconds(currentJob.highlights);
      const nextJob: JobPayload = {
        ...currentJob,
        status: "completed",
        files: { ...currentJob.files, vertical: outputUrl, horizontal: outputUrl },
        progress: {
          stage: "completed",
          percent: 100,
          message: "Manual arrangement rendered locally.",
        },
        report:
          `Manual Browser Edit\n\n` +
          `Selected ${currentJob.highlights.length} clips totaling ${selectedSeconds.toFixed(1)} seconds.\n` +
          `Clip order and trim points were saved to the backend project state.\n` +
          `Browser export is silent to avoid audio crackle while jumping between source clips.\n`,
      };
      setHoverPreview(null);
      setLockedPreview(null);
      setJob(nextJob);
      void syncManualState(nextJob);
      setMessages((current) => [...current, { role: "assistant", content: "Manual arrangement rendered and saved." }]);
    } catch (error) {
      setJob(currentJob);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: error instanceof Error ? `Manual render failed: ${error.message}` : "Manual render failed.",
        },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  function startNewChat() {
    const newSession: ChatSession = {
      id: createSessionId(),
      title: "New edit",
      updatedAt: Date.now(),
      messages: initialMessages(),
      memory: {},
      conversationBrief: "",
      jobSnapshot: null,
    };
    const next = [newSession, ...sessions].slice(0, MAX_LOCAL_SESSIONS);
    setSessions(next);
    setActiveSessionId(newSession.id);
    setPrompt("");
    setFile(null);
    setJob(null);
    setHoverPreview(null);
    setLockedPreview(null);
    setTimelineOpen(false);
    setMemory({});
    setConversationBrief("");
    setMessages(newSession.messages);
    writeStoredSessions(next, newSession.id);
  }

  function restoreSession(session: ChatSession) {
    setActiveSessionId(session.id);
    setPrompt("");
    setFile(null);
    setJob(session.jobSnapshot ?? null);
    setHoverPreview(null);
    setLockedPreview(null);
    setTimelineOpen(false);
    setMemory(session.memory ?? {});
    setConversationBrief(session.conversationBrief ?? "");
    setMessages(session.messages.length ? session.messages : initialMessages());
    writeStoredSessions(sessions, session.id);
  }

  function applySession(session: ChatSession, nextSessions: ChatSession[]) {
    setSessions(nextSessions);
    setActiveSessionId(session.id);
    setPrompt("");
    setFile(null);
    setJob(session.jobSnapshot ?? null);
    setHoverPreview(null);
    setLockedPreview(null);
    setTimelineOpen(false);
    setMemory(session.memory ?? {});
    setConversationBrief(session.conversationBrief ?? "");
    setMessages(session.messages.length ? session.messages : initialMessages());
    writeStoredSessions(nextSessions, session.id);
  }

  function deleteSession(sessionId: string) {
    const next = sessions.filter((session) => session.id !== sessionId);
    if (!next.length) {
      const fresh: ChatSession = {
        id: createSessionId(),
        title: "New edit",
        updatedAt: Date.now(),
        messages: initialMessages(),
        memory: {},
        conversationBrief: "",
        jobSnapshot: null,
      };
      applySession(fresh, [fresh]);
      return;
    }

    if (sessionId === activeSessionId) {
      applySession(next[0], next);
      return;
    }

    setSessions(next);
    writeStoredSessions(next, activeSessionId);
  }

  function clearHistory() {
    const fresh: ChatSession = {
      id: createSessionId(),
      title: "New edit",
      updatedAt: Date.now(),
      messages: initialMessages(),
      memory: {},
      conversationBrief: "",
      jobSnapshot: null,
    };
    applySession(fresh, [fresh]);
  }

  async function runBrowserWorkflow(fileToProcess: File, userText: string, check: AgentCheck) {
    const jobId = `browser-${Date.now()}`;
    const inputUrl = URL.createObjectURL(fileToProcess);
    const plan = check.plan;
    const memoryForJob = check.memory ?? {};
    const scenarios = plan?.roboflow_scenarios ?? [];
    if (scenarios.length < 2) {
      throw new Error("The AI planner did not return enough visual scenario labels.");
    }
    requirePositiveNumber(
      plan?.target_short_seconds,
      "The AI planner did not choose a final video duration. Ask for a length like 30 seconds, 40 seconds, or 3 minutes.",
    );

    setJob(progressJob(jobId, userText, inputUrl, memoryForJob, plan, "preparing", 5, "Reading the video locally in your browser."));

    const video = await loadVideoElement(fileToProcess);
    const duration = video.duration || 0;
    const sampleEvery = Math.max(2, Math.ceil(duration / MAX_BROWSER_SAMPLES));
    const sampleTimes: number[] = [];
    for (let second = 0; second < duration; second += sampleEvery) {
      sampleTimes.push(Math.min(second, Math.max(duration - 0.1, 0)));
    }

    const predictions: BrowserPrediction[] = [];
    let previousPixels: Uint8ClampedArray | undefined;
    const weights = plan?.label_weights ?? {};

    for (let index = 0; index < sampleTimes.length; index += 1) {
      const scout = await captureScoutPrediction(video, sampleTimes[index], index, scenarios, weights, previousPixels);
      previousPixels = scout.pixels;
      predictions.push(scout.prediction);

      if (index % 4 === 0 || index === sampleTimes.length - 1) {
        const percent = 8 + Math.round((index / Math.max(sampleTimes.length - 1, 1)) * 42);
        setJob(
          progressJob(
            jobId,
            userText,
            inputUrl,
            memoryForJob,
            plan,
            "scouting",
            percent,
            `Scouted ${Math.min(index + 1, sampleTimes.length)}/${sampleTimes.length} local video samples.`,
            predictions.length,
          ),
        );
      }
    }
    const candidateWindows = buildCandidateWindows(predictions, duration, plan);
    if (!candidateWindows.length) {
      URL.revokeObjectURL(video.src);
      setJob(
        progressJob(
          jobId,
          userText,
          inputUrl,
          memoryForJob,
          plan,
          "completed",
          100,
          "Broad scan finished, but it did not find promising event windows.",
          predictions.length,
        ),
      );
      return;
    }

    const eventAnalyses: BrowserEventAnalysis[] = [];
    setJob(
      progressJob(
        jobId,
        userText,
        inputUrl,
        memoryForJob,
        plan,
        "reviewing",
        52,
        `Found ${candidateWindows.length} candidate windows. Sending the first contact sheet to the unified analyzer.`,
        predictions.length,
      ),
    );
    for (let index = 0; index < candidateWindows.length; index += 1) {
      const candidate = candidateWindows[index];
      setJob(
        progressJob(
          jobId,
          userText,
          inputUrl,
          memoryForJob,
          plan,
          "reviewing",
          52 + Math.round((index / Math.max(candidateWindows.length, 1)) * 20),
          `Temporal review ${index + 1}/${candidateWindows.length}: sending action window to the unified analyzer.`,
          predictions.length,
        ),
      );
      const contactSheet = await buildContactSheet(video, candidate.start, candidate.end);
      const eventPayload = await fetchJsonWithTimeout<BrowserEventAnalysis>(`${API_BASE}/api/browser/event-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: contactSheet,
          scenarios,
          user_request: check.resolved_prompt || userText,
          window_start: candidate.start,
          window_end: candidate.end,
        }),
      });
      if (eventPayload.fallback || eventPayload.error_status || temporalResultIsEmpty(eventPayload)) {
        throw new Error(
          eventPayload.reason ||
            "The unified analyzer returned empty temporal JSON. Check error_status/gemini_raw and confirm Gemini returns strict JSON.",
        );
      }
      eventAnalyses.push(eventPayload);

      const percent = 62 + Math.round((index / Math.max(candidateWindows.length - 1, 1)) * 10);
      setJob(
        progressJob(
          jobId,
          userText,
          inputUrl,
          memoryForJob,
          plan,
          "reviewing",
          percent,
          `Temporal review ${index + 1}/${candidateWindows.length}: checking action windows with the unified analyzer.`,
          predictions.length,
        ),
      );
    }
    URL.revokeObjectURL(video.src);

    let highlights = buildEventHighlights(eventAnalyses, duration, plan);
    if (!highlights.length) {
      setJob(
        progressJob(
          jobId,
          userText,
          inputUrl,
          memoryForJob,
          plan,
          "completed",
          100,
          "Temporal analysis finished, but no strong matching clips were found.",
          predictions.length,
        ),
      );
      return;
    }

    const selectedSeconds = totalHighlightSeconds(highlights);
    const plannedJob: JobPayload = {
      ...progressJob(
        jobId,
        userText,
        inputUrl,
        memoryForJob,
        plan,
        "completed",
        100,
        "Clip plan is ready. Review the timeline, then press Render.",
        predictions.length,
        highlights.map((clip) => ({ ...clip, preview_url: inputUrl })),
      ),
      report:
        `Browser Video Shorts Report\n\n` +
        `The original ${formatBytes(fileToProcess.size)} video stayed in this browser. ` +
        `${predictions.length} small frame samples and ${eventAnalyses.length} contact sheets were sent to the backend for scoring.\n\n` +
        `Selected ${highlights.length} clips totaling ${selectedSeconds.toFixed(1)} seconds.\n` +
        `No video has been rendered yet. Press Render when the timeline looks right, then Export.\n`,
    };
    setHoverPreview(null);
    setLockedPreview(null);
    setJob(plannedJob);
    void syncManualState(plannedJob);
  }

  async function submitJob(event: FormEvent) {
    event.preventDefault();
    if (isSubmitting) return;

    const userText = prompt.trim();
    if (!userText) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: "Tell me what you want from this edit first: length, style, and what to keep or skip.",
        },
      ]);
      return;
    }

    const hasVideo = Boolean(file || job?.files.input);
    const combinedPrompt = [conversationBrief, userText].filter(Boolean).join("\n\nFollow-up request:\n");
    setIsSubmitting(true);
    setMessages((current) => [
      ...current,
      { role: "user", content: userText },
    ]);

    try {
      const checkResponse = await fetch(`${API_BASE}/api/agent/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: combinedPrompt,
          job_id: job?.job_id,
          has_video: hasVideo,
          memory,
        }),
      });
      if (!checkResponse.ok) {
        throw new Error(await checkResponse.text());
      }
      const check = (await checkResponse.json()) as AgentCheck;
      setMemory(check.memory ?? {});
      setConversationBrief(combinedPrompt);

      if (!check.ready) {
        setMessages((current) => [...current, { role: "assistant", content: check.message }]);
        setPrompt("");
        return;
      }

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            check.message ||
            (job && !file
              ? "Good. I am re-editing from the saved video analysis now, so this should be much faster."
              : "Good. I am analyzing this video once and saving the index for future edits."),
        },
      ]);

      if (file) {
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            content:
              `I will keep the ${formatBytes(file.size)} video in your browser, send only small frame samples for scoring, and render the short locally.`,
          },
        ]);
        await runBrowserWorkflow(file, userText, check);
      } else if (job) {
        if (isBrowserJobId(job.job_id)) {
          setMessages((current) => [
            ...current,
            {
              role: "assistant",
              content:
                "This edit was created in your browser, so I need the original source video selected here before I can re-edit or render it again.",
            },
          ]);
          return;
        }
        const response = await fetch(`${API_BASE}/api/jobs/${job.job_id}/edits`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: check.resolved_prompt,
            memory: check.memory ?? {},
            plan: check.plan ?? {},
          }),
        });
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response));
        }
        setJob((await response.json()) as JobPayload);
      }
      setPrompt("");
    } catch (error) {
      setJob((current) =>
        current?.status === "running"
          ? {
              ...current,
              status: "failed",
              progress: {
                stage: "failed",
                percent: progressFromLog(current),
                message:
                  error instanceof Error
                    ? error.message
                    : "The edit failed before a clip plan could be created.",
              },
            }
          : current,
      );
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            error instanceof Error
              ? `I could not start that edit: ${error.message}`
              : "I could not start that edit.",
        },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function exportShort() {
    if (!job) return;
    const browserOutput = job.files.vertical || job.files.horizontal;
    if (browserOutput?.startsWith("blob:")) {
      const link = document.createElement("a");
      link.href = browserOutput;
      link.download = "browser-short.webm";
      link.click();
      return;
    }
    if (isBrowserJobId(job.job_id)) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            "There is no rendered browser output yet. Shorten the selected clips and press Render, or use a local/server FFmpeg export for long heavy videos.",
        },
      ]);
      return;
    }
    const response = await fetch(`${API_BASE}/api/jobs/${job.job_id}/export`, {
      method: "POST",
    });
    if (response.ok) {
      const payload = (await response.json()) as JobPayload;
      setJob(payload);
      const vertical = absoluteUrl(payload.files.vertical);
      if (vertical) window.open(vertical, "_blank");
    }
  }

  return (
    <main className="editor-shell">
      <section className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <p className="eyebrow">Universal Video Shorts Editor</p>
            <h1>Shorts Studio</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="utility-button" type="button" onClick={startNewChat}>
            <Plus size={15} />
            New Chat
          </button>
          <div className="metric-pill">
            <FileVideo size={15} />
            <span>{job?.predictions_count ?? 0} samples</span>
          </div>
          <div className="metric-pill">
            <Clock3 size={15} />
            <span>{selectedDuration ? `${selectedDuration.toFixed(0)}s selected` : "No cut yet"}</span>
          </div>
          <div className={`status-pill ${job?.status ?? "created"}`}>
            {job?.status === "running" && <Loader2 size={16} className="spin" />}
            {job?.status === "completed" && <CheckCircle2 size={16} />}
            {statusLabel(job?.status)}
          </div>
        </div>
      </section>

      <section className="studio-layout">
        <aside className="project-rail">
          <div className="rail-card upload-card">
            <div className="rail-card-header">
              <Upload size={16} />
              <span>Source</span>
            </div>
            <label className="upload-zone">
              <span className="upload-icon"><Upload size={18} /></span>
              <span>{activeFileName}</span>
              <input
                type="file"
                accept="video/*"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setHoverPreview(null);
                  setLockedPreview(null);
                }}
              />
            </label>
          </div>

          <div className="rail-card progress-card">
            <div className="rail-card-header">
              <Gauge size={16} />
              <span>Progress</span>
            </div>
            <div className="progress-number">{progress}%</div>
            <div className="meter-track">
              <div style={{ width: `${progress}%` }} />
            </div>
            <p className="progress-message">{job?.progress?.message || job?.progress?.stage || "Ready"}</p>
          </div>

          <div className="rail-card memory-panel">
            <div className="rail-card-header">
              <Layers size={16} />
              <span>Memory</span>
            </div>
            <div className="memory-tags">
              {memory.duration_seconds && <span>{memory.duration_seconds}s</span>}
              {(job?.edit_plan?.export_format || memory.format) && <span>{job?.edit_plan?.export_format || memory.format}</span>}
              {job?.edit_plan?.planner_source && <span>{job.edit_plan.planner_source}</span>}
              {job?.clip_review && (
                <span>{job.clip_review.approved_for_render ? "review passed" : "review warning"}</span>
              )}
              {(memory.styles ?? []).map((item) => <span key={`style-${item}`}>{item}</span>)}
              {(memory.keep ?? []).slice(0, 4).map((item) => <span key={`keep-${item}`}>keep {item}</span>)}
              {(memory.skip ?? []).slice(0, 3).map((item) => <span key={`skip-${item}`}>skip {item}</span>)}
              {!memory.duration_seconds && !memory.format && !(memory.styles?.length) && !(memory.keep?.length) && !(memory.skip?.length) && (
                <span>waiting</span>
              )}
            </div>
          </div>

          <div className="rail-card history-panel">
            <div className="rail-card-header">
              <div className="history-title">
                <History size={16} />
                <span>History</span>
              </div>
              <button className="mini-text-button" type="button" onClick={clearHistory}>
                Clear
              </button>
            </div>
            <div className="history-list">
              {sessions.map((session) => (
                <div
                  className={`history-item ${session.id === activeSessionId ? "active" : ""}`}
                  key={session.id}
                >
                  <button className="history-select" type="button" onClick={() => restoreSession(session)}>
                    <span>{session.title}</span>
                    <small>{session.memory.duration_seconds ? `${session.memory.duration_seconds}s` : "local"}</small>
                  </button>
                  <button
                    className="history-delete"
                    type="button"
                    aria-label={`Delete ${session.title}`}
                    onClick={() => deleteSession(session.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <section className="editor-stage">
          <div className="stage-card">
            <div className="stage-toolbar">
              <div>
                <span className="panel-kicker">Output</span>
                <h2>Preview</h2>
              </div>
              <div className="stage-actions">
                <button className="icon-button" type="button" aria-label="Open clip list" onClick={() => setTimelineOpen(true)}>
                  <PanelLeft size={17} />
                </button>
                <button
                  className="utility-button compact"
                  type="button"
                  disabled={!lockedPreview && !hoverPreview}
                  onClick={() => {
                    setLockedPreview(null);
                    setHoverPreview(null);
                  }}
                >
                  <Play size={15} />
                  Full
                </button>
                <button className="utility-button compact" type="button" disabled={!file || !job?.highlights.length || isWorking} onClick={renderManualEdit}>
                  {isSubmitting ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />}
                  Render
                </button>
                <button className="utility-button compact primary" type="button" disabled={!hasRenderedOutput} onClick={exportShort}>
                  <Download size={15} />
                  Export
                </button>
              </div>
            </div>

            <div className="preview-frame stage-preview">
              {previewSource ? (
                <video
                  ref={previewVideoRef}
                  key={`${previewSource}-${activePreview?.start ?? "full"}-${activePreview?.end ?? "full"}`}
                  src={previewSource}
                  controls
                  muted
                  loop={!activePreview?.end}
                  autoPlay
                  playsInline
                />
              ) : (
                <div className="empty-preview">
                  <Play size={32} />
                  <span>Preview</span>
                </div>
              )}
            </div>
          </div>

          <section className="timeline-workbench">
            <div className="timeline-header">
              <div>
                <span className="panel-kicker">Timeline</span>
                <h2>Manual arrangement</h2>
              </div>
              <div className="timeline-meta">
                <span>{job?.highlights.length ?? 0} clips</span>
                <span>{selectedDuration ? `${selectedDuration.toFixed(1)}s` : "0.0s"}</span>
                <span>{manualSyncLabel}</span>
              </div>
            </div>

            <div className="timeline-track" aria-label="Selected clips">
              {(job?.highlights ?? []).map((highlight, index) => (
                <article
                  className={`timeline-clip ${selectedClipIndex === index ? "active" : ""} ${draggingClipIndex === index ? "dragging" : ""}`}
                  key={clipIdentity(highlight)}
                  draggable
                  tabIndex={0}
                  onClick={() => {
                    setSelectedClipIndex(index);
                    setLockedPreview(previewForHighlight(highlight));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedClipIndex(index);
                      setLockedPreview(previewForHighlight(highlight));
                    }
                  }}
                  onDragStart={(event) => handleClipDragStart(event, index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleClipDrop(event, index)}
                  onDragEnd={() => setDraggingClipIndex(null)}
                  onMouseEnter={() => setHoverPreview(previewForHighlight(highlight))}
                  onMouseLeave={() => setHoverPreview(null)}
                  style={{ flexGrow: Math.max(1, highlight.duration) }}
                >
                  <button
                    className="resize-handle start"
                    type="button"
                    aria-label="Drag to change clip start"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => handleResizePointerDown(event, index, "start")}
                  />
                  <div className="timeline-clip-top">
                    <GripVertical size={15} />
                    <strong>#{index + 1}</strong>
                    <span>{formatTime(highlight.start)} - {formatTime(highlight.end)}</span>
                  </div>
                  <p>{highlight.title_overlay || highlight.event_label || highlight.matched_labels?.[0] || highlight.labels[0] || "clip"}</p>
                  <button
                    className="resize-handle end"
                    type="button"
                    aria-label="Drag to change clip end"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => handleResizePointerDown(event, index, "end")}
                  />
                </article>
              ))}
              {!job?.highlights?.length && (
                <div className="empty-timeline">
                  <Film size={22} />
                  <span>No clips yet</span>
                </div>
              )}
            </div>

            <div className="clip-inspector">
              <div className="inspector-title">
                <Scissors size={16} />
                <span>{selectedClip ? `Clip ${selectedClipIndex + 1}` : "Clip"}</span>
              </div>
              {selectedClip ? (
                <>
                  <div className="time-fields">
                    <label>
                      <span>Start</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={Number(selectedClip.start.toFixed(1))}
                        onChange={(event) => updateHighlightTime(selectedClipIndex, "start", event.target.value)}
                      />
                    </label>
                    <label>
                      <span>End</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={Number(selectedClip.end.toFixed(1))}
                        onChange={(event) => updateHighlightTime(selectedClipIndex, "end", event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Length</span>
                      <input type="text" value={`${selectedClip.duration.toFixed(1)}s`} readOnly />
                    </label>
                  </div>
                  <div className="nudge-grid" aria-label="Clip trim controls">
                    <button type="button" onClick={() => shiftHighlight(selectedClipIndex, -0.5)}>
                      <Minus size={14} />
                      Move
                    </button>
                    <button type="button" onClick={() => shiftHighlight(selectedClipIndex, 0.5)}>
                      <Plus size={14} />
                      Move
                    </button>
                    <button type="button" onClick={() => resizeHighlight(selectedClipIndex, "start", 0.5)}>
                      <Minus size={14} />
                      Head
                    </button>
                    <button type="button" onClick={() => resizeHighlight(selectedClipIndex, "start", -0.5)}>
                      <Plus size={14} />
                      Head
                    </button>
                    <button type="button" onClick={() => resizeHighlight(selectedClipIndex, "end", -0.5)}>
                      <Minus size={14} />
                      Tail
                    </button>
                    <button type="button" onClick={() => resizeHighlight(selectedClipIndex, "end", 0.5)}>
                      <Plus size={14} />
                      Tail
                    </button>
                  </div>
                  <div className="inspector-actions">
                    <button type="button" onClick={() => moveHighlight(selectedClipIndex, Math.max(0, selectedClipIndex - 1))}>
                      <PanelLeft size={15} />
                      Left
                    </button>
                    <button type="button" onClick={() => moveHighlight(selectedClipIndex, Math.min((job?.highlights.length ?? 1) - 1, selectedClipIndex + 1))}>
                      <PanelLeft size={15} className="flip-icon" />
                      Right
                    </button>
                    <button type="button" className="danger-button" onClick={() => removeHighlight(selectedClipIndex)}>
                      <Trash2 size={15} />
                      Remove
                    </button>
                  </div>
                  <p className="clip-reason">
                    {selectedClip.title_overlay ? `${selectedClip.title_overlay}: ` : ""}
                    {selectedClip.reason || selectedClip.labels.join(", ")}
                  </p>
                </>
              ) : (
                <p className="clip-reason">Run an edit to populate the timeline.</p>
              )}
            </div>
          </section>
        </section>

        <aside className="assistant-panel">
          <div className="panel-header compact">
            <div>
              <span className="panel-kicker">AI Editor</span>
              <h2>Chat</h2>
            </div>
            <SlidersHorizontal size={18} />
          </div>

          <div className="messages compact-messages" aria-live="polite">
            {messages.map((message, index) => (
              <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                <div className="message-icon">
                  {message.role === "assistant" ? <Wand2 size={16} /> : <MessageSquare size={16} />}
                </div>
                <p>{message.content}</p>
              </div>
            ))}
            {job?.report && (
              <div className="message assistant report-message">
                <div className="message-icon">
                  <Film size={16} />
                </div>
                <pre>{job.report}</pre>
              </div>
            )}
          </div>

          <form className="composer compact-composer" onSubmit={submitJob}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="Ask for an edit..."
            />
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
              {job && !file ? "Update" : "Run"}
            </button>
          </form>

          <div className="assistant-actions">
            <button className="timeline-button" type="button" onClick={() => setTimelineOpen(true)}>
              <ListVideo size={18} />
              <span>Clips</span>
              <strong>{job?.highlights.length ?? 0}</strong>
            </button>
            <button
              className="export-button"
              type="button"
              disabled={!hasRenderedOutput}
              onClick={exportShort}
            >
              {isWorking ? <Loader2 size={18} className="spin" /> : <Download size={18} />}
              {hasRenderedOutput ? "Export Short" : "Export Pending"}
            </button>
          </div>
        </aside>
      </section>

      {timelineOpen && (
        <div className="timeline-overlay" role="dialog" aria-modal="true" aria-labelledby="timeline-title">
          <aside className="timeline-drawer" id="timeline-drawer">
            <div className="timeline-drawer-header">
              <div>
                <span className="panel-kicker">Timeline</span>
                <h2 id="timeline-title">Highlight scenes</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Close timeline" onClick={() => setTimelineOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="timeline-summary">
              <span>{job?.highlights.length ?? 0} selected</span>
              <span>{selectedDuration ? `${selectedDuration.toFixed(0)}s total` : "No clips yet"}</span>
            </div>
            <div className="timeline-list">
              {(job?.highlights ?? []).map((highlight, index) => (
                <article
                  className={`highlight-card ${selectedClipIndex === index ? "active" : ""}`}
                  key={clipIdentity(highlight)}
                  draggable
                  tabIndex={0}
                  onClick={() => {
                    setSelectedClipIndex(index);
                    setLockedPreview(previewForHighlight(highlight));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedClipIndex(index);
                      setLockedPreview(previewForHighlight(highlight));
                    }
                  }}
                  onDragStart={(event) => handleClipDragStart(event, index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleClipDrop(event, index)}
                  onDragEnd={() => setDraggingClipIndex(null)}
                  onMouseEnter={() => setHoverPreview(previewForHighlight(highlight))}
                  onMouseLeave={() => setHoverPreview(null)}
                >
                  <div className="clip-meta">
                    <span>#{index + 1}</span>
                    <strong>
                      {formatTime(highlight.start)} - {formatTime(highlight.end)}
                    </strong>
                  </div>
                  <p>
                    {highlight.title_overlay ? `${highlight.title_overlay}: ` : ""}
                    {highlight.reason || highlight.labels.join(", ")}
                  </p>
                  {(highlight.why_not_longer || highlight.boundary_reason || highlight.transition?.type) && (
                    <div className="clip-reason">
                      {highlight.why_not_longer || highlight.boundary_reason}
                      {highlight.transition?.type && highlight.transition.type !== "cut" ? ` / ${highlight.transition.type} ${highlight.transition.duration_seconds?.toFixed(1)}s` : ""}
                    </div>
                  )}
                  <div className="clip-footer">
                    <span>{highlight.duration.toFixed(1)}s</span>
                    <span>score {highlight.score}</span>
                  </div>
                </article>
              ))}
              {!job?.highlights?.length && (
                <div className="empty-highlights">
                  <Film size={22} />
                  <span>No highlights yet</span>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
