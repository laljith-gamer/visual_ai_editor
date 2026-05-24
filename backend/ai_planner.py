import json
import os
import re
import urllib.request
from typing import Any


def make_unique(items: list[str]) -> list[str]:
    unique = []
    seen = set()
    for item in items:
        text = " ".join(str(item or "").replace("\n", " ").split()).strip()
        key = text.lower()
        if text and key not in seen:
            unique.append(text)
            seen.add(key)
    return unique


def clean_label(label: Any) -> str:
    text = " ".join(str(label or "").replace("\n", " ").split()).strip()
    return text[:80]


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


def load_json_env(name: str) -> Any:
    raw = os.getenv(name)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def load_remote_planner_context() -> Any:
    inline_context = load_json_env("AI_PLANNER_CONTEXT_JSON")
    url = os.getenv("AI_PLANNER_CONTEXT_URL")
    if not url:
        return inline_context

    request = urllib.request.Request(url, headers={"Accept": "application/json,text/plain"})
    token = os.getenv("AI_PLANNER_CONTEXT_BEARER_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(request, timeout=float(os.getenv("AI_PLANNER_CONTEXT_TIMEOUT_SECONDS", "8"))) as response:
            body = response.read().decode("utf-8", errors="replace")
    except Exception as exc:
        return {
            "inline_context": inline_context,
            "remote_context_error": f"{type(exc).__name__}: {exc}",
        }

    try:
        remote_context: Any = json.loads(body)
    except json.JSONDecodeError:
        remote_context = body
    if inline_context is None:
        return remote_context
    return {"inline_context": inline_context, "remote_context": remote_context}


def normalize_plan(
    raw: dict[str, Any],
    prompt: str,
    has_video: bool,
    memory: dict[str, Any],
    default_prompt: str,
) -> dict[str, Any]:
    merged_memory = dict(memory)
    raw_memory = raw.get("memory_updates") or raw.get("memory") or {}
    if isinstance(raw_memory, dict):
        for key, value in raw_memory.items():
            if value not in (None, "", [], {}):
                merged_memory[str(key)] = value

    scenarios = make_unique([clean_label(item) for item in raw.get("roboflow_scenarios") or raw.get("scenarios") or []])
    request_scenarios = make_unique([clean_label(item) for item in raw.get("request_scenarios") or []])

    raw_weights = raw.get("label_weights") if isinstance(raw.get("label_weights"), dict) else {}
    label_weights: dict[str, float] = {}
    for label, weight in raw_weights.items():
        label_text = clean_label(label)
        if not label_text:
            continue
        try:
            label_weights[label_text] = max(0.0, min(1.0, float(weight)))
        except (TypeError, ValueError):
            continue

    validation_errors = []
    if has_video and bool(raw.get("ready", True)):
        if len(scenarios) < 2:
            validation_errors.append("AI did not return enough Roboflow scenario labels.")
        if not label_weights:
            validation_errors.append("AI did not return label_weights.")
        missing_weight_labels = [label for label in scenarios if label not in label_weights]
        if missing_weight_labels:
            validation_errors.append(
                "AI did not return weights for: " + ", ".join(missing_weight_labels[:4]) + "."
            )
        if raw.get("target_short_seconds") in (None, "", 0):
            validation_errors.append("AI did not choose target_short_seconds.")
        if raw.get("export_format") in (None, ""):
            validation_errors.append("AI did not choose export_format.")

    questions = [str(item).strip() for item in raw.get("questions", []) if str(item).strip()] if isinstance(raw.get("questions"), list) else []
    ready = bool(raw.get("ready", False)) and not questions and not validation_errors
    message = str(raw.get("message") or "").strip()
    if validation_errors and not message:
        message = "I need to regenerate the AI edit plan: " + " ".join(validation_errors)
    if not message:
        message = "I have the edit plan." if ready else "Tell me what you want from this video."

    resolved_prompt = str(raw.get("resolved_prompt") or prompt or default_prompt).strip()
    plan = {}
    if ready:
        plan = {
            "request": resolved_prompt,
            "roboflow_scenarios": scenarios,
            "request_scenarios": request_scenarios or scenarios,
            "label_weights": label_weights,
            "target_short_seconds": raw.get("target_short_seconds"),
            "clip_seconds": raw.get("clip_seconds"),
            "export_format": raw.get("export_format"),
            "selection_strategy": raw.get("selection_strategy") if isinstance(raw.get("selection_strategy"), dict) else {},
            "preview_policy": raw.get("preview_policy") if isinstance(raw.get("preview_policy"), dict) else {},
            "transition_policy": raw.get("transition_policy") if isinstance(raw.get("transition_policy"), dict) else {},
            "cross_check_required": bool(raw.get("cross_check_required", True)),
            "planner_source": raw.get("planner_source", "qwen"),
        }

    return {
        "ready": ready,
        "message": message,
        "questions": questions[:2],
        "memory": merged_memory,
        "resolved_prompt": resolved_prompt,
        "plan": plan,
    }


def build_ai_plan(
    prompt: str,
    has_video: bool,
    memory: dict[str, Any],
    default_prompt: str,
) -> dict[str, Any] | None:
    if os.getenv("ENABLE_AI_PLANNER") != "1":
        return None

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
        "You are the only planning brain for a universal video shorts editor. "
        "Do not rely on hidden rule-based defaults. If a default is useful, choose it yourself and explain it naturally. "
        "For greetings or unclear requests, respond like a human editor and ask concise follow-up questions. "
        "When ready, return a complete edit plan that the backend can execute without adding content assumptions. "
        "Roboflow scenario labels must be short visual labels. Include positive labels to keep and negative labels to skip. "
        "Return strict JSON only, no markdown."
    )
    contract = {
        "ready": "boolean; true only when enough detail exists to edit",
        "message": "natural response to the user",
        "questions": "array of at most two follow-up questions",
        "memory_updates": "object with any useful user preferences to remember",
        "resolved_prompt": "complete edit request after applying memory",
        "roboflow_scenarios": "array of short visual labels generated for this request",
        "label_weights": "object mapping each scenario label to a number from 0.0 skip to 1.0 keep",
        "target_short_seconds": "number chosen by AI when ready",
        "clip_seconds": "number or null chosen by AI when ready",
        "export_format": "vertical, horizontal, both, or auto",
        "selection_strategy": {
            "search_scope": "full_video",
            "spread_across_timeline": "boolean",
            "avoid_single_start_chunk": "boolean",
            "allow_single_long_clip": "boolean",
            "prefer_diverse_labels": "boolean",
            "minimum_clip_seconds": "number",
            "maximum_clip_seconds": "number",
            "context_before_seconds": "number",
            "context_after_seconds": "number",
            "boundary_gap_seconds": "number",
            "target_clip_count": "number or 0 for AI/backend to infer",
        },
        "preview_policy": "object",
        "transition_policy": "object",
        "request_scenarios": "array of human-readable intent notes",
    }
    user = {
        "user_prompt": prompt,
        "has_video": has_video,
        "current_memory": memory,
        "default_prompt": default_prompt,
        "online_planner_context": load_remote_planner_context(),
        "required_json_contract": contract,
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

    questions = []
    if os.getenv("ENABLE_AI_PLANNER") != "1":
        questions.append("Set ENABLE_AI_PLANNER=1 on the backend.")
    if not os.getenv("DASHSCOPE_API_KEY"):
        questions.append("Add DASHSCOPE_API_KEY on the backend.")

    detail = " ".join(questions) if questions else "Check the backend logs for the Qwen/DashScope error."
    return {
        "ready": False,
        "message": f"The AI planner is required but not ready. {detail}",
        "questions": questions[:2],
        "memory": memory,
        "resolved_prompt": prompt.strip() or default_prompt,
        "plan": {},
    }
