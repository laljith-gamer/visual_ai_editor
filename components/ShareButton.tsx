"use client";

import { Share2 } from "lucide-react";
import { useShare } from "@/hooks/useShare";

interface Props {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string;
  variant?: "primary" | "default";
}

export function ShareButton({ blob, filename, title, text, variant = "default" }: Props) {
  const share = useShare();
  return (
    <button
      className={`btn ${variant === "primary" ? "primary" : ""}`}
      onClick={() => void share({ blob, filename, title, text })}
    >
      <Share2 size={14} /> Share
    </button>
  );
}
