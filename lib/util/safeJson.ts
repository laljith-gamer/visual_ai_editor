/**
 * Robustly extract the first JSON object from a string that may contain
 * code fences, leading prose, or trailing commentary.
 */
export function extractJsonObject<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  // Strip ```json ... ``` fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();

  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Find the first balanced { ... }
    const start = candidate.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1)) as T;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}
