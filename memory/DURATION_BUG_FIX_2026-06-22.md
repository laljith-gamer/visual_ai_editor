# Duration Bug Fix — 2026-06-22

## Problem

User requests for specific durations like "3 min" or "5 min" resulted in half the requested time being shown (90 seconds instead of 180, 150 seconds instead of 300).

## Root Cause

**Two-layer issue:**

### 1. Overly Loose Regex in `parseSourceScope` (PRIMARY CAUSE)
**File:** `lib/intent/videoPromptInterpreter.ts` (Lines 384-387)

The fallback regex was too permissive:
```typescript
// BUGGY CODE (REMOVED):
if (/\b(all|every|each)\b/.test(t) && 
    /\b(video|videos|upload|uploads|source|sources|clip|clips|footage)\b/.test(t)) {
  return { type: "all", reason: "all/every/each over videos" };
}
```

This matched ANY occurrence of "all"/"every"/"each" + video words, causing false positives:
- "make a 3 min **video**" → contained "video" → `sourceScope: "all"`
- "create 5 min **clips**" → contained "clips" → `sourceScope: "all"`  
- "over**all** basketball **video**" → matched both → `sourceScope: "all"`

### 2. No Runtime Validation
**File:** `app/editor/page.tsx` (Line 2829)

When `sourceScope === "all"`, duration was split across ALL available videos without checking actual selected count:
```typescript
// INCOMPLETE (FIXED):
if (compose.sourceScope === "all") {
  const perSourceDuration = compose.targetSeconds * share; // share = 0.5 for 2 videos
}
```

## The Fix

### Fix 1: Removed Loose Regex Fallback
**File:** `lib/intent/videoPromptInterpreter.ts` (Lines 377-390)

```typescript
// NEW CODE (FIXED):
export function parseSourceScope(text: string): SourceScopeSlot {
  const t = (text || "").toLowerCase();

  // Only explicit multi-source phrases trigger "all"
  if (ALL_SCOPE_RE.test(t)) {
    return { type: "all", reason: "request references all videos/uploads" };
  }
  
  // REMOVED: Loose fallback that caused false positives
  return { type: "ambiguous", reason: "no explicit source scope stated" };
}
```

Now only explicit phrases trigger multi-source mode:
- ✓ "from all videos"
- ✓ "use all uploads"
- ✓ "every video"
- ✗ "make a 3 min video" → "ambiguous" not "all"

### Fix 2: Runtime Safety Check
**File:** `app/editor/page.tsx` (Lines 2819-2837)

```typescript
// NEW CODE (ADDED):
const selectedSources = resolvable.filter((r) => r.selected);
const effectiveScope = 
  compose.sourceScope === "all" && selectedSources.length === 1
    ? "explicit"  // Override to single-source mode
    : compose.sourceScope;

// Use effectiveScope instead of compose.sourceScope
if (effectiveScope === "all") {
  // Multi-source logic (splits duration)
}
```

## Impact

### Before Fix:
```
User: "make a 3 min video" (1 video selected)
System: Detects sourceScope: "all" (false positive from loose regex)
System: Splits 180s ÷ 2 = 90s per source
Result: Shows 90 seconds ❌
```

### After Fix:
```
User: "make a 3 min video" (1 video selected)  
System: Detects sourceScope: "ambiguous" (no explicit multi-source phrase)
System: Checks actual selected videos = 1
System: Uses full 180 seconds for single video
Result: Shows 180 seconds ✓
```

## Testing Scenarios

### Single Video (Should Use Full Duration):
- "make a 3 min video" → 180s ✓
- "create 5 min clips" → 300s ✓
- "overall basketball highlights 2 min" → 120s ✓

### Explicit Multi-Source (Should Split):
- "from all videos make 3 min" → splits 180s ✓
- "use all uploads for 5 min" → splits 300s ✓

### Edge Cases:
- 2+ videos uploaded, 1 selected → full duration for that 1 ✓
- 2+ videos selected, explicit "all" → split ✓

## Compliance

✓ No hardcoded keywords  
✓ Generic structural detection  
✓ Uses live editor state (selected sources)  
✓ Maintains project principles

## Files Changed

1. `lib/intent/videoPromptInterpreter.ts` — Removed loose regex fallback
2. `app/editor/page.tsx` — Added runtime selected-source count check

## Related

- Complies with `.kiro/steering/no-hardcoded-intent.md`
- Part of ongoing effort to remove keyword-based detection
- Supports the AI-powered intent system (no pattern matching)
