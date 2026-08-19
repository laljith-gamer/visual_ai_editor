# Memory Files Organized by Date

> Comprehensive table of ALL memory documentation files, organized chronologically with summaries and files changed.
> Generated: 2026-07-05 (Sunday)
> Total files documented: 45+ files spanning 2026-06-14 to 2026-06-22

---

## 2026-06-22 (Late PM) - Latest Updates

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `DURATION_BUG_FIX_2026-06-22.md` | **Duration Bug Fix**: User requests for "3 min" or "5 min" showed half the time (90s/150s instead of 180s/300s). Root cause: (1) Overly loose regex in `parseSourceScope` matched ANY "all"/"every"/"each" near video words causing false positives, (2) No runtime validation of actual selected video count. | `lib/intent/videoPromptInterpreter.ts` (lines 377-390), `app/editor/page.tsx` (lines 2819-2837) | • Removed loose regex fallback - only explicit phrases trigger multi-source<br>• Added runtime check overriding to single-source when 1 video selected<br>• Fixes "make a 3 min video" → 180s (was 90s) |
| `AI_INTENT_SYSTEM_2026-06-22.md` | **AI Intent System**: Added AI-powered intent understanding using LLM with system prompts (NO hardcoded patterns). New API endpoint `/api/agent/intent` task "understand" returns structured JSON with action/target/parameters/confidence/reasoning. | `app/api/agent/intent/route.ts` (added "understand" task), `app/_dev/intent-tester/page.tsx` (added AI mode toggle) | • Multi-step command support ("merge then trim")<br>• Parameter extraction with reasoning<br>• Confidence scores (0.0-1.0)<br>• Clarification when ambiguous<br>• Context-aware (knows videos, timeline state) |
| `HARDCODED_PATTERNS_REMOVED_2026-06-22.md` | **Removed Hardcoded Patterns**: Completely removed ALL hardcoded SAMPLES array (30+ commands) and sample button UI from intent tester. Now 100% AI-powered with zero maintenance burden. | `app/_dev/intent-tester/page.tsx` | • Removed SAMPLES constant<br>• Removed sample buttons & UI<br>• Pure AI understanding via system prompt<br>• No keyword matching<br>• Handles any natural language command |

---

## 2026-06-22 (PM) - Conversational Chat & Brain Toggle

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `AI_BRAIN_TOGGLE_AND_TOOL_COMMANDS_2026-06-22.md` | **Conversational Chat + Brain Toggle**: Chat now behaves like ChatGPT/Codex but drives editing tools. Added OpenRouter ↔ Local brain toggle with self-diagnosing status. Made WebLLM the PRIMARY brain. Added AI-commandable format/source tools. | `lib/plan/deriveIntent.ts`, `lib/local-llm/{localPlanner,status}.ts`, `app/editor/page.tsx`, `app/api/agent/intent/route.ts`, `lib/ai/brainPreference.ts`, `components/BrainToggle.tsx`, `lib/agent/conversationalReply.ts`, `lib/intent/toolCommands.ts`, `hooks/useEditorStore.ts` | • Killed keyword-soup generically - adjacent words group into phrases<br>• Brain toggle in chat header (OpenRouter ↔ Local)<br>• Conversational lane for greetings/questions<br>• Format/aspect AI-commandable ("make it vertical")<br>• Library/source control AI-commandable<br>• Verified: typecheck ✓, tests 583/0 |
| `MULTI_VIDEO_FLOW_FIX_2026-06-22.md` | **Multi-Video Flow Fix**: Fixed "Which video?" infinite loop and create/compose hijack bug. "pick best scenes in both video" now works, "both"/"all" answers no longer loop forever. | `lib/intent/sourceResolver.ts`, `lib/intent/toolCommands.ts`, `lib/agent/runAgentCommand.ts` | • Create/compose guard prevents hijacking<br>• Pending-clarify gate stops loop<br>• Rule 2b honors Library selection<br>• Tests: 599 pass (was 593) |
| `NEAREST_MATCH_FALLBACK_2026-06-22.md` | **Nearest-Match Fallback**: Fixes "top score 0.00" dead-end when constraint-driven requests matched concept only faintly. Gate now keeps nearest-matching footage instead of returning nothing. | `lib/constraints/filter.ts`, `lib/constraints/types.ts`, `lib/pipeline/executePerSource.ts`, `app/editor/page.tsx`, `lib/constraints/filter.test.ts` | • Graceful fallback for faint matches<br>• Flags `approximate = true`<br>• Surfaces as needs_review with honest note<br>• No hardcoded keywords, no faked matches<br>• Tests: 558 pass, test:constraints 30 pass |

