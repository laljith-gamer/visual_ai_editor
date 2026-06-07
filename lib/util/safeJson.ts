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
    // We reached the end of the string with depth > 0: the JSON object was
    // truncated mid-structure (e.g. the model hit its output-token limit).
    // Try to SALVAGE it by closing whatever is still open. This only runs
    // after strict + balanced parsing have already failed, so it can never
    // change a previously-successful parse — it only rescues truncated ones.
    return salvageTruncated<T>(candidate.slice(start));
  }
}

/**
 * Best-effort repair of a JSON object string that was cut off before it
 * finished (e.g. the model hit its output-token limit mid-structure).
 *
 * Strategy: walk the text with a small state machine that knows, at every
 * point, (a) whether the structure is currently "closable" — i.e. not in the
 * middle of a string, number, object key, or a key awaiting its value — and
 * (b) exactly which closing brackets would balance it. Each time we reach a
 * closable rest point we snapshot that position and its closer string. At the
 * end we keep the text up to the last safe point, drop a dangling comma, and
 * append the snapshotted closers.
 *
 * This is conservative: it preserves every COMPLETE key/value already present
 * (so a truncated briefing still yields its overview and the best parts that
 * did arrive) and discards only the incomplete tail. It only runs after strict
 * parsing has already failed, so it can never alter a valid parse.
 */
interface Frame {
  kind: "{" | "[";
  /** For objects: where we are in the key:value cycle. */
  oexpect?: "key" | "colon" | "value" | "comma";
}

function salvageTruncated<T = unknown>(text: string): T | null {
  const frames: Frame[] = [];
  let inString = false;
  let escape = false;
  let lastSafe = -1;
  let lastClosers = "";

  const top = (): Frame | undefined => frames[frames.length - 1];

  // Closable only depends on the INNERMOST frame: closing a nested
  // container supplies the value for any outer object that was awaiting
  // one. An object is unclosable only while it is mid key:value — i.e.
  // it has emitted a key (and maybe a colon) but not yet its value.
  const closable = (): boolean => {
    const t = top();
    if (!t) return false;
    if (t.kind === "[") return true;
    return t.oexpect === "key" || t.oexpect === "comma";
  };

  const mark = (i: number): void => {
    if (inString || !closable()) return;
    lastSafe = i;
    let closers = "";
    for (let k = frames.length - 1; k >= 0; k--) {
      closers += frames[k].kind === "{" ? "}" : "]";
    }
    lastClosers = closers;
  };

  /** A value just completed in the current container. */
  const valueComplete = (i: number): void => {
    const t = top();
    if (t && t.kind === "{") t.oexpect = "comma";
    mark(i);
  };

  const literalChar = /[0-9eE+.\-tfuln]/;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') {
        inString = false;
        const t = top();
        if (t && t.kind === "{") {
          if (t.oexpect === "value") valueComplete(i); // value string done
          else t.oexpect = "colon"; // it was the key
        } else {
          valueComplete(i); // array element string
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      frames.push(ch === "{" ? { kind: "{", oexpect: "key" } : { kind: "[" });
      mark(i); // empty container is itself closable
    } else if (ch === "}" || ch === "]") {
      frames.pop();
      valueComplete(i); // the closed container is a value in its parent
    } else if (ch === ":") {
      const t = top();
      if (t && t.kind === "{") t.oexpect = "value";
    } else if (ch === ",") {
      const t = top();
      if (t && t.kind === "{") t.oexpect = "key";
      mark(i);
    } else if (literalChar.test(ch)) {
      // Scan the whole bare literal (number / true / false / null).
      let j = i;
      while (j + 1 < text.length && literalChar.test(text[j + 1])) j++;
      const atEnd = j === text.length - 1;
      i = j;
      // If the literal runs to the very end it may be truncated — don't
      // trust it. Otherwise it's complete and terminates a value.
      if (!atEnd) valueComplete(j);
    }
    // whitespace and anything else: ignore
  }

  if (frames.length === 0 || lastSafe < 0) return null;

  const core = text.slice(0, lastSafe + 1).replace(/,\s*$/, "") + lastClosers;
  try {
    return JSON.parse(core) as T;
  } catch {
    return null;
  }
}
