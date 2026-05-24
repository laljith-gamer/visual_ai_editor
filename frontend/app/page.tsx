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
const MAX_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
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

function absoluteUrl(path?: string) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
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

    if (file && file.size > MAX_DIRECT_UPLOAD_BYTES) {
      setMessages((current) => [
        ...current,
        { role: "user", content: userText },
        {
          role: "assistant",
          content:
            `This video is ${formatBytes(file.size)}, but the Vercel backend can only receive about ${formatBytes(MAX_DIRECT_UPLOAD_BYTES)} per upload. ` +
            "Trim or compress the clip first, then upload the smaller file. For full-size videos, this needs direct object storage or a non-Vercel worker backend.",
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
        const body = new FormData();
        body.append("video", file);
        body.append("prompt", check.resolved_prompt);
        body.append("memory_json", JSON.stringify(check.memory ?? {}));
        body.append("plan_json", JSON.stringify(check.plan ?? {}));
        const response = await fetch(`${API_BASE}/api/jobs`, {
          method: "POST",
          body,
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const payload = (await response.json()) as JobPayload;
        setJob(payload);
        setFile(null);
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
