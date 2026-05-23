import json
import os
import re
from typing import Any


GOOD_SCENARIOS = [
    "high energy action",
    "person talking narration",
    "cinematic b-roll shot",
    "conversation dialogue",
    "tutorial demonstration",
    "emotional reaction surprise",
]

BAD_SCENARIOS = [
    "walking transition filler",
    "menu loading screen",
    "repetitive static footage",
    "black blank blurry frame",
]

UNIVERSAL_SCENARIOS = GOOD_SCENARIOS + BAD_SCENARIOS
EXPORT_FORMATS = {"vertical", "horizontal", "both", "auto"}

DOMAIN_SCENARIOS = [
    (
        ("game", "gameplay", "boss", "combat", "fight", "combo", "kill", "cutscene"),
        [
            "player hitting enemy successfully",
            "enemy taking visible damage",
            "enemy defeated death animation",
            "boss fight major combat",
            "cinematic cutscene story",
            "exploration walking idle",
            "menu loading screen inventory",
            "player taking damage failed attack",
            "static boring repeated gameplay",
        ],
    ),
    (
        ("sport", "goal", "score", "match", "race", "basketball", "football", "cricket"),
        [
            "decisive sports play",
            "athlete celebration reaction",
        ],
    ),
    (
        ("lecture", "class", "tutorial", "teach", "explain", "lesson", "course"),
        [
            "key teaching moment",
            "clear slide detail",
        ],
    ),
    (
        ("cook", "recipe", "food", "bake", "kitchen"),
        [
            "important cooking step",
            "finished food reveal",
        ],
    ),
    (
        ("vlog", "travel", "trip", "street", "nature", "place"),
        [
            "scenic travel moment",
            "candid reaction interaction",
        ],
    ),
    (
        ("product", "review", "unbox", "demo", "showcase"),
        [
            "product feature demo",
            "close up product detail",
        ],
    ),
    (
        ("dance", "music", "song", "performance", "stage"),
        [
            "peak performance moment",
            "crowd performer reaction",
        ],
    ),
    (
        ("interview", "podcast", "talk", "speaker", "conversation"),
        [
            "speaker reaction gesture",
            "important conversation beat",
        ],
    ),
    (
        ("screen", "software", "app", "website", "code", "coding", "computer"),
        [
            "screen recording key step",
            "interface result change",
        ],
    ),
    (
        ("silent", "muted", "no audio", "without audio"),
        [
            "visual action reveal",
            "silent understandable moment",
        ],
    ),
    (
        ("funny", "comedy", "laugh", "meme", "fail", "unexpected"),
        [
            "funny surprise reaction",
            "memorable comedy beat",
        ],
    ),
]

LABEL_ALIASES = {
    "clear important moment with the main subject or event": "high energy action",
    "visually dynamic motion change reveal or result": "high energy action",
    "expressive reaction emotion or memorable human moment": "emotional reaction surprise",
    "useful explanation demonstration or key detail being shown": "tutorial demonstration",
    "funny surprising unusual or memorable moment": "emotional reaction surprise",
    "static low motion waiting or boring filler footage": "repetitive static footage",
    "black screen blank frame blurry unusable footage or transition": "black blank blurry frame",
    "intense gameplay combat boss fight or skilled action moment": "boss fight major combat",
    "cinematic game story cutscene dialogue or major reveal": "cinematic cutscene story",
    "game menu loading respawn inventory map or repeated walking filler": "menu loading screen inventory",
}


def make_unique(items: list[str]) -> list[str]:
    unique = []
    seen = set()
    for item in items:
        text = str(item or "").strip()
        normalized = text.lower()
        if normalized and normalized not in seen:
            unique.append(text)
            seen.add(normalized)
    return unique


def compact_label(label: str, max_words: int = 6) -> str:
    text = " ".join(str(label or "").replace("\n", " ").split()).strip()
    if not text:
        return ""
    lowered = text.lower()
    if lowered in LABEL_ALIASES:
        return LABEL_ALIASES[lowered]
    if lowered.startswith("best moment matching") or lowered.startswith("best visual moment"):
        return "best requested moment"
    if len(text.split()) <= max_words and len(text) <= 60:
        return text

    words = re.findall(r"[a-zA-Z0-9]+", lowered)
    stopwords = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "being",
        "for",
        "from",
        "in",
        "into",
        "is",
        "of",
        "or",
        "that",
        "the",
        "this",
        "to",
        "with",
        "without",
        "your",
        "user",
        "request",
        "video",
        "scene",
        "moment",
    }
    keywords = [word for word in words if word not in stopwords][:max_words]
    return " ".join(keywords) or "best requested moment"


