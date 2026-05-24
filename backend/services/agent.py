from typing import Any

from backend.ai_planner import build_agent_plan
from backend.core.config import DEFAULT_PROMPT


def build_resolved_prompt(prompt: str, memory: dict[str, Any]) -> str:
    details = []
    if memory.get("duration_seconds"):
        details.append(f"Target length: about {memory['duration_seconds']} seconds.")
    if memory.get("format"):
        details.append(f"Preferred export format: {memory['format']}.")
    if memory.get("styles"):
        details.append("Style: " + ", ".join(memory["styles"]) + ".")
    if memory.get("keep"):
        details.append("Prioritize: " + ", ".join(memory["keep"]) + ".")
    if memory.get("skip"):
        details.append("Avoid: " + ", ".join(memory["skip"]) + ".")
    if not details:
        return prompt.strip() or DEFAULT_PROMPT
    return (prompt.strip() or "Create a video short.") + "\n\nRemembered preferences:\n" + "\n".join(details)


def agent_check_result(
    prompt: str,
    has_video: bool,
    incoming_memory: dict[str, Any] | None = None,
    supplied_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    candidate_memory = dict(incoming_memory or {})
    result = build_agent_plan(prompt, has_video, candidate_memory, DEFAULT_PROMPT, supplied_plan=supplied_plan)
    result["resolved_prompt"] = result.get("resolved_prompt") or build_resolved_prompt(prompt, result.get("memory", {}))
    if isinstance(result.get("plan"), dict):
        result["plan"]["request"] = result["resolved_prompt"]
    else:
        result["plan"] = {}
    return result
