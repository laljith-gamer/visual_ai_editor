// =====================================================================
// lib/video-memory/query.ts
//
// Fast local retrieval helpers for video-tree memory. These are intentionally
// deterministic and cheap: lexical/tag scoring now, embedding rerank later.
// =====================================================================

import type {
  RankedVideoMemoryNode,
  VideoMemoryIndex,
  VideoMemoryNode,
  VideoMemoryQueryOptions
} from "@/lib/video-memory/types";

const DEFAULT_LIMIT = 8;

export function rankVideoMemoryNodes(
  index: VideoMemoryIndex,
  query: string,
  options: VideoMemoryQueryOptions = {}
): RankedVideoMemoryNode[] {
  const terms = tokenize(query);
  const allowed = options.includeKinds ? new Set(options.includeKinds) : null;
  const minConfidence = options.minConfidence ?? 0;

  return Object.values(index.nodes)
    .filter((node) => !allowed || allowed.has(node.kind))
    .filter((node) => node.confidence >= minConfidence)
    .map((node) => scoreNode(node, terms))
    .filter((ranked) => ranked.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || a.node.start - b.node.start)
    .slice(0, Math.max(1, options.limit ?? DEFAULT_LIMIT));
}

export function getNodePath(
  index: VideoMemoryIndex,
  nodeId: string
): VideoMemoryNode[] {
  const path: VideoMemoryNode[] = [];
  let current = index.nodes[nodeId];
  while (current) {
    path.unshift(current);
    current = current.parentId ? index.nodes[current.parentId] : undefined;
  }
  return path;
}

export function compactVideoMemoryForPlanner(
  index: VideoMemoryIndex,
  query = "",
  options: VideoMemoryQueryOptions = {}
): string {
  const ranked = rankVideoMemoryNodes(index, query, {
    limit: options.limit ?? DEFAULT_LIMIT,
    includeKinds: options.includeKinds ?? ["chapter", "scene", "shot"],
    minConfidence: options.minConfidence
  });

  const lines = [
    `Video memory: ${index.videoName ?? index.videoHash.slice(0, 12)} (${formatTime(0)}-${formatTime(index.duration)})`,
    `Tree: ${index.stats.chapterCount} chapters, ${index.stats.sceneCount} scenes, ${index.stats.shotCount} shots`,
    "Relevant nodes:"
  ];

  for (const { node, score, reasons } of ranked) {
    lines.push(
      `- ${node.id} [${node.kind}] ${formatTime(node.start)}-${formatTime(node.end)} score=${round2(score)} tags=${node.tags.join(",") || "none"} summary=${node.summary}${reasons.length > 0 ? ` reasons=${reasons.join(",")}` : ""}`
    );
  }

  return lines.join("\n");
}

function scoreNode(node: VideoMemoryNode, terms: string[]): RankedVideoMemoryNode {
  let score = 0;
  const reasons: string[] = [];
  const summaryTokens = new Set(tokenize(node.summary));
  const tagTokens = new Set(node.tags.flatMap(tokenize));

  if (terms.length === 0) {
    score += node.kind === "chapter" ? 0.3 : node.kind === "scene" ? 0.25 : 0.1;
    if ((node.scores.peakMotion ?? 0) > 0.5) score += 0.2;
    if ((node.scores.meanSaliency ?? 0) > 0.5) score += 0.2;
  }

  for (const term of terms) {
    if (tagTokens.has(term)) {
      score += 2;
      reasons.push(`tag:${term}`);
    }
    if (summaryTokens.has(term)) {
      score += 1;
      reasons.push(`summary:${term}`);
    }
  }

  const motion = node.scores.peakMotion ?? node.scores.meanMotion ?? 0;
  const saliency = node.scores.meanSaliency ?? 0;
  score += motion * 0.35 + saliency * 0.25 + node.confidence * 0.2;

  const acceptedBoost = node.feedback.acceptedClipCount * 0.25;
  const rejectedPenalty = node.feedback.rejectedClipCount * 0.25;
  score += acceptedBoost - rejectedPenalty;
  if (acceptedBoost > 0) reasons.push("accepted-before");
  if (rejectedPenalty > 0) reasons.push("rejected-before");

  return { node, score: round2(Math.max(0, score)), reasons: unique(reasons) };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
