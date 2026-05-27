"use client";

import { useMemo, useState } from "react";
import {
  Activity as ActivityIcon,
  X,
  Trash2,
  Bot,
  User,
  Cog,
  ChevronDown,
  ChevronRight
} from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useActivityLog, clearActivityLog } from "@/hooks/useActivityLog";
import { describeEvent, formatAgo } from "@/lib/log/summarize";
import type { ActivityActor, ActivityEvent } from "@/lib/types";
import styles from "./ActivityDrawer.module.css";

type Filter = "all" | ActivityActor;

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ActivityDrawer({ open, onClose }: Props) {
  const sessionId = useEditorStore((s) => s.sessionId);
  const events = useActivityLog(sessionId);
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered = filter === "all" ? events : events.filter((e) => e.actor === filter);
    // Newest first in the drawer (the planner gets oldest-first elsewhere).
    return [...filtered].reverse();
  }, [events, filter]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <aside className={`drawer-panel card ${styles.drawer}`}>
        <div className="card-header row gap">
          <ActivityIcon size={14} />
          <span>Activity</span>
          <span className="pill">{events.length}</span>
          <div className="spacer" />
          <button className="btn icon" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className={styles.filterRow}>
          <FilterChip current={filter} value="all" label="All" onPick={setFilter} />
          <FilterChip current={filter} value="ai" label="AI" onPick={setFilter} />
          <FilterChip current={filter} value="user" label="Manual" onPick={setFilter} />
          <FilterChip current={filter} value="system" label="System" onPick={setFilter} />
          <div className="spacer" />
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm("Clear all activity for this session?")) {
                await clearActivityLog();
              }
            }}
          >
            <Trash2 size={12} /> Clear
          </button>
        </div>

        <div className={`scroll-y ${styles.list}`}>
          {visible.length === 0 && (
            <p className="faint" style={{ padding: 16 }}>
              {filter === "all"
                ? "No activity yet. Talk to the assistant or edit a clip to start a log."
                : `No ${filter} events.`}
            </p>
          )}
          {visible.map((e) => (
            <Row
              key={e.id}
              event={e}
              expanded={expandedId === e.id}
              onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
            />
          ))}
        </div>
      </aside>
    </>
  );
}

function Row({
  event,
  expanded,
  onToggle
}: {
  event: ActivityEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = actorIcon(event.actor);
  const ago = formatAgo(Date.now() - event.ts);
  return (
    <article className={`${styles.row} ${styles[`row_${event.actor}`]}`}>
      <button className={styles.rowHead} onClick={onToggle}>
        <span className={styles.actorIcon}>
          <Icon size={12} />
        </span>
        <span className={styles.kind}>{event.kind}</span>
        <span className={styles.summary}>{describeEvent(event)}</span>
        <span className="spacer" />
        <span className={`faint mono ${styles.ago}`}>{ago}</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <pre className={styles.payload}>
          {JSON.stringify(
            { ts: new Date(event.ts).toISOString(), ...event.payload, ms: event.ms, count: event.count },
            null,
            2
          )}
        </pre>
      )}
    </article>
  );
}

function FilterChip({
  current,
  value,
  label,
  onPick
}: {
  current: Filter;
  value: Filter;
  label: string;
  onPick: (v: Filter) => void;
}) {
  return (
    <button
      type="button"
      className={`btn ${current === value ? "primary" : ""} ${styles.filterChip}`}
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );
}

function actorIcon(actor: ActivityActor) {
  if (actor === "ai") return Bot;
  if (actor === "user") return User;
  return Cog;
}
