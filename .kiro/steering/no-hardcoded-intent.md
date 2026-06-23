---
inclusion: always
---

# Intent understanding: no hardcoded commands or keyword tables

This is a hard project rule, set explicitly by the owner: **never hardcode
individual commands, genre/content keyword tables, or per-phrase command lists
to handle chat or intent.** Patching one failing phrase by adding it to a word
list is an anti-pattern — it does not scale and it is not understanding.

## Do

- Understand a turn from its **structure** (grammar: question vs command,
  verb position, pending state) and from **generic phrase grouping** — group
  adjacent content words into phrases instead of splitting every word into its
  own search (see `buildSubjectPhrases` in `lib/plan/deriveIntent.ts` and
  `extractTopicPhrases` in `lib/intent/topicPhrases.ts`).
- Let the **on-device LLM (WebLLM)** do the real reasoning. It is the primary
  brain (`lib/local-llm/localPlanner.ts`). Improve the *prompt* and the
  *context* it gets, not a lookup table.
- Keep the deterministic layer as a **non-WebGPU safety net** only. Even there,
  prefer generic predicates already defined (function words, numbers, generic
  editing/quality vocab) over new bespoke lists, and never emit per-word
  keyword soup ("black moments / myth moments / …").

## Don't

- Don't add a word to STOPWORDS / META_FOLLOWUP / a vocab Set just to fix one
  reported sentence. If a class of words is genuinely generic (e.g. English
  function words) it may belong, but reach for a generic algorithm or better
  model context first.
- Don't introduce genre/title/entity tables (e.g. game names, "cooking",
  "combat") anywhere in the intent path.
- Don't special-case a literal command string in the router.

When a turn is mishandled, the fix should make the **mechanism** smarter
(structure, phrasing, conversation context, model prompt), not enumerate the
specific words that failed.
