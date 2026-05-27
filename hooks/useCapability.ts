"use client";

import { useEffect, useState } from "react";
import type { Capability, CapabilityTier } from "@/lib/types";
import { CAPABILITY } from "@/lib/config";

const FORCED = process.env.NEXT_PUBLIC_VISION_TIER;

function detectTier(c: Omit<Capability, "tier">): CapabilityTier {
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

export function useCapability(): Capability {
  const [cap, setCap] = useState<Capability>({
    tier: "mid",
    hasWebGPU: false,
    hasSharedArrayBuffer: false,
    deviceMemoryGB: CAPABILITY.highTierMinDeviceMemoryGB,
    hardwareConcurrency: CAPABILITY.midTierMinHardwareConcurrency,
    isMobile: false
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