def clamp_number(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def normalize_string_list(value: Any, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()][:limit]


def normalize_export_format(value: Any, memory: dict[str, Any]) -> str:
    text = str(value or memory.get("format") or "auto").strip().lower()
    return text if text in EXPORT_FORMATS else "auto"


def normalize_selection_strategy(raw: Any) -> dict[str, Any]:
    strategy = raw if isinstance(raw, dict) else {}
    min_clip = clamp_number(strategy.get("minimum_clip_seconds"), 4.0, 1.0, 30.0)
    max_clip = clamp_number(strategy.get("maximum_clip_seconds"), 45.0, min_clip, 120.0)
    return {
        "search_scope": "full_video",
        "spread_across_timeline": bool(strategy.get("spread_across_timeline", True)),
        "avoid_single_start_chunk": bool(strategy.get("avoid_single_start_chunk", True)),
        "allow_single_long_clip": bool(strategy.get("allow_single_long_clip", False)),
        "prefer_diverse_labels": bool(strategy.get("prefer_diverse_labels", True)),
        "minimum_clip_seconds": min_clip,
        "maximum_clip_seconds": max_clip,
        "context_before_seconds": clamp_number(strategy.get("context_before_seconds"), 1.0, 0.0, 6.0),
        "context_after_seconds": clamp_number(strategy.get("context_after_seconds"), 1.5, 0.0, 8.0),
        "boundary_gap_seconds": clamp_number(strategy.get("boundary_gap_seconds"), 2.5, 0.5, 10.0),
        "target_clip_count": int(clamp_number(strategy.get("target_clip_count"), 0.0, 0.0, 30.0)),
    }


def normalize_preview_policy(raw: Any) -> dict[str, Any]:
    policy = raw if isinstance(raw, dict) else {}
    return {
        "preview_source": str(policy.get("preview_source") or "selected_clip").strip() or "selected_clip",
        "hover_preview": bool(policy.get("hover_preview", True)),
        "show_review_before_export": bool(policy.get("show_review_before_export", True)),
    }


def normalize_transition_policy(raw: Any) -> dict[str, Any]:
    policy = raw if isinstance(raw, dict) else {}
    transition_type = str(policy.get("type") or "fade").strip().lower()
    if transition_type not in {"fade", "none"}:
        transition_type = "fade"
    duration = clamp_number(policy.get("duration_seconds"), 0.3, 0.0, 1.5)
    enabled = bool(policy.get("enabled", transition_type != "none" and duration > 0))
    return {
        "enabled": enabled and transition_type != "none" and duration > 0,
        "type": transition_type,
        "duration_seconds": duration,
        "audio_fade": bool(policy.get("audio_fade", True)),
    }


def label_is_bad(label: str) -> bool:
    text = label.lower()
    if text.startswith("best moment matching") or text.startswith("best visual moment"):
        return False
    return any(
        term in text
        for term in (
            "black",
            "blank",
            "blur",
            "unusable",
            "static",
            "boring",
            "loading",
            "menu",
            "repeated",
            "filler",
            "idle",
            "failed",
            "taking damage",
            "low quality",
            "no visible",
        )
    )


def default_weight(label: str) -> float:
    return 0.0 if label_is_bad(label) else 0.85


def clean_prompt_for_label(text: str, limit: int = 120) -> str:
    cleaned = " ".join(str(text or "").replace("\n", " ").split())
    if not cleaned:
        return "the user's edit request"
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3].rstrip() + "..."


def extract_json_object(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned, flags=re.IGNORECASE).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def local_scenarios(prompt: str) -> list[str]:
    text = prompt.lower()
    scenarios = ["best requested moment"]
    for keywords, labels in DOMAIN_SCENARIOS:
        if any(keyword in text for keyword in keywords):
            scenarios.extend(labels)
    scenarios.extend(UNIVERSAL_SCENARIOS)
    return make_unique([compact_label(label) for label in scenarios])[:14]


