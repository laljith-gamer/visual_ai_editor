# AI Intent Understanding System - 2026-06-22

## What Was Added

Added a new AI-powered intent understanding system that uses LLM reasoning with system prompts instead of hardcoded pattern matching. This provides a more flexible and maintainable way to understand user commands.

## Changes Made

### 1. Intent Tester UI Enhancement (`app/_dev/intent-tester/page.tsx`)

**Added:**
- **Mode Toggle**: Switch between "Pattern Matcher" (old) and "AI Intent" (new)
- **AI Intent Tab**: Shows structured AI understanding of user commands
- **Live Analysis**: Auto-analyzes on text change with 500ms debounce
- **Rich Result Display**: Shows action, target, parameters, confidence, reasoning, and clarification needs
- **New Sample Commands**: Added multi-step examples like "merge the podcast then trim the first 30 seconds"

**Key Features:**
```typescript
interface AIIntentResult {
  action: string;           // What to do (merge, clip_range, trim, etc.)
  target: string;           // What it applies to
  parameters: object;       // Action-specific params (duration, start_time, etc.)
  confidence: number;       // 0.0 to 1.0
  needs_clarification: boolean;
  question?: string;        // If clarification needed
  reasoning?: string;       // Why this interpretation
}
```

**Visual Indicators:**
- Green border for high confidence (≥70%)
- Yellow border for medium confidence (<70%)
- Red border for errors
- Yellow highlight for clarification needs
- Green highlight for AI reasoning

### 2. AI Intent API Endpoint (`app/api/agent/intent/route.ts`)

**Added Task: "understand"**

**System Prompt:**
```
You are an AI assistant for a video editor.
Understand what the user wants to do.
Return only JSON.

Available actions:
- merge: Combine multiple videos without editing
- clip_range: Extract a specific time range
- trim: Remove parts from a clip
- create_highlights: Make a highlight reel
- describe: Analyze what's in the video
- format_change: Change output format
- confirm: User agreeing to proceed
- cancel: User canceling an action
- sequence: Multiple actions in order
```

**Request Format:**
```json
{
  "task": "understand",
  "userMessage": "merge the podcast then trim the first 30 seconds",
  "context": {
    "uploadedVideos": 3,
    "selectedVideos": 1,
    "timelineClips": 0,
    "timelineEmpty": true,
    "hasPendingAction": false
  }
}
```

**Response Format:**
```json
{
  "action": "sequence",
  "target": "uploaded_videos",
  "parameters": {
    "sequence": [
      {
        "action": "merge",
        "target": "all_videos",
        "parameters": {}
      },
      {
        "action": "trim",
        "target": "merged_result",
        "parameters": {
          "start_time": 0,
          "end_time": 30
        }
      }
    ]
  },
  "confidence": 0.9,
  "needs_clarification": false,
  "reasoning": "User wants to first merge videos, then trim 30 seconds from the start"
}
```

## Example Usage

### Test Case: "merge the podcast then trim the first 30 seconds"

**Context:**
- Uploaded videos: 3
- Timeline: empty

**AI Understanding:**
```json
{
  "action": "sequence",
  "target": "uploaded_videos",
  "parameters": {
    "sequence": [
      {"action": "merge", "target": "all_videos"},
      {"action": "trim", "target": "result", "parameters": {"start_time": 0, "duration": 30}}
    ]
  },
  "confidence": 0.9,
  "needs_clarification": false,
  "reasoning": "User wants a two-step process: combine videos first, then remove the first 30 seconds"
}
```

### Test Case: "make a 3 min video"

**Context:**
- Uploaded videos: 1
- Selected videos: 1

**AI Understanding:**
```json
{
  "action": "create_highlights",
  "target": "current_video",
  "parameters": {
    "duration": 180,
    "videos": ["1"]
  },
  "confidence": 0.85,
  "needs_clarification": false,
  "reasoning": "Single video selected, user wants a 3-minute highlight reel"
}
```

## Benefits Over Hardcoded Patterns

### Before (Hardcoded):
```typescript
// Had to maintain regex patterns for every command
if (/merge|concatenate|stitch/.test(text)) {
  return { kind: "merge", confidence: 0.9 };
}
```

### After (AI-Powered):
- ✅ Understands natural language variations
- ✅ Handles multi-step commands ("do X then Y")
- ✅ Extracts parameters automatically
- ✅ Provides reasoning for decisions
- ✅ Can ask for clarification when ambiguous
- ✅ Context-aware (knows about uploaded videos, timeline state)
- ✅ No maintenance of regex patterns

## Integration Points

### Current Integration:
- **Dev Tool Only**: Available at `/\_dev/intent-tester` in development mode
- **API Endpoint**: `POST /api/agent/intent` with `task: "understand"`
- **Privacy Safe**: Uses existing cloud provider setup, no video bytes sent

### Future Integration:
- Can replace `quickMatch` patterns in production
- Can power the main chat interface
- Can handle complex multi-step editing workflows
- Can provide better error messages and suggestions

## Technical Details

**Privacy & Security:**
- ✓ Text-only, no video/frame/audio data sent
- ✓ Uses existing rate limiting
- ✓ Uses existing cloud provider configuration
- ✓ Falls back gracefully when cloud AI unavailable
- ✓ Respects `DISABLE_CLOUD_AI` setting

**Performance:**
- Debounced analysis (500ms)
- Async with loading states
- Error handling with user-friendly messages
- Temperature: 0.3 (balanced between creativity and consistency)

**Compliance:**
- ✓ No hardcoded commands (uses AI reasoning)
- ✓ Context-aware (uses live editor state)
- ✓ Generic understanding (not keyword matching)
- ✓ Follows project principles

## Files Changed

1. `app/_dev/intent-tester/page.tsx` - Added AI mode with toggle and result display
2. `app/api/agent/intent/route.ts` - Added "understand" task with system prompt

## Testing

Visit `/\_dev/intent-tester` in development mode to test:
1. Toggle to "AI Intent" mode
2. Type or select sample commands
3. See structured understanding with reasoning
4. Test complex multi-step commands
5. Observe confidence scores and clarification needs

## Next Steps

1. Integrate into main editor chat flow
2. Add more action types as needed
3. Train on real user commands
4. Build execution layer for sequence actions
5. Add undo/redo support for AI commands
