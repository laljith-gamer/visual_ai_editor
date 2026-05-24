import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.ai_planner import build_agent_plan
from backend.env import load_project_env
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles


load_project_env(__file__)

BACKEND_DIR = Path(__file__).parent.resolve()
ROOT = BACKEND_DIR.parent
RUNTIME_ROOT = Path(os.getenv("RUNTIME_DIR") or ("/tmp/visual-ai-editor" if os.getenv("VERCEL") else ROOT)).resolve()
RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
JOBS_DIR = RUNTIME_ROOT / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
LOGS_DIR = RUNTIME_ROOT / "logs"
JOB_LOGS_DIR = LOGS_DIR / "jobs"
LOGS_DIR.mkdir(exist_ok=True)
JOB_LOGS_DIR.mkdir(exist_ok=True)
MEMORY_PATH = RUNTIME_ROOT / "editor_memory.json"

DEFAULT_PROMPT = (
    "Make a 30 second short from the strongest visual moments. "
    "Keep the parts that best match my request and skip boring, static, blurry, or repeated footage."
)

RUNNING_PROCESSES: dict[str, subprocess.Popen] = {}

app = FastAPI(title="Universal Video Shorts Editor")
allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,https://visual-ai-editor-ten.vercel.app",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=JOBS_DIR), name="media")


def read_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    for attempt in range(3):
        try:
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, PermissionError, OSError):
            if attempt == 2:
                return fallback
            time.sleep(0.05)


def write_json(path: Path, data: Any) -> None:
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    with temp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    last_error: OSError | None = None
    for attempt in range(30):
        try:
            os.replace(temp_path, path)
            return
        except PermissionError as exc:
            last_error = exc
            time.sleep(min(0.05 * (attempt + 1), 0.75))

    try:
        temp_path.unlink(missing_ok=True)
    finally:
        if last_error:
            raise last_error


def read_memory() -> dict[str, Any]:
    if os.getenv("ENABLE_SERVER_MEMORY") != "1":
        return {}
    memory = read_json(MEMORY_PATH, {})
    return memory if isinstance(memory, dict) else {}


def write_memory(memory: dict[str, Any]) -> None:
    if os.getenv("ENABLE_SERVER_MEMORY") != "1":
        return
    write_json(MEMORY_PATH, memory)


def job_log_dir(job_id: str) -> Path:
    path = JOB_LOGS_DIR / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def job_log_path(job_id: str, filename: str) -> Path:
    path = JOB_LOGS_DIR / job_id / filename
    if path.exists():
        return path
    return JOBS_DIR / job_id / filename


def parse_duration(prompt: str) -> int | None:
    text = prompt.lower()
    for match in re.finditer(
        r"\b(\d{1,3})\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m)\b",
        text,
    ):
        amount = int(match.group(1))
        unit = match.group(2)
        seconds = amount * 60 if unit.startswith("m") else amount
        if 5 <= seconds <= 300:
            return seconds

    for match in re.finditer(r"\b(15|20|30|45|60|90|120)\b", text):
        return int(match.group(1))
    return None


def has_any(text: str, words: tuple[str, ...]) -> bool:
    return any(word in text for word in words)


def extract_memory(prompt: str, base: dict[str, Any] | None = None) -> dict[str, Any]:
    memory = dict(base or {})
    text = prompt.lower()
    duration = parse_duration(prompt)
    if duration:
        memory["duration_seconds"] = duration

    if has_any(text, ("vertical", "shorts", "tiktok", "reel", "9:16")):
        memory["format"] = "vertical"
    elif has_any(text, ("horizontal", "youtube", "wide", "16:9")):
        memory["format"] = "horizontal"
    elif "both" in text:
        memory["format"] = "both"

    style_words = [
        "fast",
        "cinematic",
        "funny",
        "educational",
        "emotional",
        "dramatic",
        "calm",
        "detailed",
        "short",
        "quick",
    ]
    styles = set(memory.get("styles", []))
    for word in style_words:
        if word in text:
            styles.add(word)
    if styles:
        memory["styles"] = sorted(styles)

    keep_words = [
        "talking",
        "speech",
        "reaction",
        "combat",
        "cutscene",
        "cooking",
        "recipe",
        "lecture",
        "demo",
        "screen",
        "travel",
        "product",
        "sport",
        "dance",
        "funny",
    ]
    keep = set(memory.get("keep", []))
    for word in keep_words:
        if word in text:
            keep.add(word)
    if keep:
        memory["keep"] = sorted(keep)

    skip = set(memory.get("skip", []))
    for word in ("boring", "static", "blurry", "blank", "loading", "intro", "outro", "repeated", "silent"):
        if f"skip {word}" in text or f"avoid {word}" in text or f"no {word}" in text:
            skip.add(word)
    if skip:
        memory["skip"] = sorted(skip)

    if prompt.strip():
        memory["last_prompt"] = prompt.strip()
    memory["updated_at"] = datetime.now(timezone.utc).isoformat()
    return memory


