import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from backend.core.config import DEFAULT_PROMPT, JOBS_DIR
from backend.core.storage import read_json, write_json
from backend.services.agent import agent_check_result
from backend.services.jobs import (
    RUNNING_PROCESSES,
    build_job_payload,
    job_dir,
    safe_job_id,
    start_processor,
)
from backend.services.memory import write_memory
from backend.services.roboflow import compact_scenarios, get_roboflow_client


router = APIRouter()


def clean_base64_image(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value") or value.get("image") or ""
    image_value = str(value or "").strip()
    if "," in image_value:
        image_value = image_value.split(",", 1)[1]
    return image_value


def coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:
        return default
    return number


def parse_json_value(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("```"):
            text = text.strip("`").strip()
            if text.lower().startswith("json"):
                text = text[4:].strip()
        if text.startswith("{") and text.endswith("}"):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return value
    return value


def build_temporal_prompt(user_request: str, scenarios: list[str]) -> str:
    scenarios_text = ", ".join(scenarios)
    return (
        "You are a professional short-form video editor. The input image is a contact sheet of consecutive "
        "frames arranged chronologically from left to right, top to bottom. Each thumbnail has a frame number.\n\n"
        f"User request: {user_request}\n\n"
        f"Allowed event labels: {scenarios_text}\n\n"
        "Decide whether this window should be kept in the final edit. Judge visual payoff, action, emotion, "
        "clarity, novelty, usefulness, and whether it matches the user request. Penalize filler, repeated action, "
        "menus, loading screens, black frames, blurry frames, weak moments, and anything the user asked to skip.\n\n"
        "Return only strict JSON with these fields: event_label, keep_score, skip_score, confidence, "
        "suggested_clip_start_offset_seconds, suggested_clip_end_offset_seconds, reason, title_overlay, "
        "title_overlay_start_offset_seconds, title_overlay_end_offset_seconds. Scores must be numbers from 0 to 1. "
        "Use title_overlay only for a clear memorable payoff that deserves on-screen text."
    )


def normalize_temporal_result(raw: dict[str, Any], window_start: float, window_end: float) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for value in raw.values():
        possible = parse_json_value(value)
        if isinstance(possible, dict):
            parsed.update(possible)
    parsed.update({key: parse_json_value(value) for key, value in raw.items() if not isinstance(parse_json_value(value), dict)})

    return {
        "window_start": window_start,
        "window_end": window_end,
        "event_label": str(parsed.get("event_label") or parsed.get("scene_label") or "").strip(),
        "keep_score": coerce_float(parsed.get("keep_score"), 0.0),
        "skip_score": coerce_float(parsed.get("skip_score"), 0.0),
        "confidence": coerce_float(parsed.get("confidence"), 0.0),
        "suggested_clip_start_offset_seconds": coerce_float(
            parsed.get("suggested_clip_start_offset_seconds"),
            0.0,
        ),
        "suggested_clip_end_offset_seconds": coerce_float(
            parsed.get("suggested_clip_end_offset_seconds"),
            0.0,
        ),
        "reason": str(parsed.get("reason") or "").strip(),
        "title_overlay": str(parsed.get("title_overlay") or "").strip()[:40],
        "title_overlay_start_offset_seconds": coerce_float(parsed.get("title_overlay_start_offset_seconds"), 0.0),
        "title_overlay_end_offset_seconds": coerce_float(parsed.get("title_overlay_end_offset_seconds"), 0.0),
        "fallback": bool(parsed.get("fallback")),
    }


@router.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "default_prompt": DEFAULT_PROMPT}


@router.post("/api/agent/check")
def agent_check(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or "")
    has_video = bool(payload.get("has_video") or payload.get("job_id"))
    incoming_memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    supplied_plan = payload.get("plan") if isinstance(payload.get("plan"), dict) else None
    result = agent_check_result(prompt, has_video, incoming_memory, supplied_plan=supplied_plan)
    if result["ready"]:
        write_memory(result["memory"])
    return result


@router.post("/api/browser/analyze")
def analyze_browser_frames(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    frames = payload.get("frames")
    if not isinstance(frames, list) or not frames:
        raise HTTPException(status_code=400, detail="frames must be a non-empty list")
    if len(frames) > 8:
        raise HTTPException(status_code=400, detail="send at most 8 frames per request")

    try:
        scenarios = compact_scenarios(payload.get("scenarios"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    workspace = payload.get("workspace") or os.getenv("ROBOFLOW_WORKSPACE")
    workflow_id = payload.get("workflow_id") or os.getenv("ROBOFLOW_WORKFLOW_ID")
    if not workspace or not workflow_id:
        raise HTTPException(status_code=500, detail="Roboflow workspace/workflow is not configured")
    predictions = []

    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue
        try:
            second = float(frame.get("second") or 0)
        except (TypeError, ValueError):
            second = 0.0
        image_value = str(frame.get("image") or "")
        if "," in image_value:
            image_value = image_value.split(",", 1)[1]
        if not image_value:
            continue

        try:
            result = get_roboflow_client().run_workflow(
                workspace_name=workspace,
                workflow_id=workflow_id,
                images={"image": image_value},
                parameters={"scenarios": scenarios},
                use_cache=True,
            )
            frame_result = result[0] if result else {}
            label = frame_result.get("scene_label") or scenarios[0]
            confidence = frame_result.get("confidence")
            all_scores = frame_result.get("all_scores")
        except Exception as exc:
            label = scenarios[0]
            confidence = 0.05
            all_scores = []
            frame_result = {"fallback": True, "fallback_reason": f"{type(exc).__name__}: {exc}"}

        predictions.append(
            {
                "second": second,
                "frame": int(frame.get("frame") or index),
                "scene": label,
                "confidence": confidence if isinstance(confidence, (int, float)) else 0.05,
                "all_scores": all_scores if isinstance(all_scores, list) else [],
                "scenarios": scenarios,
                "fallback": bool(frame_result.get("fallback")),
                "fallback_reason": frame_result.get("fallback_reason"),
            }
        )

    return {"predictions": predictions, "scenarios": scenarios}


@router.post("/api/browser/event-analyze")
def analyze_browser_event(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    image_value = clean_base64_image(payload.get("image") or payload.get("collage"))
    if not image_value:
        raise HTTPException(status_code=400, detail="image must be a base64 JPEG contact sheet")

    try:
        scenarios = compact_scenarios(payload.get("scenarios"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user_request = str(payload.get("user_request") or payload.get("prompt") or "").strip()
    window_start = coerce_float(payload.get("window_start"), 0.0)
    window_end = coerce_float(payload.get("window_end"), window_start)
    workspace = payload.get("workspace") or os.getenv("ROBOFLOW_WORKSPACE")
    workflow_id = (
        payload.get("workflow_id")
        or os.getenv("ROBOFLOW_EVENT_WORKFLOW_ID")
        or os.getenv("ROBOFLOW_WORKFLOW_B_ID")
    )
    if not workspace or not workflow_id:
        raise HTTPException(status_code=500, detail="Roboflow temporal workflow is not configured")

    prompt_text = build_temporal_prompt(user_request, scenarios)
    try:
        result = get_roboflow_client().run_workflow(
            workspace_name=workspace,
            workflow_id=workflow_id,
            images={"image": image_value},
            parameters={"scenarios": scenarios, "prompt_text": prompt_text},
            use_cache=True,
        )
        raw_result = result[0] if result else {}
        if not isinstance(raw_result, dict):
            raw_result = {"event_label": str(raw_result)}
        normalized = normalize_temporal_result(raw_result, window_start, window_end)
        normalized["fallback"] = False
        return normalized
    except Exception as exc:
        return {
            "window_start": window_start,
            "window_end": window_end,
            "event_label": "event analyzer unavailable",
            "keep_score": 0.0,
            "skip_score": 1.0,
            "confidence": 0.0,
            "suggested_clip_start_offset_seconds": 0.0,
            "suggested_clip_end_offset_seconds": 0.0,
            "reason": f"{type(exc).__name__}: {exc}",
            "title_overlay": "",
            "title_overlay_start_offset_seconds": 0.0,
            "title_overlay_end_offset_seconds": 0.0,
            "fallback": True,
        }


@router.post("/api/jobs")
async def create_job(
    video: UploadFile = File(...),
    prompt: str = Form(""),
    memory_json: str = Form("{}"),
    plan_json: str = Form("{}"),
) -> JSONResponse:
    if not video.filename:
        raise HTTPException(status_code=400, detail="Video file is required")

    try:
        incoming_memory = json.loads(memory_json) if memory_json else {}
    except json.JSONDecodeError:
        incoming_memory = {}
    try:
        supplied_plan = json.loads(plan_json) if plan_json else {}
    except json.JSONDecodeError:
        supplied_plan = {}
    check = agent_check_result(
        prompt,
        True,
        incoming_memory,
        supplied_plan=supplied_plan if isinstance(supplied_plan, dict) and supplied_plan else None,
    )
    if not check["ready"]:
        raise HTTPException(status_code=409, detail=check)

    job_id = uuid.uuid4().hex[:12]
    directory = JOBS_DIR / job_id
    directory.mkdir(parents=True, exist_ok=True)

    suffix = Path(video.filename).suffix or ".mp4"
    input_path = directory / f"input{suffix}"
    with input_path.open("wb") as f:
        while chunk := await video.read(1024 * 1024):
            f.write(chunk)

    canonical_input = directory / "input.mp4"
    if input_path != canonical_input:
        input_path.replace(canonical_input)

    metadata = {
        "job_id": job_id,
        "prompt": prompt or DEFAULT_PROMPT,
        "resolved_prompt": check["resolved_prompt"],
        "memory": check["memory"],
        "edit_plan": check["plan"],
        "status": "running",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "filename": video.filename,
        "kind": "analysis",
    }
    write_json(directory / "job.json", metadata)
    write_memory(check["memory"])
    start_processor(job_id, canonical_input, check["resolved_prompt"], edit_plan=check["plan"])

    return JSONResponse(build_job_payload(job_id))


@router.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    return build_job_payload(job_id)


@router.post("/api/jobs/{job_id}/manual")
def update_manual_job(job_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    normalized_job_id = safe_job_id(job_id)
    directory = JOBS_DIR / normalized_job_id
    directory.mkdir(parents=True, exist_ok=True)

    highlights = payload.get("highlights")
    if not isinstance(highlights, list):
        raise HTTPException(status_code=400, detail="highlights must be a list")

    memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    edit_plan = payload.get("edit_plan") if isinstance(payload.get("edit_plan"), dict) else {}
    updated_at = datetime.now(timezone.utc).isoformat()
    selected_duration = 0.0
    for clip in highlights:
        if not isinstance(clip, dict):
            continue
        try:
            selected_duration += float(clip.get("duration") or 0)
        except (TypeError, ValueError):
            continue
    manual_state = {
        "job_id": normalized_job_id,
        "updated_at": updated_at,
        "source": "manual_editor",
        "prompt": str(payload.get("prompt") or ""),
        "resolved_prompt": str(payload.get("resolved_prompt") or payload.get("prompt") or ""),
        "memory": memory,
        "edit_plan": edit_plan,
        "highlights": highlights,
        "selected_duration": selected_duration,
    }
    write_json(directory / "manual_state.json", manual_state)

    metadata = read_json(directory / "job.json", {})
    if not isinstance(metadata, dict):
        metadata = {}
    metadata.update(
        {
            "job_id": normalized_job_id,
            "prompt": manual_state["prompt"] or metadata.get("prompt", ""),
            "resolved_prompt": manual_state["resolved_prompt"] or metadata.get("resolved_prompt", ""),
            "memory": memory or metadata.get("memory", {}),
            "edit_plan": edit_plan or metadata.get("edit_plan", {}),
            "status": metadata.get("status", "completed"),
            "kind": metadata.get("kind", "browser_manual"),
            "manual_updated_at": updated_at,
        }
    )
    write_json(directory / "job.json", metadata)

    return {"ok": True, "job_id": normalized_job_id, "manual_updated_at": updated_at}


@router.post("/api/jobs/{job_id}/edits")
def create_reedit(job_id: str, payload: dict[str, Any] = Body(...)) -> JSONResponse:
    source_directory = job_dir(job_id)
    source_metadata = read_json(source_directory / "job.json", {})

    input_source_job_id = job_id
    source_input = source_directory / "input.mp4"
    if not source_input.exists() and source_metadata.get("source_job_id"):
        input_source_job_id = str(source_metadata["source_job_id"])
        source_input = JOBS_DIR / input_source_job_id / "input.mp4"
    if not source_input.exists():
        raise HTTPException(status_code=404, detail="Source video is missing")

    source_predictions = source_directory / "predictions.json"
    if not source_predictions.exists() and source_metadata.get("source_job_id"):
        source_predictions = JOBS_DIR / str(source_metadata["source_job_id"]) / "predictions.json"

    process = RUNNING_PROCESSES.get(job_id)
    if process and process.poll() is None and not source_predictions.exists():
        raise HTTPException(
            status_code=409,
            detail="Wait until at least the first video analysis samples are saved before re-editing.",
        )

    prompt = str(payload.get("prompt") or "")
    incoming_memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    supplied_plan = payload.get("plan") if isinstance(payload.get("plan"), dict) else None
    check = agent_check_result(prompt, True, incoming_memory, supplied_plan=supplied_plan)
    if not check["ready"]:
        raise HTTPException(status_code=409, detail=check)

    new_job_id = uuid.uuid4().hex[:12]
    directory = JOBS_DIR / new_job_id
    directory.mkdir(parents=True, exist_ok=True)

    if source_predictions.exists():
        shutil.copy2(source_predictions, directory / "predictions.json")

    metadata = {
        "job_id": new_job_id,
        "source_job_id": input_source_job_id,
        "prompt": prompt or source_metadata.get("prompt") or DEFAULT_PROMPT,
        "resolved_prompt": check["resolved_prompt"],
        "memory": check["memory"],
        "edit_plan": check["plan"],
        "status": "running",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "filename": source_metadata.get("filename", source_input.name),
        "kind": "reedit",
    }
    write_json(directory / "job.json", metadata)
    write_memory(check["memory"])
    start_processor(
        new_job_id,
        source_input,
        check["resolved_prompt"],
        edit_plan=check["plan"],
        analysis_path=source_predictions if source_predictions.exists() else None,
    )
    return JSONResponse(build_job_payload(new_job_id))


@router.post("/api/jobs/{job_id}/export")
def export_job(job_id: str) -> dict[str, Any]:
    payload = build_job_payload(job_id)
    if payload["status"] != "completed":
        raise HTTPException(status_code=409, detail="Export is not ready yet")
    return payload


@router.get("/api/jobs")
def list_jobs() -> dict[str, list[dict[str, Any]]]:
    jobs = []
    for directory in sorted(JOBS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if directory.is_dir():
            try:
                jobs.append(build_job_payload(directory.name))
            except HTTPException:
                continue
    return {"jobs": jobs}