---

## 2026-06-20 - Dynamic Local Analysis & Chat Improvements

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `CHAT_BRAIN_PRELOAD_2026-06-20.md` | **Chat Brain Preload + Dynamic Clip Durations**: (1) Privacy-safe text-only chat brain warmed in background, used only as fallback when deterministic confidence is low. (2) Clip durations now dynamic (min ~1s, max scales with video) instead of fixed ~3s. | `lib/llm/{chatBrainSchema,chatBrainPreload}.ts`, `app/api/agent/intent/route.ts`, `hooks/useChatBrainPreload.ts`, `lib/agentic-intake/llmPendingAnswerResolver.ts`, `components/ChatBrainBadge.tsx`, `lib/pipeline/clipDuration.ts`, `lib/config.ts`, `lib/pipeline/bestParts.ts`, `lib/pipeline/highlights.ts` | • Text-only brain (never receives media)<br>• Anti-loop guard in handleAgent<br>• Dynamic clip lengths vary with score<br>• Config: CHAT_BRAIN + CLIP_DURATION<br>• Tests: 522 pass (+30) |
| `DYNAMIC_LLM_CHAT_ROUTING_2026-06-20.md` | **Dynamic Free-Text Chat Routing**: Fixed "What should I make?" infinite loop and describe misrouting. Chat now accepts FREE-TEXT answers to pending questions and progresses edit brief. | `lib/agentic-intake/pendingAnswerResolver.ts`, `lib/intent/refinementIntent.ts`, `lib/agentic-intake/inferBrief.ts`, `lib/config.ts`, `app/editor/page.tsx` | • Pending-answer resolver (exact/fuzzy/contextual)<br>• Describe misrouting fix<br>• HIGHLIGHT_RE expansion ("best X")<br>• Editing lexicon ("continuous")<br>• Tests: 492 pass, new pendingAnswerResolver tests |
| `DYNAMIC_LOCAL_ANALYSIS_2026-06-20.md` | **Dynamic Progressive Local Analysis + Describe Fix**: Replaced fixed ~240-frame cap with dynamic, purpose-aware budget. Fixed "Describe what's in this video" misrouting bug. | `lib/analysis/{types,budget,deviceTier,purpose,videoMemory,videoMemoryStore,clarificationPolicy,globalVideoPlanner}.ts`, `lib/timeline/overlapResolver.ts`, `lib/agent/describeResponder.ts`, `app/editor/page.tsx`, `lib/pipeline/executePerSource.ts`, `lib/config.ts` | • Dynamic frame budget (0 for exact, 5-12 for describe, banded by duration)<br>• Describe bug FIXED (no longer builds shorts)<br>• Video memory (hash-keyed, NO raw bytes)<br>• Clarification policy, global planner, overlap resolver<br>• Tests: 397 pass (+69) |
| `DYNAMIC_LOCAL_ANALYSIS_WIRING_2026-06-20.md` | **Dynamic Local Analysis LIVE**: Wired foundation into real editor. Quick scan works, memory persists/reuses, multi-video uses global planner, overlapping adds ASK first. | `lib/analysis/{memorySignals,quickScanResult,quickScanCommand,globalPlanRequest,videoMemoryManager,quickScan}.ts`, `lib/timeline/{overlapIntent,overlapFlow}.ts`, `lib/config.ts`, `hooks/useEditorStore.ts`, `app/editor/page.tsx` | • Video memory end-to-end (primed on upload)<br>• Quick scan command runs real scan<br>• Purpose + memory-aware budget<br>• Global multi-video planner wired<br>• Overlap resolver asks before stacking<br>• Tests: 432 pass (+35) |
| `EDITOR_REFINEMENT_ROUTING_2026-06-20.md` | **Editor-First Turn Routing**: Fixed failing refinement conversations. Added generic editor-turn routing layer that runs BEFORE planner. Refinement/control turns now route as editor operations. | `lib/intent/{editingNormalize,topicPhrases,targetDurationMemory,refinementIntent,editorTurnIntent}.ts`, `lib/timeline/trimToTarget.ts`, `lib/config.ts`, `lib/agent/orchestrator.ts`, `lib/plan/deriveIntent.ts`, `hooks/useEditorStore.ts`, `app/editor/page.tsx` | • Generic typo correction (combact→combat)<br>• Phrase preservation ("red boy", "wukong fight")<br>• Latest duration wins, trim-to-fit direct<br>• Ask-then-REPLACE refine (no append dead-end)<br>• Weak results → needs_review (not auto-render)<br>• Tests: 484 pass (test:editor 52) |
| `EDITOR_STAGE_SCROLL_LAYOUT_2026-06-20.md` | **Editor Stage Scroll Layout Fix**: Fixed preview area visually squeezed by timeline. Changed to fixed two-row grid with independent scrolling. | `components/EditorStage.tsx`, `components/EditorStage.module.css` | • Preview row flexible (minmax(0, 1fr))<br>• Timeline row capped auto<br>• Independent scroll areas<br>• Increased preview minimum height<br>• Mobile fallback for narrow screens |

