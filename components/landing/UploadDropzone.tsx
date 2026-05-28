"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  FileVideo,
  Sparkles,
  UploadCloud
} from "lucide-react";
import { useUploadHandoff } from "@/hooks/useUploadHandoff";
import styles from "./UploadDropzone.module.css";

/**
 * The primary call-to-action on the home page. Three interactions:
 *   1. Click the surface (or the button) → opens the OS file picker.
 *   2. Drag a video over the page → the dropzone glows + scales.
 *   3. Drop a file → submit() validates and routes to /launch.
 *
 * The page-wide drag detection (`dragenter` on document) means the
 * user doesn't need to aim for the box — anywhere over the hero
 * works as a drop target while a drag is in progress, which matches
 * the behaviour of macOS Finder and most modern web editors.
 */
export function UploadDropzone() {
  const { submit, error, clearError } = useUploadHandoff();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Page-level dragenter/leave/drop tracking. We can't rely on the
  // dropzone's own dragleave because moving over a child element
  // fires leave events spuriously. A drag depth counter on document
  // is the reliable pattern.
  useEffect(() => {
    let depth = 0;
    function isFileDrag(e: DragEvent): boolean {
      const t = e.dataTransfer?.types;
      return !!t && Array.from(t).includes("Files");
    }
    function onEnter(e: DragEvent) {
      if (!isFileDrag(e)) return;
      depth += 1;
      setDragOver(true);
    }
    function onLeave(e: DragEvent) {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    }
    function onDrop() {
      depth = 0;
      setDragOver(false);
    }
    function onOver(e: DragEvent) {
      if (isFileDrag(e)) e.preventDefault(); // allow drop
    }
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragover", onOver);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", onOver);
    };
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) submit(file);
    },
    [submit]
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) submit(file);
      // Reset so picking the same file twice still fires `change`.
      e.currentTarget.value = "";
    },
    [submit]
  );

  return (
    <div
      className={`${styles.zone} ${dragOver ? styles.dragOver : ""} ${
        error ? styles.hasError : ""
      }`}
      onClick={() => inputRef.current?.click()}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      aria-label="Upload a video"
    >
      {/* Animated glow ring around the box, only when a file is being
          dragged over the page. Pure CSS via .dragOver state. */}
      <div className={styles.glow} aria-hidden />

      <div className={styles.inner}>
        <div className={styles.iconStack} aria-hidden>
          <span className={styles.iconBack}>
            <FileVideo size={28} />
          </span>
          <span className={styles.iconFront}>
            <UploadCloud size={32} />
          </span>
        </div>

        <h2 className={styles.title}>
          {dragOver ? "Drop it anywhere" : "Drop a video to start"}
        </h2>
        <p className={styles.hint}>
          MP4, MOV, WebM. Up to 800 MB. The file never leaves your device.
        </p>

        <button
          type="button"
          className={styles.cta}
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
        >
          <Sparkles size={14} aria-hidden />
          Choose video
        </button>

        <p className={styles.smallPrint}>
          or paste a video URL in the editor after you skip
        </p>

        {error && (
          <div className={styles.errorBox} role="alert">
            <AlertCircle size={14} aria-hidden />
            <span>{error}</span>
            <button
              type="button"
              className={styles.errorDismiss}
              onClick={(e) => {
                e.stopPropagation();
                clearError();
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={onPick}
      />
    </div>
  );
}
