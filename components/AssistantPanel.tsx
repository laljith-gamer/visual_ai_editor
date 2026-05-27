"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Film, Download } from "lucide-react";
import { useEditorStore } from "@/hooks/useEditorStore";
import { useShare } from "@/hooks/useShare";
import { CapabilityBadge } from "./CapabilityBadge";
import styles from "./AssistantPanel.module.css";

interface Props {
  onSubmit: (text: string) => Promise<void>;
  onOpenClips: () => void;
  isBusy: boolean;
}

export function AssistantPanel({ onSubmit, onOpenClips, isBusy }: Props) {
  const messages = useEditorStore((s) => s.messages);
  const renderedBlob = useEditorStore((s) => s.renderedBlob);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const share = useShare();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    setText("");
    await onSubmit(trimmed);
  }

  return (
    <aside className={`assistant ${styles.panel}`}>
      <div className={styles.header}>
        <div>
          <p className="eyebrow">AI editor</p>
          <h2 style={{ margin: 0 }}>Chat</h2>
        </div>
        <CapabilityBadge />
      </div>

      <div ref={scrollRef} className={`${styles.messages} scroll-y`}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`${styles.message} ${m.role === "user" ? styles.user : styles.assistant}`}
          >
            <div className={styles.bubble}>{m.content}</div>
          </div>
        ))}
      </div>

      <div className={styles.composer}>
        <textarea
          className="textarea"
          placeholder="Describe the short you want…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        <button
          className="btn primary"
          onClick={() => void send()}
          disabled={isBusy || !text.trim()}
        >
          <Send size={14} /> {isBusy ? "Working…" : "Run"}
        </button>
      </div>

      <div className={styles.actions}>
        <button className="btn" onClick={onOpenClips}>
          <Film size={14} /> Clips
        </button>
        <div className="spacer" />
        {renderedBlob && (
          <button
            className="btn"
            onClick={() =>
              void share({
                blob: renderedBlob,
                filename: "shorts-studio.mp4",
                title: "Shorts Studio export"
              })
            }
          >
            <Download size={14} /> Export Short
          </button>
        )}
      </div>
    </aside>
  );
}