---

## 2026-06-19 - Production Reliability & Issue Fixes

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `AGENTIC_INTAKE_LAYER_2026-06-19.md` | **Agentic Intake Layer**: Universal intake system for vague/messy requests. Turns requests into guided option-chip questions, builds stable brief across turns. | `lib/agentic-intake/{editBrief,capabilityMatrix,inferBrief,questionEngine,promptCompiler,routeDecision,intake,runIntake}.ts` | • EditBrief + mergeBrief multi-turn<br>• Capability matrix (honest effects)<br>• Question engine (one at a time)<br>• Prompt compiler (clean, structured)<br>• No genre tables, no fake claims<br>• Tests: 225 pass (+27) |
| `ISSUE62_BEST_PICKS_TARGET_FIX_2026-06-19.md` | **Issue #62 Fix**: "best picks for reels 40 sec" produced 1s clip marked ready. Fixed with generic best-parts intent, offline scoring, CPU fallback, honest coverage. | `lib/plan/deriveIntent.ts`, `app/api/agent/route.ts`, `lib/pipeline/bestParts.ts`, `lib/pipeline/coverage.ts`, `lib/pipeline/highlights.ts`, `app/editor/page.tsx`, `lib/config.ts`, `lib/types.ts`, `components/Topbar.tsx`, `components/ProjectRail.tsx` | • Generic best-parts parsing (no genre table)<br>• Offline visual-interest scoring<br>• CPU/offline fallback (expand clips)<br>• Honest coverage + needs_review status<br>• Config: TARGET_COVERAGE, OFFLINE_BEST_PARTS<br>• Tests: 172 pass (new bestParts/coverage) |
| `ISSUE64_PROFESSIONAL_VIDEO_PROMPT_INTERPRETER_2026-06-19.md` | **Issue #64 Fix**: "atleast sect 5 clip from all" fabricated topics. New video-prompt interpreter extracts structured slots BEFORE detectors. | `lib/intent/videoPromptInterpreter.ts`, `lib/plan/composeIntent.ts`, `lib/plan/composeNormalize.ts`, `lib/plan/composeSubPlan.ts`, `lib/plan/prompt.ts`, `lib/types.ts`, `app/editor/page.tsx`, `lib/config.ts` | • Normalize/parse slots (duration/count/format/scope)<br>• META_VOCAB + meaningful-topic guard<br>• Compose refactor (no fake topics)<br>• All-source compose (fan-out execution)<br>• VIDEO_PROMPT config<br>• Tests: 198 pass (new interpreter + compose) |
| `PR57_PRODUCTION_TOOL_RELIABILITY_2026-06-19.md` | **PR 57 - Production Tool Reliability**: Reliable export/download path + render-vs-export split. Export button always visible with status. | `lib/util/download.ts`, `hooks/useExport.ts`, `hooks/useShare.ts`, `lib/intent/fastCommands.ts`, `lib/agent/runAgentCommand.ts`, `components/PreviewToolbar.tsx`, `app/editor/page.tsx` | • Deterministic filename (yyyyMMdd-HHmmss)<br>• shareOrDownload (tries share, fallback)<br>• Export = separate from render<br>• Pure decideFastAction (testable)<br>• Always-visible Export button<br>• Tests: 112 pass |
| `PR58_TRANSITION_FOUNDATION_2026-06-19.md` | **PR 58 - Transition Foundation**: Per-boundary transition model + honest mapping. Foundation only (no render/UI change yet). | `lib/transitions/types.ts`, `lib/transitions/map.ts`, `lib/config.ts` | • TransitionType (9 types)<br>• RenderableTransition (3 actual)<br>• BoundaryTransition model<br>• Honest mapping (exact:false + note)<br>• TRANSITIONS config<br>• Tests: 119 pass (7 map tests) |
| `PR59_AUTO_TRANSITIONS_2026-06-19.md` | **PR 59 - Auto Transitions**: Offline auto-transition picking from generic media signals. NO genre/keyword tables. | `lib/transitions/{features,auto,timeline}.ts`, `hooks/useEditorStore.ts`, `components/TransitionsBar.tsx`, `lib/intent/transitionCommands.ts`, `lib/pipeline/renderFilters.ts` | • Generic signals (source/gap/motion/overlap)<br>• Fixed precedence selector<br>• Store + UI (TransitionsBar chip row)<br>• Chat commands (deterministic parse)<br>• Per-boundary render (optional)<br>• Tests: 155 pass (+36) |
| `PROJECT_HISTORY_RESTORE_2026-06-19.md` | **Project History Restore**: Full project/session restore with hash-keyed source manifests. Re-upload reconnects by hash to original id. | `lib/store/projectRestore.ts`, `lib/types.ts`, `hooks/useEditorStore.ts`, `components/ProjectRail.tsx`, `components/Timeline.tsx`, `app/editor/page.tsx`, `app/launch/page.tsx` | • PersistedSourceManifest (NO blobs)<br>• RestoredSourcePlaceholder (missing)<br>• hydrateRestoredSource (hash match)<br>• Missing banner + placeholder cards<br>• Render guard blocks missing<br>• Session schemaVersion 2<br>• Tests: 243 pass (+18) |

