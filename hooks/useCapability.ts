"use client";

import { useEffect, useState } from "react";
import type { AudioTier, Capability, CapabilityTier } from "@/lib/types";
import { CAPABILITY } from "@/lib/config";
import { isTranscriptionSupported } from "@/lib/audio/transcribe";

const FORCED = process.env.NEXT_PUBLIC_VISION_TIER;
const FORCED_AUDIO = process.env.NEXT_PUBLIC_AUDIO_TIER;

function detectTier(c: Omit<Capability, "tier" | "audioTier">): CapabilityTier {
  if (FORCED === "siglip-local") return "high";
  if (FORCED === "cloud") return "low";
  if (c.isMobile && !c.hasWebGPU) return "low";
  if (c.hasWebGPU && c.deviceMemoryGB >= CAPABILITY.highTierMinDeviceMemoryGB) {
    return "high";
  }
  if (
    c.hasSharedArrayBuffer &&
    c.hardwareConcurrency >= CAPABILITY.midTierMinHardwareConcurrency
  ) {
    return "mid";
  }
  return "low";
}

/** v1.7.3 — Pick an audio tier independently of the vision tier.
 *  Whisper is more memory-tolerant than SigLIP (smaller weights at the
 *  tiny size) so we can run mid-tier ASR on devices that only earn a
 *  low-tier vision rating. The high tier (whisper-base) is gated to
 *  WebGPU + ≥ 6 GB RAM to keep desktops with iGPU but limited VRAM
 *  out of trouble. */
function detectAudioTier(
  c: Omit<Capability, "tier" | "audioTier">
): AudioTier {
  if (FORCED_AUDIO === "off") return "off";
  if (FORCED_AUDIO === "high") return "high";
  if (FORCED_AUDIO === "mid") return "mid";
  if (FORCED_AUDIO === "low") return "low";
  if (!isTranscriptionSupported()) return "off";
  if (c.hasWebGPU && c.deviceMemoryGB >= CAPABILITY.highTierMinDeviceMemoryGB) {
    return "high";
  }
  if (
    c.hasSharedArrayBuffer &&
    c.hardwareConcurrency >= CAPABILITY.midTierMinHardwareConcurrency
  ) {
    return "mid";
  }
  return "low";
}

export function useCapability(): Capability {
  const [cap, setCap] = useState<Capability>({
    tier: "mid",
    hasWebGPU: false,
    hasSharedArrayBuffer: false,
    deviceMemoryGB: CAPABILITY.highTierMinDeviceMemoryGB,
    hardwareConcurrency: CAPABILITY.midTierMinHardwareConcurrency,
    isMobile: false,
    audioTier: "mid"
  });

  useEffect(() => {
    const ua = navigator.userAgent;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const hasWebGPU = "gpu" in navigator;
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
    const deviceMemoryGB =
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
      CAPABILITY.highTierMinDeviceMemoryGB;
    const hardwareConcurrency =
      navigator.hardwareConcurrency ?? CAPABILITY.midTierMinHardwareConcurrency;

    const partial: Omit<Capability, "tier" | "audioTier"> = {
      hasWebGPU,
      hasSharedArrayBuffer,
      deviceMemoryGB,
      hardwareConcurrency,
      isMobile
    };
    setCap({
      ...partial,
      tier: detectTier(partial),
      audioTier: detectAudioTier(partial)
    });
  }, []);

  return cap;
}