def normalize_plan(
    raw: dict[str, Any],
    prompt: str,
    has_video: bool,
    memory: dict[str, Any],
    default_prompt: str,
) -> dict[str, Any]:
    raw_memory = raw.get("memory_updates") or raw.get("memory") or {}
    merged_memory = dict(memory)
    if isinstance(raw_memory, dict):
        for key in ("duration_seconds", "format", "styles", "keep", "skip", "last_prompt", "selection_strategy"):
            if key in raw_memory and raw_memory[key] not in (None, "", [], {}):
                merged_memory[key] = raw_memory[key]

    scenarios = make_unique([compact_label(label) for label in (raw.get("roboflow_scenarios") or raw.get("scenarios") or [])])
    if len(scenarios) < 4:
        scenarios = local_scenarios(prompt)
    scenarios = make_unique(scenarios[:9] + [compact_label(label) for label in UNIVERSAL_SCENARIOS])

    raw_weights = raw.get("label_weights") if isinstance(raw.get("label_weights"), dict) else {}
    weights: dict[str, float] = {label: default_weight(label) for label in scenarios}
    for label, weight in raw_weights.items():
        label_text = compact_label(str(label).strip())
        if label_text:
            weights[label_text] = clamp_number(weight, default_weight(label_text), 0.0, 1.0)
    for label in scenarios:
        if label_is_bad(label):
            weights[label] = 0.0

    duration = merged_memory.get("duration_seconds") or raw.get("target_short_seconds")
    target_seconds = clamp_number(duration, 30.0, 5.0, 300.0)
    clip_seconds = clamp_number(raw.get("clip_seconds"), 8.0, 4.0, 30.0)
    if target_seconds >= 90:
        clip_seconds = max(clip_seconds, 8.0)
    export_format = normalize_export_format(raw.get("export_format"), merged_memory)
    if export_format != "auto":
        merged_memory["format"] = export_format
    selection_strategy = normalize_selection_strategy(raw.get("selection_strategy"))
    preview_policy = normalize_preview_policy(raw.get("preview_policy"))
    transition_policy = normalize_transition_policy(raw.get("transition_policy"))
    merged_memory["selection_strategy"] = selection_strategy

    questions = raw.get("questions") if isinstance(raw.get("questions"), list) else []
    questions = [str(question).strip() for question in questions if str(question).strip()][:2]
    if not has_video:
        questions.insert(0, "Upload a video first so I can analyze the actual footage.")
    if not prompt.strip():
        questions.append("Tell me what kind of edit you want.")
    ready = bool(raw.get("ready", True)) and not questions

    resolved_prompt = str(raw.get("resolved_prompt") or prompt or default_prompt).strip()
    message = str(raw.get("message") or "").strip()
    if not message:
        message = (
            "I have enough detail. I will build a fresh edit plan from your request and reuse saved analysis when possible."
            if ready
            else "Before I run it, I need this: " + " ".join(questions)
        )

    request_scenarios = make_unique(raw.get("request_scenarios") or scenarios)
    return {
        "ready": ready,
        "message": message,
        "questions": questions,
        "memory": merged_memory,
        "resolved_prompt": resolved_prompt,
        "plan": {
            "request": resolved_prompt,
            "roboflow_scenarios": scenarios,
            "request_scenarios": request_scenarios[:12],
            "label_weights": weights,
            "target_short_seconds": target_seconds,
            "clip_seconds": clip_seconds,
            "export_format": export_format,
            "selection_strategy": selection_strategy,
            "preview_policy": preview_policy,
            "transition_policy": transition_policy,
            "cross_check_required": True,
            "planner_source": raw.get("planner_source", "ai"),
        },
    }


def build_local_plan(
    prompt: str,
    has_video: bool,
    memory: dict[str, Any],
    default_prompt: str,
) -> dict[str, Any]:
    questions = []
    if not has_video:
        questions.append("Upload a video first so I can analyze the actual footage.")
    if not prompt.strip():
        questions.append("Tell me what kind of moments to keep or skip.")
    if not memory.get("duration_seconds"):
        questions.append("How long should the final short be?")

    resolved_prompt = prompt.strip() or default_prompt
    scenarios = local_scenarios(resolved_prompt)
    weights = {label: default_weight(label) for label in scenarios}
    for label in scenarios:
        if label.startswith("best moment matching"):
            weights[label] = 1.0
    raw = {
        "ready": not questions,
        "message": (
            "I have enough detail. I will reuse saved analysis when possible and use a local edit plan because the AI planner is not configured."
            if not questions
            else "Before I run it, I need this: " + " ".join(questions[:2])
        ),
        "questions": questions[:2],
        "memory": memory,
        "resolved_prompt": resolved_prompt,
        "roboflow_scenarios": scenarios,
        "request_scenarios": scenarios,
        "label_weights": weights,
        "target_short_seconds": memory.get("duration_seconds") or 30,
        "clip_seconds": 8,
        "export_format": memory.get("format") or "auto",
        "selection_strategy": memory.get("selection_strategy") or {
            "search_scope": "full_video",
            "spread_across_timeline": True,
            "avoid_single_start_chunk": True,
            "minimum_clip_seconds": 4,
            "maximum_clip_seconds": 45,
            "context_before_seconds": 1,
            "context_after_seconds": 1.5,
            "boundary_gap_seconds": 2.5,
        },
        "preview_policy": {"preview_source": "selected_clip", "hover_preview": True, "show_review_before_export": True},
        "transition_policy": {"enabled": True, "type": "fade", "duration_seconds": 0.3, "audio_fade": True},
        "planner_source": "local",
    }
    return normalize_plan(raw, prompt, has_video, memory, default_prompt)