---

## 2026-06-18 - Offline Fast Editor

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `OFFLINE_FAST_EDITOR_2026-06-18.md` | **Offline Fast Editor**: Fast command routing, agent memory persistence, storage budget, transcription error honesty. Default is deterministic + instant. | `lib/intent/fastCommands.ts`, `lib/agent/runAgentCommand.ts`, `hooks/useEditorStore.ts`, `lib/agent-memory/persistence.ts`, `lib/agent-memory/context.ts`, `lib/config.ts`, `lib/storage/{budget,manager}.ts`, `hooks/useTranscription.ts`, `components/TranscriptDrawer.tsx` | • Fast command routing (affirm/cancel/undo/redo/render)<br>• One-step redo added<br>• Agent memory IndexedDB persistence<br>• Storage budget (mobile/desktop caps)<br>• Explicit transcription errors<br>• Tests: 102 pass (+16) |

---

## 2026-06-17 - Agentic Intent Layer

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `AGENTIC_INTENT_LAYER_2026-06-17.md` | **Agentic Intent Layer**: Deterministic agent layer turns natural commands into structured timeline operations BEFORE cloud planner. | `lib/intent/{command,timeRangeParser,sourceResolver,clipResolver,placementResolver,editCommandParser}.ts`, `lib/agent-memory/{types,store,observer,resolver,policy,context}.ts`, `lib/timeline/{placement,operations}.ts`, `lib/agent/{orchestrator,conceptResolver,reinforcement,runAgentCommand}.ts`, `lib/ocr/{types,query}.ts` | • Natural command parsing (source/clip/range/placement)<br>• Agent memory + reinforcement + policy<br>• Pure timeline operations<br>• Honest OCR (reports unavailable)<br>• No fixed clip count/duration<br>• Tests: 86 pass (36 existing + 50 new) |
| `RUNTIME_CONSOLE_FIXES_2026-06-17.md` | **Runtime Console Fixes**: Fixed Canvas2D willReadFrequently warning and SigLIP dtype warning. | `lib/pipeline/sample.ts`, `lib/vision/siglip.worker.ts` | • Canvas2D context { willReadFrequently: true }<br>• SigLIP explicit dtype: "fp32"<br>• manifest.webmanifest 401 (Vercel auth, not code bug) |

