import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from backend.core.config import JOB_LOGS_DIR, JOBS_DIR, ROOT
from backend.core.storage import read_json, tail_text, write_json


RUNNING_PROCESSES: dict[str, subprocess.Popen] = {}


def job_log_dir(job_id: str) -> Path:
    path = JOB_LOGS_DIR / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def job_log_path(job_id: str, filename: str) -> Path:
    path = JOB_LOGS_DIR / job_id / filename
    if path.exists():
        return path
    return JOBS_DIR / job_id / filename


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
        "prompt": metadata.get("prompt", ""),
        "resolved_prompt": metadata.get("resolved_prompt", metadata.get("prompt", "")),
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
