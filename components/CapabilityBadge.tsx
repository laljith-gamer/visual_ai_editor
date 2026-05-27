"use client";

import { Cpu, Cloud } from "lucide-react";
import { useCapability } from "@/hooks/useCapability";

export function CapabilityBadge() {
  const cap = useCapability();
  const label = cap.tier === "high" ? "Local AI" : cap.tier === "mid" ? "Hybrid AI" : "Cloud AI";
  const Icon = cap.tier === "high" ? Cpu : Cloud;
  const className = cap.tier === "high" ? "pill accent" : cap.tier === "mid" ? "pill info" : "pill";

  return (
    <span
      className={className}
      title={`tier=${cap.tier}, webgpu=${cap.hasWebGPU}, mem=${cap.deviceMemoryGB}GB`}
    >
      <Icon size={12} /> {label}
    </span>
  );
}