def build_ai_plan(
    prompt: str,
    has_video: bool,
    memory: dict[str, Any],
    default_prompt: str,
) -> dict[str, Any] | None:
    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        return None

    from openai import OpenAI

    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("DASHSCOPE_BASE_URL", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
        timeout=float(os.getenv("DASHSCOPE_TIMEOUT_SECONDS", "20")),
    )
    model = os.getenv("DASHSCOPE_MODEL", "qwen3.7-max")
    system = (
        "You are the planning brain for a universal video shorts editor. "
        "Turn natural user chat into a precise edit plan. "
        "Ask at most two short clarification questions only when required. "
        "Create Roboflow CLIP scenario labels that match this user's request and include negative labels for bad footage. "
        "Every Roboflow scenario label must be 2 to 6 words, plain visual language, no sentences, no punctuation. "
        "Clip duration is not fixed: choose boundary and transition settings that fit the request and full video. "
        "Return pure JSON only. Do not include markdown."
    )
    schema = {
        "ready": True,
        "message": "Natural one or two sentence response for the user.",
        "questions": [],
        "memory_updates": {
            "duration_seconds": 30,
            "format": "vertical",
            "styles": ["fast"],
            "keep": ["important action"],
            "skip": ["boring"],
            "selection_strategy": {
                "search_scope": "full_video",
                "spread_across_timeline": True,
                "avoid_single_start_chunk": True,
            },
        },
        "resolved_prompt": "The user's request rewritten with remembered preferences.",
        "roboflow_scenarios": [
            "best requested moment",
            "specific positive scene",
            "black blank blurry frame",
            "repetitive static footage",
        ],
        "label_weights": {
            "best requested moment": 1.0,
            "black blank blurry frame": 0.0,
        },
        "target_short_seconds": 30,
        "clip_seconds": 8,
        "export_format": "vertical | horizontal | both | auto",
        "selection_strategy": {
            "search_scope": "full_video",
            "spread_across_timeline": True,
            "avoid_single_start_chunk": True,
            "allow_single_long_clip": False,
            "prefer_diverse_labels": True,
            "minimum_clip_seconds": 4,
            "maximum_clip_seconds": 45,
            "context_before_seconds": 1,
            "context_after_seconds": 1.5,
            "boundary_gap_seconds": 2.5,
            "target_clip_count": 0,
        },
        "preview_policy": {
            "preview_source": "selected_clip",
            "hover_preview": True,
            "show_review_before_export": True,
        },
        "transition_policy": {
            "enabled": True,
            "type": "fade | none",
            "duration_seconds": 0.3,
            "audio_fade": True,
        },
        "request_scenarios": ["short intent notes for the report"],
    }
    user = {
        "user_prompt": prompt,
        "has_video": has_video,
        "current_memory": memory,
        "default_prompt": default_prompt,
        "required_json_shape": schema,
    }
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=True)},
        ],
        extra_body={"enable_thinking": True},
    )
    content = completion.choices[0].message.content if completion.choices else ""
    parsed = extract_json_object(content or "")
    if not parsed:
        return None
    parsed["planner_source"] = "qwen"
    return normalize_plan(parsed, prompt, has_video, memory, default_prompt)


def build_agent_plan(
    prompt: str,
    has_video: bool,
    memory: dict[str, Any],
    default_prompt: str,
    supplied_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if supplied_plan:
        supplied_plan = {**supplied_plan, "planner_source": supplied_plan.get("planner_source", "supplied")}
        return normalize_plan(supplied_plan, prompt, has_video, memory, default_prompt)

    try:
        plan = build_ai_plan(prompt, has_video, memory, default_prompt)
    except Exception as exc:
        plan = None
        memory = {**memory, "planner_warning": f"{type(exc).__name__}: {exc}"}

    if plan:
        return plan
    return build_local_plan(prompt, has_video, memory, default_prompt)
