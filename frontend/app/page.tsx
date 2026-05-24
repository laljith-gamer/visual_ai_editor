"use client";

import {
  CheckCircle2,
  Clock3,
  Download,
  Film,
  FileVideo,
  History,
  Loader2,
  ListVideo,
  MessageSquare,
  PanelRight,
  Play,
  Plus,
  Send,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const SESSION_STORAGE_KEY = "visual_ai_editor.sessions.v1";
const ACTIVE_SESSION_KEY = "visual_ai_editor.active_session.v1";
const MAX_LOCAL_SESSIONS = 12;
const MAX_BROWSER_SAMPLES = 120;
const FRAME_BATCH_SIZE = 4;
const INITIAL_ASSISTANT_MESSAGE =
  "Upload any video and tell me what kind of short you want. If details are missing, I'll ask before spending time on analysis.";

type Highlight = {
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

type CapturedFrame = {
  second: number;
  frame: number;
  image: string;
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

function buildBrowserHighlights(predictions: BrowserPrediction[], duration: number, plan?: EditPlan): Highlight[] {
  const weights = plan?.label_weights ?? {};
  const strategy = plan?.selection_strategy ?? {};
  const targetSeconds = Number(plan?.target_short_seconds || 30);
  const minClip = Number(strategy.minimum_clip_seconds || 4);
  const maxClip = Number(strategy.maximum_clip_seconds || 45);
  const before = Number(strategy.context_before_seconds || 1);
  const after = Number(strategy.context_after_seconds || 1.5);
  const sorted = [...predictions]
    .map((item) => ({ ...item, score: predictionScore(item, weights) }))
    .sort((left, right) => left.second - right.second);

  const useful = sorted.filter((item) => !labelIsLowValue(item.scene, weights) && item.score > 0.1);
  if (!useful.length) return [];

  const sampleGap = Math.max(2, sorted[1] ? sorted[1].second - sorted[0].second : 2);
  const boundaryGap = Math.max(sampleGap * 2.5, 3);
  const events: BrowserPrediction[][] = [];
  let current: BrowserPrediction[] = [];

  for (const item of useful) {
    const previous = current.at(-1);
    if (previous && item.second - previous.second > boundaryGap) {
      events.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) events.push(current);

  const candidates: Highlight[] = [];
  for (const event of events) {
    const eventStart = Math.max(0, Math.min(...event.map((item) => item.second)) - before);
    const eventEnd = Math.min(duration, Math.max(...event.map((item) => item.second)) + sampleGap + after);
    let cursor = eventStart;
    while (cursor < eventEnd) {
      let end = Math.min(eventEnd, cursor + maxClip);
      if (end - cursor < minClip) end = Math.min(duration, cursor + minClip);
      const inside = event.filter((item) => item.second >= cursor && item.second < end);
      if (!inside.length) break;
      const labels = [...new Set(inside.map((item) => item.scene).filter(Boolean) as string[])].slice(0, 4);
      const score =
        inside.reduce((total, item) => total + predictionScore(item, weights), 0) / Math.max(inside.length, 1);
      candidates.push({
        index: candidates.length + 1,
        start: cursor,
        end,
        duration: end - cursor,
        score: Number(score.toFixed(4)),
        labels,
        matched_labels: labels.slice(0, 3),
        reason: `Kept because ${labels[0] ?? "this moment"} matched the edit request near ${formatTime(inside[0].second)}.`,
        why_not_longer: "Bounded by nearby low-value samples or the requested target length.",
        transition: { type: candidates.length ? "fade" : "cut", duration_seconds: candidates.length ? 0.3 : 0 },
      });
      cursor = end;
    }
  }

  const selected: Highlight[] = [];
  let total = 0;
  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    if (total >= targetSeconds) break;
    if (selected.some((clip) => candidate.start < clip.end && candidate.end > clip.start)) continue;
    const remaining = targetSeconds - total;
    const clip = { ...candidate };
    if (clip.duration > remaining && remaining >= minClip) {
      clip.end = clip.start + remaining;
      clip.duration = remaining;
      clip.why_not_longer = "Trimmed to match the requested final duration.";
    } else if (clip.duration > remaining && selected.length) {
      continue;
    }
    selected.push(clip);
    total += clip.duration;
  }

  return selected
    .sort((left, right) => left.start - right.start)
    .map((clip, index) => ({
      ...clip,
      index: index + 1,
      score: Number(clip.score.toFixed(4)),
      transition: { type: index ? "fade" : "cut", duration_seconds: index ? 0.3 : 0 },
    }));
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

async function captureFrame(video: HTMLVideoElement, second: number, frame: number): Promise<CapturedFrame> {
  await seekVideo(video, second);
  await delay(30);
  const canvas = document.createElement("canvas");
  const targetWidth = 512;
  canvas.width = targetWidth;
  canvas.height = Math.max(288, Math.round((video.videoHeight / video.videoWidth) * targetWidth));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available in this browser.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = canvas.toDataURL("image/jpeg", 0.72).split(",", 2)[1];
  return { second, frame, image };
}

async function renderBrowserShort(file: File, highlights: Highlight[], format: string | undefined) {
  const video = await loadVideoElement(file);
  video.muted = false;
  const vertical = format !== "horizontal";
  const width = vertical ? 720 : 1280;
  const height = vertical ? 1280 : 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available in this browser.");

  const stream = canvas.captureStream(30);
  const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
  if (capture) {
    try {
      capture.call(video)
        .getAudioTracks()
        .forEach((track) => stream.addTrack(track));
    } catch {
      // Browser audio capture is best-effort; silent export is still useful.
    }
  }

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start(1000);

  for (const clip of highlights) {
    await seekVideo(video, clip.start);
    await video.play();
    await new Promise<void>((resolve) => {
      const draw = () => {
        const remainingStart = Math.max(0, video.currentTime - clip.start);
        const remainingEnd = Math.max(0, clip.end - video.currentTime);
        const fade = Math.max(0, 1 - remainingStart / 0.3, 1 - remainingEnd / 0.3);
        drawCoverFrame(context, video, width, height, fade);
        if (video.currentTime >= clip.end || video.ended) {
          video.pause();
          resolve();
          return;
        }
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    });
  }

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
  const [activePreview, setActivePreview] = useState("");
  const [memory, setMemory] = useState<EditorMemory>({});
  const [conversationBrief, setConversationBrief] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages());

  const progress = useMemo(() => progressFromLog(job ?? undefined), [job]);
  const previewSource =
    activePreview ||
    absoluteUrl(job?.files.vertical) ||
    absoluteUrl(job?.files.horizontal) ||
    absoluteUrl(job?.files.input) ||
    "";
  const selectedDuration = useMemo(
    () => (job?.highlights ?? []).reduce((total, item) => total + Number(item.duration || 0), 0),
    [job],
  );
  const activeFileName = file?.name ?? (job?.files.input ? "Source video loaded" : "No video selected");
  const isWorking = job?.status === "running" || isSubmitting;

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
    if (!job || job.status === "completed" || job.status === "failed") {
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
    setActivePreview("");
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
    setActivePreview("");
    setTimelineOpen(false);
    setMemory(session.memory ?? {});
    setConversationBrief(session.conversationBrief ?? "");
    setMessages(session.messages.length ? session.messages : initialMessages());
    writeStoredSessions(sessions, session.id);
  }

  async function runBrowserWorkflow(fileToProcess: File, userText: string, check: AgentCheck) {
    const jobId = `browser-${Date.now()}`;
    const inputUrl = URL.createObjectURL(fileToProcess);
    const plan = check.plan;
    const memoryForJob = check.memory ?? {};
    const scenarios = plan?.roboflow_scenarios?.length
      ? plan.roboflow_scenarios
      : [
          "player hitting enemy successfully",
          "enemy taking visible damage",
          "enemy defeated death animation",
          "boss fight major combat",
          "cinematic cutscene story",
          "exploration walking idle",
          "menu loading screen inventory",
          "static boring repeated gameplay",
          "black blank blurry frame",
        ];

    setJob(progressJob(jobId, userText, inputUrl, memoryForJob, plan, "preparing", 5, "Reading the video locally in your browser."));

    const video = await loadVideoElement(fileToProcess);
    const duration = video.duration || 0;
    const sampleEvery = Math.max(2, Math.ceil(duration / MAX_BROWSER_SAMPLES));
    const sampleTimes: number[] = [];
    for (let second = 0; second < duration; second += sampleEvery) {
      sampleTimes.push(Math.min(second, Math.max(duration - 0.1, 0)));
    }

    const predictions: BrowserPrediction[] = [];
    let frameBatch: CapturedFrame[] = [];

    for (let index = 0; index < sampleTimes.length; index += 1) {
      const frame = await captureFrame(video, sampleTimes[index], index);
      frameBatch.push(frame);

      if (frameBatch.length === FRAME_BATCH_SIZE || index === sampleTimes.length - 1) {
        const response = await fetch(`${API_BASE}/api/browser/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frames: frameBatch, scenarios }),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const payload = (await response.json()) as { predictions: BrowserPrediction[] };
        predictions.push(...(payload.predictions ?? []));
        frameBatch = [];

        const percent = 8 + Math.round((index / Math.max(sampleTimes.length - 1, 1)) * 52);
        setJob(
          progressJob(
            jobId,
            userText,
            inputUrl,
            memoryForJob,
            plan,
            "analyzing",
            percent,
            `Analyzed ${Math.min(index + 1, sampleTimes.length)}/${sampleTimes.length} browser samples.`,
            predictions.length,
          ),
        );
      }
    }
    URL.revokeObjectURL(video.src);

    const highlights = buildBrowserHighlights(predictions, duration, plan);
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
          "Analysis finished, but no strong matching clips were found.",
          predictions.length,
        ),
      );
      return;
    }

    setJob(
      progressJob(
        jobId,
        userText,
        inputUrl,
        memoryForJob,
        plan,
        "rendering",
        72,
        "Rendering selected clips locally in your browser.",
        predictions.length,
        highlights,
      ),
    );

    const outputUrl = await renderBrowserShort(fileToProcess, highlights, plan?.export_format);
    const selectedSeconds = highlights.reduce((total, clip) => total + clip.duration, 0);
    setJob({
      ...progressJob(
        jobId,
        userText,
        inputUrl,
        memoryForJob,
        plan,
        "completed",
        100,
        "Browser export completed. The output is WebM because it was rendered locally.",
        predictions.length,
        highlights.map((clip) => ({ ...clip, preview_url: inputUrl })),
        { vertical: outputUrl, horizontal: outputUrl },
      ),
      report:
        `Browser Video Shorts Report\n\n` +
        `The original ${formatBytes(fileToProcess.size)} video stayed in this browser. ` +
        `Only ${predictions.length} small frame samples were sent to the backend for scene scoring.\n\n` +
        `Selected ${highlights.length} clips totaling ${selectedSeconds.toFixed(1)} seconds.\n` +
        `Export format: browser-rendered WebM.\n`,
    });
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
          throw new Error(await response.text());
        }
        setJob((await response.json()) as JobPayload);
      }
      setPrompt("");
    } catch (error) {
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

      <section className="workspace">
        <div className="chat-column">
          <div className="panel-header">
            <div>
              <span className="panel-kicker">Prompt</span>
              <h2>Edit Brief</h2>
            </div>
            <span className="panel-meta">{memory.duration_seconds ? `${memory.duration_seconds}s target` : "Open brief"}</span>
          </div>
          <div className="messages" aria-live="polite">
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

          <form className="composer" onSubmit={submitJob}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={2}
              placeholder="Describe the edit..."
            />
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
              {job && !file ? "Re-edit" : "Run"}
            </button>
          </form>
        </div>

        <aside className="side-panel">
          <div className="panel-header compact">
            <div>
              <span className="panel-kicker">Output</span>
              <h2>Preview</h2>
            </div>
            <PanelRight size={18} />
          </div>

          <label className="upload-zone">
            <span className="upload-icon"><Upload size={18} /></span>
            <span>{activeFileName}</span>
            <input
              type="file"
              accept="video/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <div className="preview-frame">
            {previewSource ? (
              <video key={previewSource} src={previewSource} controls muted loop autoPlay playsInline />
            ) : (
              <div className="empty-preview">
                <Play size={28} />
                <span>Preview</span>
              </div>
            )}
          </div>

          <div className="meter">
            <div className="meter-row">
              <span>{job?.progress?.stage ?? `${job?.predictions_count ?? 0} samples`}</span>
              <span>{progress}%</span>
            </div>
            <div className="meter-track">
              <div style={{ width: `${progress}%` }} />
            </div>
            {job?.progress?.message && <div className="progress-message">{job.progress.message}</div>}
          </div>

          <div className="memory-panel">
            <div className="memory-title">Memory</div>
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
                <span>waiting for edit details</span>
              )}
            </div>
          </div>

          <div className="history-panel">
            <div className="history-title">
              <History size={14} />
              <span>Browser History</span>
            </div>
            <div className="history-list">
              {sessions.map((session) => (
                <button
                  className={`history-item ${session.id === activeSessionId ? "active" : ""}`}
                  type="button"
                  key={session.id}
                  onClick={() => restoreSession(session)}
                >
                  <span>{session.title}</span>
                  <small>{session.memory.duration_seconds ? `${session.memory.duration_seconds}s` : "local"}</small>
                </button>
              ))}
            </div>
          </div>

          <button
            className="timeline-button"
            type="button"
            aria-controls="timeline-drawer"
            aria-expanded={timelineOpen}
            onClick={() => setTimelineOpen(true)}
          >
            <ListVideo size={18} />
            <span>Timeline</span>
            <strong>{job?.highlights.length ?? 0}</strong>
          </button>

          <button
            className="export-button"
            type="button"
            disabled={job?.status !== "completed"}
            onClick={exportShort}
          >
            {isWorking ? <Loader2 size={18} className="spin" /> : <Download size={18} />}
            {job?.status === "completed" ? "Export Short" : "Export Pending"}
          </button>
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
              {(job?.highlights ?? []).map((highlight) => (
                <article
                  className="highlight-card"
                  key={highlight.index}
                  onClick={() => setActivePreview(absoluteUrl(highlight.preview_url))}
                  onMouseEnter={() => setActivePreview(absoluteUrl(highlight.preview_url))}
                  onMouseLeave={() => setActivePreview("")}
                >
                  <div className="clip-meta">
                    <span>#{highlight.index}</span>
                    <strong>
                      {formatTime(highlight.start)} - {formatTime(highlight.end)}
                    </strong>
                  </div>
                  <p>{highlight.reason || highlight.labels.join(", ")}</p>
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
                  <span>Highlights appear here after analysis.</span>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

    </main>
  );
}