---

## 2026-06-16 - Local-First AI & Video Memory

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `LOCAL_MODEL_CSP_AND_TREE_MEMORY_2026-06-16.md` | **Local Model CSP & Tree Memory Wiring**: WebLLM model files allowed via CSP, offline quick plan for vertical reels, video-memory tree saved. | `lib/config.ts`, `app/api/agent/route.ts`, `lib/store/cache.ts`, `middleware.ts` | • Offline quick plan (vertical reel)<br>• Saves FrameTree → VideoMemoryIndex<br>• CSP allows HuggingFace CDN<br>• Commits: 715b75b2, 56d827cf, f7c81fea |
| `LOCAL_ONLY_AI_MODE_2026-06-16.md` | **Local-Only AI Mode**: Cloud providers disabled by default, WebLLM enabled by default. | `lib/local-llm/config.ts`, `lib/env.ts`, `.env.example` | • DISABLE_CLOUD_AI defaults disabled<br>• hasAnyChatProvider() returns false<br>• Local WebLLM text-only<br>• Re-enable: set DISABLE_CLOUD_AI=false |
| `LOCAL_ONLY_UI_AND_CSP_FIXES_2026-06-16.md` | **Local-Only UI & CSP Fixes**: AIModeBadge shows Local AI, CSP allows model downloads, deterministic fallback for simple prompts. | `components/AIModeBadge.tsx`, `middleware.ts`, `app/api/agent/route.ts` | • Badge shows "Local AI" not "Cloud AI"<br>• HuggingFace CDN in CSP<br>• /api/agent can use deterministic fallback<br>• Commits: db2eb743, f7c81fea, 57a5bf53 |
| `OFFLINE_VIDEO_UNDERSTANDING_STEP1_2026-06-16.md` | **Offline Video Understanding Step 1**: Saves local tree memory from scored frames. | `lib/store/cache.ts`, `lib/frame-tree/*` | • Builds FrameTree after predictions<br>• Converts to VideoMemoryIndex<br>• Saves in video-memory IndexedDB<br>• Commits: 6c02a7d3, 56d827cf |
| `PROJECT_GOAL_BROWSER_FIRST_HYBRID_2026-06-16.md` | **Project Goal: Browser-First Hybrid AI**: Defines project goal as browser-first hybrid AI video editor with local reasoning + optional cloud. | N/A (Goal statement) | • Local LLM handles planning<br>• Frame models extract signals<br>• Video stays on-device<br>• Optional cloud enhancement<br>• Multi-video support<br>• Fast first response |
| `VIDEO_MEMORY_FOUNDATION_2026-06-16.md` | **Video Memory Foundation**: Added first code foundation for offline-first tree memory. | `lib/store/idb.ts`, `lib/video-memory/{types,build,query,store,index}.ts` | • shorts-studio-video-memory IndexedDB<br>• VideoMemoryIndex schema (hash-keyed)<br>• Builder from FrameTree<br>• Query/retrieval helpers<br>• Multi-video context helper<br>• Foundation only (not wired live yet) |

