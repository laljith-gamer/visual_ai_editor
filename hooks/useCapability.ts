"use client";

import { useEffect, useState } from "react";
import type { Capability, CapabilityTier } from "@/lib/types";

const FORCED = process.env.NEXT_PUBLIC_VISION_TIER;

function detectTier(c: Omit<Capability, "tier">): CapabilityTier {
  if (FORCED === "siglip-local") return "high";
  if (FORCED === "cloud") return "low";
  if (c.isMobile && !c.hasWebGPU) return "low";
  if (c.hasWebGPU && c.deviceMemoryGB >= 4) return "high";
  if (c.hasSharedArrayBuffer && c.hardwareConcurrency >= 4) return "mid";
  return "low";
}

export function useCapability(): Capability {
  const [cap, setCap] = useState<Capability>({
    tier: "mid",
    hasWebGPU: false,
    hasSharedArrayBuffer: false,
    deviceMemoryGB: 4,
    hardwareConcurrency: 4,
    isMobile: false
  });

  useEffect(() => {
    const ua = navigator.userAgent;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    const hasWebGPU = "gpu" in navigator;
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
    const deviceMemoryGB =
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    const hardwareConcurrency = navigator.hardwareConcurrency ?? 4;

    const partial: Omit<Capability, "tier"> = {
      hasWebGPU,
      hasSharedArrayBuffer,
      deviceMemoryGB,
      hardwareConcurrency,
      isMobile
    };
    setCap({ ...partial, tier: detectTier(partial) });
  }, []);

  return cap;
}
