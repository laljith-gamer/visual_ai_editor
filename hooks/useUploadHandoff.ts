"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { LIBRARY_LIMITS } from "@/lib/config";
import { setPendingUpload } from "@/lib/util/uploadHandoff";

/**
 * Single entry point used by both the hero dropzone and the file
 * picker button on the home page. Validates the file, stashes it in
 * the in-memory handoff, and navigates to /launch where the visible
 * loading sequence runs.
 *
 * Validation here is a deliberate near-mirror of ProjectRail's checks
 * so the user gets the SAME friendly errors regardless of which
 * surface they upload through. The launch page does NOT re-validate —
 * if a file made it through here it's good to go.
 */
export interface UseUploadHandoff {
  submit: (file: File) => boolean;
  error: string | null;
  clearError: () => void;
}

const MIN_BYTES = 1024; // 1 KB — anything smaller is almost certainly a bad pick.

export function useUploadHandoff(): UseUploadHandoff {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    (file: File): boolean => {
      setError(null);

      const looksLikeVideo =
        file.type.startsWith("video/") ||
        /\.(mp4|mov|m4v|webm|mkv|avi|qt)$/i.test(file.name);
      if (!looksLikeVideo) {
        setError("That doesn't look like a video. Try MP4, MOV, or WebM.");
        return false;
      }
      if (file.size < MIN_BYTES) {
        setError("That file is empty. Pick another video.");
        return false;
      }
      if (file.size > LIBRARY_LIMITS.maxSingleBytes) {
        const cap = Math.round(LIBRARY_LIMITS.maxSingleBytes / 1024 / 1024);
        setError(
          `Too large — max is ${cap} MB. Try a shorter clip or a lower-res export.`
        );
        return false;
      }

      setPendingUpload(file);
      router.push("/launch");
      return true;
    },
    [router]
  );

  const clearError = useCallback(() => setError(null), []);

  return { submit, error, clearError };
}