---

## 2026-06-15 - AI Usage & Training Direction

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `AI_USAGE_UPDATE_2026-06-15.md` | **AI Usage Meter Update**: Added compact AI usage meter beside Shorts Studio title showing API calls, provider, model, tokens. | `components/Topbar.tsx`, `components/Topbar.module.css`, `lib/ai/usage.ts`, `app/api/ai/usage/route.ts`, `lib/providers/{openrouter,gemini,groq,customOpenai}.ts` | • Server AI API call count<br>• Planner vs vision split<br>• Provider + model shown<br>• Token totals<br>• Local session activity count<br>• Follow-up fixes: 80e66df0, cec2e456 |
| `DOMAIN_MODEL_TRAINING_2026-06-15.md` | **Domain Model Training Direction**: Guidelines for training specialized video-editing domain model. | N/A (Strategy doc) | • Fine-tune text planner first (not foundation model)<br>• JSON edit-plan generation<br>• Local video index from frames<br>• JSONL conversation dataset format<br>• Privacy rule (synthetic/consented data only) |
| `OFFLINE_FIRST_ANALYSIS_PLAN_2026-06-15.md` | **Offline-First 5-Minute Analysis Plan**: Plan for 30-60s first response with up to 5-min progressive analysis. | N/A (Architecture plan) | • Stage 0: Instant (0-2s)<br>• Stage 1: Quick plan (0-60s)<br>• Stage 2: Coarse pass (30-120s)<br>• Stage 3: Focused pass (120-300s)<br>• Stage 4: Final plan (by 5 min)<br>• Tree-memory approach with graph links |
| `PRODUCTION_VIDEO_OPTIMIZATION_2026-06-15.md` | **Production Video Optimization**: Adaptive, capped, hierarchical analysis for long videos. | `lib/pipeline/executePerSource.ts` | • Frame cap + adaptive sampling<br>• No fixed 1s interval on long videos<br>• Cache-miss sampling optimization<br>• Commits: eb1f2762 (initial), 73842dbe (fix) |

---

## 2026-06-14 - UI Cleanup

| File | Summary | Files Changed | Key Changes |
|------|---------|---------------|-------------|
| `2026-06-14-ui-source-tab-cleanup.md` | **UI Source Tab Cleanup**: Timeline source tabs made inline, transparent, fit-content. | `components/Timeline.module.css` | • Removed extra full-row box<br>• Inline transparent tabs<br>• Compact pill controls<br>• Visual check post-deploy |
| `ui-2026-06-14.md` | **UI CSS Update**: Timeline wrapper chrome removed for cleaner source tabs. | `components/Timeline.module.css` | • Cleaner source tabs |
| `ui-center-scroll-note.md` | **UI Center Scroll**: Added center preview column scroll. | N/A | • Preview frame min-height responsive |
| `ui-final-timeline-tabs-note.md` | **UI Timeline Tabs**: Final CSS override for Timeline source buttons. | N/A | • CSS override added |
| `ui-smart-chat-header-note.md` | **UI Chat Header**: Smart Chat header CSS corrected. | N/A | • Header CSS fixed |
| `ui-system-export-only-note.md` | **UI Export**: Export changed to system/download-only. | N/A | • Web Share path removed |

---

## Core Memory Files (Living Documents)

| File | Purpose | Status |
|------|---------|--------|
| `INDEX.md` | Entry point with reading order, dated context notes index | ✅ Active - Updated 2026-06-22 late pm |
| `PROJECT_STATE.md` | Current source of truth: goal, status, architecture, next step | ✅ Active - Updated 2026-06-22 late pm |
| `CHANGELOG.md` | Detailed historical log of project/memory changes | ✅ Active - Ongoing updates |
| `DECISIONS.md` | Technical and product decision log with reasoning | ✅ Active - Ongoing updates |
| `CONSTRAINTS.md` | Hard rules for code, privacy, AI work | ✅ Active - Standing constraints |
| `ROADMAP.md` | Larger phased direction | ✅ Active - Strategic direction |
| `TODO.md` | Active prioritized tasks | ✅ Active - Current work items |

