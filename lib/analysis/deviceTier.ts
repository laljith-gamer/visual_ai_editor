// =====================================================================
// lib/analysis/deviceTier.ts
//
// Coarse LOCAL device-capability estimate used ONLY to shift the analysis
// frame ceiling (see budget.ts). It is deliberately NOT a fingerprint: it
// reads three broad, already-exposed signals and never leaves the browser.
//
// `classifyDeviceTier` is PURE (signals in → tier out) and unit-tested.
// `detectDeviceTier` reads the browser signals and is browser-only.
// =====================================================================

import { DEVICE_TIER } from "../config";
import type { DeviceTier } from "./types";

export interface DeviceSignals {
  /** navigator.hardwareConcurrency (logical cores). */
  hardwareConcurrency?: number;
  /** navigator.deviceMemory (GB, Chromium only). */
  deviceMemoryGB?: number;
  /** Whether WebGPU is available (gpu adapter present). */
  webgpu?: boolean;
}

/**
 * Map broad capability signals to a tier. When no signal is available at all
 * we return "unknown" (the budget planner treats it as a neutral 1.0x).
 */
export function classifyDeviceTier(signals: DeviceSignals): DeviceTier {
  const { hardwareConcurrency, deviceMemoryGB, webgpu } = signals;
  const haveAny =
    typeof hardwareConcurrency === "number" ||
    typeof deviceMemoryGB === "number" ||
    typeof webgpu === "boolean";
  if (!haveAny) return "unknown";

  const cores = hardwareConcurrency ?? 0;
  const memGB = deviceMemoryGB ?? 0;

  // "high" needs the GPU AND a capable CPU/memory.
  if (
    webgpu === true &&
    (cores >= DEVICE_TIER.highTierMinHardwareConcurrency ||
      memGB >= DEVICE_TIER.highTierMinDeviceMemoryGB)
  ) {
    return "high";
  }

  // "mid" needs a reasonable CPU or memory (GPU optional).
  if (
    cores >= DEVICE_TIER.midTierMinHardwareConcurrency ||
    memGB >= DEVICE_TIER.midTierMinDeviceMemoryGB
  ) {
    return "mid";
  }

  return "low";
}

/** Read the browser's capability signals (best effort, no fingerprinting). */
export function readDeviceSignals(): DeviceSignals {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  let webgpu: boolean | undefined;
  try {
    webgpu = typeof navigator !== "undefined" && "gpu" in navigator ? true : false;
  } catch {
    webgpu = undefined;
  }
  return {
    hardwareConcurrency: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined,
    deviceMemoryGB: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    webgpu
  };
}

/** Browser entry point: detect the current device tier. */
export function detectDeviceTier(): DeviceTier {
  return classifyDeviceTier(readDeviceSignals());
}