def prompt_is_vague(prompt: str) -> bool:
    text = prompt.lower().strip()
    words = re.findall(r"[a-zA-Z0-9]+", text)
    if len(words) < 4:
        return True
    vague_phrases = (
        "edit this",
        "make short",
        "make shorts",
        "best clip",
        "best clips",
        "make it best",
        "make video",
        "do it",
    )
    return any(phrase in text for phrase in vague_phrases) and not has_any(
        text,
        (
            "talk",
            "reaction",
            "funny",
            "combat",
            "cutscene",
            "lecture",
            "cooking",
            "screen",
            "product",
            "travel",
            "sport",
            "seconds",
            "minute",
        ),
    )


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
    return (prompt.strip() or "Create a strong video short.") + "\n\nRemembered preferences:\n" + "\n".join(details)


def agent_check_result(
    prompt: str,
    has_video: bool,
    incoming_memory: dict[str, Any] | None = None,
    supplied_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    merged_memory = dict(incoming_memory or {})
    candidate_memory = extract_memory(prompt, merged_memory)

    quick_questions = []
    if not has_video:
        quick_questions.append("Upload a video first so I can analyze the actual footage.")
    if prompt_is_vague(prompt) and not candidate_memory.get("keep"):
        quick_questions.append("What kind of moments should I keep most?")
    if quick_questions:
        if has_video and not candidate_memory.get("duration_seconds"):
            quick_questions.append("How long should the final edit be?")
        if has_video and not candidate_memory.get("format"):
            quick_questions.append("Should I export vertical, horizontal, or both?")
        questions = quick_questions[:2]
        return {
            "ready": False,
            "message": "Before I run it, I need this: " + " ".join(questions),
            "questions": questions,
            "memory": candidate_memory,
            "resolved_prompt": build_resolved_prompt(prompt, candidate_memory),
            "plan": {},
        }

    result = build_agent_plan(prompt, has_video, candidate_memory, DEFAULT_PROMPT, supplied_plan=supplied_plan)
    missing_questions = []
    plan = result.get("plan", {}) if isinstance(result.get("plan"), dict) else {}
    if not candidate_memory.get("duration_seconds"):
        missing_questions.append("How long should the final edit be?")
    if not result["memory"].get("format") and plan.get("export_format") in (None, "", "auto"):
        missing_questions.append("Should I export vertical, horizontal, or both?")
    if prompt_is_vague(prompt) and not result["memory"].get("keep"):
        missing_questions.append("What kind of moments should I keep most?")
    if missing_questions and result["ready"]:
        result["ready"] = False
        result["questions"] = missing_questions[:2]
        result["message"] = "Before I run it, I need this: " + " ".join(result["questions"])
    result["resolved_prompt"] = build_resolved_prompt(result.get("resolved_prompt") or prompt, result["memory"])
    result["plan"]["request"] = result["resolved_prompt"]
    return result


def tail_text(path: Path, limit: int = 12000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-limit:]


def job_dir(job_id: str) -> Path:
    path = JOBS_DIR / job_id
    if not path.exists():
        raise HTTPException(status_code=404, detail="Job not found")
    return path


def media_url(job_id: str, relative_path: str) -> str:
    return f"/media/{job_id}/{relative_path.replace(os.sep, '/')}"


def start_processor(
    job_id: str,
    video_path: Path,
    prompt: str,
    edit_plan: dict[str, Any] | None = None,
    analysis_path: Path | None = None,
) -> None:
    directory = job_dir(job_id)
    logs = job_log_dir(job_id)
    stdout = (logs / "run.out.log").open("w", encoding="utf-8")
    stderr = (logs / "run.err.log").open("w", encoding="utf-8")
    env = os.environ.copy()
    env["VIDEO_PATH"] = str(video_path)
    env["JOB_DIR"] = str(directory)
    env["EDIT_REQUEST"] = prompt
    if edit_plan:
        env["EDIT_PLAN_JSON"] = json.dumps(edit_plan)
    if analysis_path and analysis_path.exists():
        env["ANALYSIS_PATH"] = str(analysis_path)

    process = subprocess.Popen(
        [sys.executable, "-u", "-m", "backend.processor"],
        cwd=str(ROOT),
        stdout=stdout,
        stderr=stderr,
        env=env,
    )
    stdout.close()
    stderr.close()
    RUNNING_PROCESSES[job_id] = process


def build_job_payload(job_id: str) -> dict[str, Any]:
    directory = job_dir(job_id)
    metadata = read_json(directory / "job.json", {})
    process = RUNNING_PROCESSES.get(job_id)
    return_code = process.poll() if process else metadata.get("return_code")

    if process and return_code is None:
        status = "running"
    elif (directory / "best_short_vertical.mp4").exists() or (directory / "best_short_horizontal.mp4").exists():
        status = "completed"
    elif return_code not in (None, 0):
        status = "failed"
    else:
        status = metadata.get("status", "created")

    if process and return_code is not None:
        metadata["return_code"] = return_code
        metadata["status"] = status
        write_json(directory / "job.json", metadata)
        RUNNING_PROCESSES.pop(job_id, None)

    highlights = read_json(directory / "highlights.json", [])
    clip_review = read_json(directory / "clip_review.json", {})
    progress = read_json(directory / "progress.json", {})
    predictions = read_json(directory / "predictions.json", [])
    report = tail_text(directory / "shorts_report.txt", limit=20000)

    files = {}
    if (directory / "input.mp4").exists():
        files["input"] = media_url(job_id, "input.mp4")
    elif metadata.get("source_job_id"):
        source_id = str(metadata["source_job_id"])
        source_input = JOBS_DIR / source_id / "input.mp4"
        if source_input.exists():
            files["input"] = media_url(source_id, "input.mp4")
    if (directory / "best_short_vertical.mp4").exists():
        files["vertical"] = media_url(job_id, "best_short_vertical.mp4")
    if (directory / "best_short_horizontal.mp4").exists():
        files["horizontal"] = media_url(job_id, "best_short_horizontal.mp4")
    if (directory / "shorts_report.txt").exists():
        files["report"] = media_url(job_id, "shorts_report.txt")
    if (directory / "clip_review.json").exists():
        files["clip_review"] = media_url(job_id, "clip_review.json")

    highlight_cards = []
    for clip in highlights:
        index = int(clip.get("index") or len(highlight_cards) + 1)
        segment_path = Path("short_segments") / f"segment_{index:02d}.mp4"
        highlight_cards.append(
            {
                **clip,
                "preview_url": media_url(job_id, str(segment_path))
                if (directory / segment_path).exists()
                else files.get("horizontal"),
            }
        )

    return {
        "job_id": job_id,
        "status": status,
        "prompt": metadata.get("prompt", DEFAULT_PROMPT),
        "resolved_prompt": metadata.get("resolved_prompt", metadata.get("prompt", DEFAULT_PROMPT)),
        "memory": metadata.get("memory", {}),
        "edit_plan": metadata.get("edit_plan", {}),
        "source_job_id": metadata.get("source_job_id"),
        "created_at": metadata.get("created_at"),
        "files": files,
        "highlights": highlight_cards,
        "clip_review": clip_review if isinstance(clip_review, dict) else {},
        "progress": progress if isinstance(progress, dict) else {},
        "predictions_count": len(predictions) if isinstance(predictions, list) else 0,
        "report": report,
        "stdout": tail_text(job_log_path(job_id, "run.out.log")),
        "stderr": tail_text(job_log_path(job_id, "run.err.log")),
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "default_prompt": DEFAULT_PROMPT}


@app.post("/api/agent/check")
def agent_check(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or "")
    has_video = bool(payload.get("has_video") or payload.get("job_id"))
    incoming_memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    supplied_plan = payload.get("plan") if isinstance(payload.get("plan"), dict) else None
    result = agent_check_result(prompt, has_video, incoming_memory, supplied_plan=supplied_plan)
    if result["ready"]:
        write_memory(result["memory"])
    return result


@app.post("/api/jobs")
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


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    return build_job_payload(job_id)


@app.post("/api/jobs/{job_id}/edits")
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
        raise HTTPException(status_code=409, detail="Wait until at least the first video analysis samples are saved before re-editing.")

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


@app.post("/api/jobs/{job_id}/export")
def export_job(job_id: str) -> dict[str, Any]:
    payload = build_job_payload(job_id)
    if payload["status"] != "completed":
        raise HTTPException(status_code=409, detail="Export is not ready yet")
    return payload


@app.get("/api/jobs")
def list_jobs() -> dict[str, list[dict[str, Any]]]:
    jobs = []
    for directory in sorted(JOBS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if directory.is_dir():
            try:
                jobs.append(build_job_payload(directory.name))
            except HTTPException:
                continue
    return {"jobs": jobs}