---

## Summary Statistics

- **Total Memory Files**: 45+ files
- **Date Range**: 2026-06-14 to 2026-06-22 (9 days)
- **Most Active Days**:
  - 2026-06-22: 6 files (duration bug, AI intent, hardcoded removal, brain toggle, multi-video fix, nearest-match)
  - 2026-06-20: 6 files (chat brain, dynamic analysis wiring, routing, scroll layout)
  - 2026-06-19: 7 files (agentic intake, issue fixes, PRs, history restore)
  - 2026-06-16: 6 files (local-first AI, video memory foundation)

- **Key Themes**:
  1. **AI Understanding**: Evolved from hardcoded patterns → deterministic parsing → AI intent with system prompts
  2. **Local-First Architecture**: Browser-first, offline-capable, video never leaves device
  3. **Production Reliability**: Bug fixes, honest coverage, graceful fallbacks
  4. **Dynamic Analysis**: Purpose-aware budgets, video memory, quick scans
  5. **Editor Intelligence**: Natural commands, refinement routing, conversational chat

---

## Project Principles (Extracted from Memory)

### Core Rules
1. **NO hardcoded commands/keywords** - Use AI reasoning, not keyword matching
2. **Dynamic, not hardcode** - Understand generically through structure/grammar
3. **Offline edit** - All editing works fully on-device/offline
4. **AI confirmation** - Every edit has clear AI acknowledgement
5. **Privacy-first** - Video bytes stay in browser, no upload
6. **Honest limits** - Never claim effects not rendered, always surface assumptions

### Technical Constraints
- API keys SERVER-ONLY (never `NEXT_PUBLIC_*`)
- WebGPU features can't be verified in CI
- Cloud provider chain: OpenRouter → Gemini → Groq
- Rate limiting multi-layer (edge IP, session, global LLM, circuit)
- Browser-first: video never leaves device

### Quality Gates
- `npm run typecheck` must pass
- `npm test` must pass (currently 583 tests)
- `npm run build` must succeed
- Browser/WebGPU verification required for live features
- Update memory files with every change

---

## Reading Guide

**For New Contributors/AI Assistants:**
1. Start with `INDEX.md` for navigation
2. Read `PROJECT_STATE.md` for current status
3. Read `CONSTRAINTS.md` for hard rules
4. Check `TODO.md` for active work
5. Consult dated files for historical context

**For Understanding a Specific Topic:**
- **AI Intent Understanding**: `AI_INTENT_SYSTEM_2026-06-22.md`, `HARDCODED_PATTERNS_REMOVED_2026-06-22.md`, `AGENTIC_INTENT_LAYER_2026-06-17.md`
- **Bug Fixes**: `DURATION_BUG_FIX_2026-06-22.md`, `ISSUE62_BEST_PICKS_TARGET_FIX_2026-06-19.md`, `ISSUE64_PROFESSIONAL_VIDEO_PROMPT_INTERPRETER_2026-06-19.md`
- **Local-First Architecture**: `LOCAL_ONLY_AI_MODE_2026-06-16.md`, `OFFLINE_FAST_EDITOR_2026-06-18.md`, `DYNAMIC_LOCAL_ANALYSIS_2026-06-20.md`
- **Video Memory**: `VIDEO_MEMORY_FOUNDATION_2026-06-16.md`, `OFFLINE_FIRST_ANALYSIS_PLAN_2026-06-15.md`
- **Production Reliability**: `PR57_PRODUCTION_TOOL_RELIABILITY_2026-06-19.md`, `PROJECT_HISTORY_RESTORE_2026-06-19.md`

---

## Change Log for This Document

- **2026-07-05**: Initial creation - comprehensive organization of all 45+ memory files by date with summaries, files changed, and key changes
