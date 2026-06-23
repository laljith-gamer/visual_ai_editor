---
inclusion: always
---

# Core editing principles (owner-set, non-negotiable)

These three rules govern all chat/intent/editing work in this project. They
complement `.kiro/steering/no-hardcoded-intent.md`.

## 1. Dynamic — no hardcode
- Never hardcode individual commands, genre/content keyword tables, or
  per-phrase command lists. Understand intent **generically**: grammar /
  sentence structure, generic phrase grouping (group adjacent content words
  into phrases — never one search per word), and the model's reasoning.
- Reframing/cropping is **dynamic**: the crop follows the subject/motion per
  clip (smart-reframe), not a fixed center. A locked-center mode exists only
  as an explicit, user-requested override.
- When a turn is mishandled, fix the **mechanism** (structure, phrasing,
  conversation context, model prompt) — never by enumerating the words that
  failed.

## 2. Offline edit
- All editing must work fully **on-device / offline**: the WebLLM planner +
  the deterministic safety net + the in-browser scoring/render pipeline.
- Cloud (OpenRouter) is **optional**, chosen via the explicit chat toggle, and
  must never be required for the editor to function. Local is the default.

## 3. AI confirmation
- Every edit is applied with a **clear AI confirmation/acknowledgement** in
  chat that states what changed and why (e.g. "Using only video 2 …",
  "Output aspect set to vertical …", "Locked to a centered crop …").
- **Significant or destructive** edits (replace timeline, drop clips,
  overlapping adds, re-pick) must **ask before mutating** — via a pending
  action, the plan preview ("Run analysis"), or the overlap resolver — so the
  timeline never changes silently. Undo must remain available.

Keep these in mind for every change to the intent/agent/editing layers.
