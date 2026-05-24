import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from backend.env import load_project_env
from inference_sdk import InferenceHTTPClient


load_project_env(__file__)

def make_unique(items: list[str]) -> list[str]:
    unique = []
    seen = set()
    for item in items:
        normalized = str(item or "").strip().lower()
        if normalized and normalized not in seen:
            unique.append(str(item).strip())
            seen.add(normalized)
    return unique


def compact_label(label: str, max_words: int = 6) -> str:
    text = " ".join(str(label or "").replace("\n", " ").split()).strip()
    if not text:
        return ""
    return text[:80]


def load_json_env(name: str) -> dict:
    raw = os.environ.get(name)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


BASE_DIR = Path(os.environ.get("JOB_DIR") or ".").resolve()
BASE_DIR.mkdir(parents=True, exist_ok=True)

VIDEO_PATH = Path(
    os.environ.get(
        "VIDEO_PATH",
        "input.mp4",
    )
).resolve()
PREDICTIONS_PATH = (BASE_DIR / "predictions.json").resolve()
ANALYSIS_SOURCE_PATH = Path(os.environ.get("ANALYSIS_PATH") or PREDICTIONS_PATH).resolve()
HIGHLIGHTS_PATH = (BASE_DIR / "highlights.json").resolve()
CLIP_REVIEW_PATH = (BASE_DIR / "clip_review.json").resolve()
PROGRESS_PATH = (BASE_DIR / "progress.json").resolve()
REPORT_PATH = (BASE_DIR / "shorts_report.txt").resolve()
SHORT_HORIZONTAL_PATH = (BASE_DIR / "best_short_horizontal.mp4").resolve()
SHORT_VERTICAL_PATH = (BASE_DIR / "best_short_vertical.mp4").resolve()
SEGMENTS_DIR = (BASE_DIR / "short_segments").resolve()

WORKSPACE = os.environ.get("ROBOFLOW_WORKSPACE")
WORKFLOW_ID = os.environ.get("ROBOFLOW_WORKFLOW_ID")
EDIT_REQUEST = os.environ.get("EDIT_REQUEST", "").strip()
EXTERNAL_EDIT_PLAN = load_json_env("EDIT_PLAN_JSON")

ANALYSIS_SCENARIOS = make_unique(
    [compact_label(str(item)) for item in EXTERNAL_EDIT_PLAN.get("roboflow_scenarios", []) if str(item).strip()]
)

SAMPLE_EVERY_SECONDS = float(os.environ.get("SAMPLE_EVERY_SECONDS") or 1)
MAX_SAMPLES = int(os.environ.get("MAX_SAMPLES") or 0)
INFERENCE_WIDTH = int(os.environ.get("INFERENCE_WIDTH") or 960)
MIN_CLIP_SCORE = float(os.environ.get("MIN_CLIP_SCORE") or 0.1)
ROBOFLOW_DISABLE_AFTER_FAILURES = int(os.environ.get("ROBOFLOW_DISABLE_AFTER_FAILURES") or 2)
EXPORT_FORMATS = {"vertical", "horizontal", "both", "auto"}


client: InferenceHTTPClient | None = None
roboflow_failure_count = 0
roboflow_disabled = False


def get_roboflow_client() -> InferenceHTTPClient:
    global client
    if client is None:
        api_key = os.environ.get("ROBOFLOW_API_KEY")
        if not api_key:
            raise RuntimeError("Set ROBOFLOW_API_KEY before analyzing new video frames.")
        client = InferenceHTTPClient.init(
            api_url=os.environ.get("ROBOFLOW_API_URL", "https://serverless.roboflow.com"),
            api_key=api_key,
        )
    return client


def clamp_number(value: object, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def normalize_export_format(value: object) -> str:
    text = str(value or "auto").strip().lower()
    return text if text in EXPORT_FORMATS else "auto"


def normalize_selection_strategy(raw: object) -> dict:
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


def normalize_preview_policy(raw: object) -> dict:
    policy = raw if isinstance(raw, dict) else {}
    return {
        "preview_source": str(policy.get("preview_source") or "selected_clip").strip() or "selected_clip",
        "hover_preview": bool(policy.get("hover_preview", True)),
        "show_review_before_export": bool(policy.get("show_review_before_export", True)),
    }


def normalize_transition_policy(raw: object) -> dict:
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


def build_plan_from_ai(user_request: str) -> dict:
    if not EXTERNAL_EDIT_PLAN:
        raise RuntimeError("EDIT_PLAN_JSON is required. The processor no longer creates rule-based edit plans.")
    if len(ANALYSIS_SCENARIOS) < 2:
        raise RuntimeError("AI edit plan must include at least two roboflow_scenarios.")

    raw_weights = EXTERNAL_EDIT_PLAN.get("label_weights")
    if not isinstance(raw_weights, dict):
        raise RuntimeError("AI edit plan must include label_weights.")

    weights = {}
    for label in ANALYSIS_SCENARIOS:
        try:
            weights[label] = max(0.0, min(1.0, float(raw_weights[label])))
        except (KeyError, TypeError, ValueError):
            raise RuntimeError(f"AI edit plan missing numeric label weight for: {label}") from None

    target_seconds = clamp_number(EXTERNAL_EDIT_PLAN.get("target_short_seconds"), 30.0, 5.0, 300.0)
    if EXTERNAL_EDIT_PLAN.get("target_short_seconds") in (None, "", 0):
        raise RuntimeError("AI edit plan must include target_short_seconds.")
    clip_seconds = clamp_number(
        EXTERNAL_EDIT_PLAN.get("clip_seconds"),
        8.0,
        4.0,
        30.0,
    )
    raw_export_format = str(EXTERNAL_EDIT_PLAN.get("export_format") or "").strip().lower()
    if raw_export_format not in EXPORT_FORMATS:
        raise RuntimeError("AI edit plan must include export_format: vertical, horizontal, both, or auto.")
    request_scenarios = make_unique(
        [str(item) for item in EXTERNAL_EDIT_PLAN.get("request_scenarios", []) if str(item).strip()]
    )
    selection_strategy = normalize_selection_strategy(EXTERNAL_EDIT_PLAN.get("selection_strategy"))
    preview_policy = normalize_preview_policy(EXTERNAL_EDIT_PLAN.get("preview_policy"))
    transition_policy = normalize_transition_policy(EXTERNAL_EDIT_PLAN.get("transition_policy"))

    return {
        "request": EXTERNAL_EDIT_PLAN.get("request") or user_request,
        "scenarios": ANALYSIS_SCENARIOS,
        "request_scenarios": request_scenarios[:12],
        "label_weights": weights,
        "label_groups": {
            "keep": [label for label in ANALYSIS_SCENARIOS if weights.get(label, 0) >= 0.8],
            "skip": [label for label in ANALYSIS_SCENARIOS if weights.get(label, 0) <= 0.05],
            "neutral": [label for label in ANALYSIS_SCENARIOS if 0.05 < weights.get(label, 0) < 0.8],
        },
        "target_short_seconds": target_seconds,
        "clip_seconds": clip_seconds,
        "export_format": raw_export_format,
        "selection_strategy": selection_strategy,
        "preview_policy": preview_policy,
        "transition_policy": transition_policy,
        "cross_check_required": bool(EXTERNAL_EDIT_PLAN.get("cross_check_required", True)),
        "planner_source": EXTERNAL_EDIT_PLAN.get("planner_source", "ai"),
    }


def build_edit_plan(user_request: str) -> dict:
    return build_plan_from_ai(user_request)


EDIT_PLAN = build_edit_plan(EDIT_REQUEST)
ANALYSIS_SIGNATURE = hashlib.sha1(
    json.dumps(
        {
            "scenarios": ANALYSIS_SCENARIOS,
            "sample_every_seconds": SAMPLE_EVERY_SECONDS,
            "inference_width": INFERENCE_WIDTH,
            "workflow_id": WORKFLOW_ID,
        },
        sort_keys=True,
    ).encode("utf-8")
).hexdigest()


def run_command(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-3000:] or "Command failed")


def load_predictions() -> list[dict]:
    if not ANALYSIS_SOURCE_PATH.exists():
        return []

    with ANALYSIS_SOURCE_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise RuntimeError(f"{ANALYSIS_SOURCE_PATH} must contain a JSON list")

    reusable = []
    for item in data:
        signature = item.get("analysis_signature") or item.get("plan_signature")
        if signature == ANALYSIS_SIGNATURE:
            reusable.append(item)
    if reusable:
        return reusable
    return []


def save_json(path: Path, data: object) -> None:
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


def write_progress(stage: str, percent: float, message: str, details: dict | None = None) -> None:
    payload = {
        "stage": stage,
        "percent": int(max(0, min(100, round(percent)))),
        "message": message,
        "updated_at": time.time(),
    }
    if details:
        payload["details"] = details
    save_json(PROGRESS_PATH, payload)
    print(f"PROGRESS {payload['percent']}% {stage}: {message}", flush=True)


def format_time(seconds: float) -> str:
    total_seconds = int(round(seconds))
    minutes = total_seconds // 60
    remaining_seconds = total_seconds % 60
    return f"{minutes}:{remaining_seconds:02d}"


def format_sample_interval(seconds: float) -> str:
    unit = "second" if seconds == 1 else "seconds"
    return f"{seconds:g} {unit}"


def resize_for_inference(frame_bgr: np.ndarray) -> np.ndarray:
    height, width = frame_bgr.shape[:2]
    if width <= INFERENCE_WIDTH:
        return frame_bgr

    scale = INFERENCE_WIDTH / width
    return cv2.resize(frame_bgr, (INFERENCE_WIDTH, int(height * scale)))


def local_frame_result(frame_bgr: np.ndarray, reason: str) -> dict:
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    brightness = float(np.mean(gray))
    contrast = float(np.std(gray))
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    ordered_by_weight = sorted(
        EDIT_PLAN["label_weights"].items(),
        key=lambda item: item[1],
    )
    lowest_label = ordered_by_weight[0][0]
    highest_label = ordered_by_weight[-1][0]
    if brightness < 12 or contrast < 7 or blur_score < 18:
        label = lowest_label
        confidence = 0.62
    else:
        preferred = EDIT_PLAN.get("label_groups", {}).get("keep") or []
        label = preferred[0] if preferred else highest_label
        confidence = 0.38

    all_scores = [0.05 for _ in ANALYSIS_SCENARIOS]
    if label in ANALYSIS_SCENARIOS:
        all_scores[ANALYSIS_SCENARIOS.index(label)] = confidence

    return {
        "scene_label": label,
        "confidence": confidence,
        "all_scores": all_scores,
        "fallback": True,
        "fallback_reason": reason,
        "frame_metrics": {
            "brightness": round(brightness, 2),
            "contrast": round(contrast, 2),
            "blur": round(blur_score, 2),
        },
    }


def classify_frame(frame_bgr: np.ndarray) -> dict:
    global roboflow_disabled, roboflow_failure_count

    original_frame = frame_bgr
    if roboflow_disabled:
        return local_frame_result(original_frame, "roboflow disabled after repeated failures")
    if not WORKSPACE or not WORKFLOW_ID:
        raise RuntimeError("ROBOFLOW_WORKSPACE and ROBOFLOW_WORKFLOW_ID are required")

    frame_bgr = resize_for_inference(frame_bgr)
    ok, buffer = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("Could not encode frame as JPEG")

    frame_b64 = base64.b64encode(buffer).decode("utf-8")
    last_error = None
    for attempt in range(1, 4):
        try:
            result = get_roboflow_client().run_workflow(
                workspace_name=WORKSPACE,
                workflow_id=WORKFLOW_ID,
                images={"image": frame_b64},
                parameters={"scenarios": ANALYSIS_SCENARIOS},
                use_cache=True,
            )
            if not result:
                raise RuntimeError("Workflow returned no results")
            return result[0]
        except Exception as exc:
            last_error = exc
            if attempt == 3:
                break
            time.sleep(2 * attempt)

    roboflow_failure_count += 1
    if roboflow_failure_count >= ROBOFLOW_DISABLE_AFTER_FAILURES:
        roboflow_disabled = True
    print(
        f"Roboflow workflow failed after 3 attempts; using local fallback for this frame. Error: {last_error}",
        file=sys.stderr,
        flush=True,
    )
    return local_frame_result(original_frame, f"roboflow error: {last_error}")


def video_info(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    finally:
        cap.release()

    return {
        "fps": float(fps),
        "width": width,
        "height": height,
        "total_frames": total_frames,
        "duration": total_frames / fps if fps else 0,
    }


def classify_video(info: dict) -> list[dict]:
    predictions = load_predictions()
    predictions_by_frame = {int(item["frame"]): item for item in predictions if "frame" in item}

    fps = info["fps"]
    total_frames = info["total_frames"]
    stride = max(1, int(round(fps * SAMPLE_EVERY_SECONDS)))
    sample_frames = list(range(0, total_frames, stride))
    total_samples = len(sample_frames)

    if predictions and ANALYSIS_SOURCE_PATH != PREDICTIONS_PATH:
        save_json(PREDICTIONS_PATH, predictions)
        print(f"Reusing analysis index from {ANALYSIS_SOURCE_PATH}", flush=True)
    if len(predictions_by_frame) >= total_samples and total_samples:
        write_progress(
            "analyzing",
            60,
            f"Using saved full-video analysis: {len(predictions_by_frame)}/{total_samples} samples.",
            {"samples_done": len(predictions_by_frame), "samples_total": total_samples},
        )
        print(
            f"Using saved video analysis: {len(predictions_by_frame)}/{total_samples} samples already indexed.",
            flush=True,
        )
        return predictions

    cap = cv2.VideoCapture(str(VIDEO_PATH))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {VIDEO_PATH}")

    completed_now = 0
    print(
        f"Classifying {VIDEO_PATH.name}: {info['width']}x{info['height']} @ {fps:.2f} FPS, {info['duration']:.1f}s",
        flush=True,
    )
    print(
        f"Sampling every {SAMPLE_EVERY_SECONDS:g}s: {total_samples} total samples, {len(predictions_by_frame)} already saved",
        flush=True,
    )
    write_progress(
        "analyzing",
        8,
        f"Sampling the full video every {format_sample_interval(SAMPLE_EVERY_SECONDS)}.",
        {"samples_done": len(predictions_by_frame), "samples_total": total_samples},
    )

    try:
        for sample_no, frame_idx in enumerate(sample_frames, start=1):
            if frame_idx in predictions_by_frame:
                continue

            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue

            seconds = frame_idx / fps
            result = classify_frame(frame)
            label = result.get("scene_label")
            confidence = result.get("confidence")
            all_scores = result.get("all_scores")
            scored_scenarios = []
            if isinstance(all_scores, list):
                scored_scenarios = [
                    {"label": label_text, "score": score}
                    for label_text, score in zip(ANALYSIS_SCENARIOS, all_scores)
                ]
            prediction = {
                "second": seconds,
                "frame": frame_idx,
                "scene": label,
                "confidence": confidence,
                "all_scores": all_scores,
                "scored_scenarios": scored_scenarios,
                "scenarios": ANALYSIS_SCENARIOS,
                "edit_request": EDIT_PLAN["request"],
                "analysis_signature": ANALYSIS_SIGNATURE,
            }

            predictions.append(prediction)
            predictions_by_frame[frame_idx] = prediction
            predictions.sort(key=lambda item: item["frame"])
            save_json(PREDICTIONS_PATH, predictions)

            completed_now += 1
            confidence_text = f"{confidence:.3f}" if isinstance(confidence, (int, float)) else "n/a"
            print(f"[{sample_no}/{total_samples}] t={seconds:.1f}s | {label} ({confidence_text})", flush=True)
            if sample_no == total_samples or sample_no % 5 == 0:
                progress_percent = 8 + (52 * (sample_no / max(total_samples, 1)))
                write_progress(
                    "analyzing",
                    progress_percent,
                    f"Analyzed {sample_no}/{total_samples} full-video samples.",
                    {"samples_done": sample_no, "samples_total": total_samples},
                )

            if MAX_SAMPLES and completed_now >= MAX_SAMPLES:
                print(f"Reached MAX_SAMPLES={MAX_SAMPLES}; using available predictions.", flush=True)
                break
    finally:
        cap.release()

    return predictions


def prediction_score(prediction: dict) -> float:
    label = prediction.get("scene")
    confidence = prediction.get("confidence")
    base = EDIT_PLAN["label_weights"].get(label, 0.0)
    if isinstance(confidence, (int, float)):
        return base * (0.75 + confidence)
    return base


def is_bad_label(label: str | None) -> bool:
    return EDIT_PLAN["label_weights"].get(label, 0.0) <= 0.05


def is_strong_bad_label(label: str | None) -> bool:
    return EDIT_PLAN["label_weights"].get(label, 0.0) <= 0.01


def has_bad_sample(samples: list[dict], start: float, end: float) -> bool:
    return any(start <= item["second"] < end and is_bad_label(item.get("scene")) for item in samples)


def build_highlights(predictions: list[dict], duration: float) -> list[dict]:
    if not predictions:
        return []

    scored = [{**prediction, "score": prediction_score(prediction)} for prediction in predictions]
    scored.sort(key=lambda item: item["second"])

    target_short_seconds = float(EDIT_PLAN["target_short_seconds"])
    label_weights = EDIT_PLAN["label_weights"]
    selection_strategy = normalize_selection_strategy(EDIT_PLAN.get("selection_strategy"))
    min_clip_seconds = float(selection_strategy["minimum_clip_seconds"])
    max_clip_seconds = float(selection_strategy["maximum_clip_seconds"])
    context_before = float(selection_strategy["context_before_seconds"])
    context_after = float(selection_strategy["context_after_seconds"])
    boundary_gap = max(float(selection_strategy["boundary_gap_seconds"]), SAMPLE_EVERY_SECONDS * 1.5)
    allow_single_long_clip = bool(selection_strategy.get("allow_single_long_clip"))

    def is_keep_sample(item: dict) -> bool:
        label = item.get("scene")
        weight = label_weights.get(label, 0.0)
        return not is_bad_label(label) and weight > 0.05 and float(item.get("score") or 0) >= MIN_CLIP_SCORE

    def label_summary(samples: list[dict]) -> list[str]:
        counts: dict[str, int] = {}
        for sample in samples:
            label = sample.get("scene")
            if label and not is_bad_label(label):
                counts[label] = counts.get(label, 0) + 1
        return [label for label, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:4]]

    def clean_bounds(start: float, end: float, keep_samples: list[dict]) -> tuple[float, float, str]:
        reason = "bounded by the nearest low-value or missing-analysis region"
        first_keep = min(float(item["second"]) for item in keep_samples)
        last_keep = max(float(item["second"]) for item in keep_samples) + SAMPLE_EVERY_SECONDS
        start = max(0.0, min(start, first_keep))
        end = min(duration, max(end, last_keep))

        bad_before = [
            item for item in scored
            if start <= float(item["second"]) < first_keep and is_bad_label(item.get("scene"))
        ]
        bad_after = [
            item for item in scored
            if last_keep <= float(item["second"]) < end and is_bad_label(item.get("scene"))
        ]
        if bad_before:
            start = max(start, max(float(item["second"]) + SAMPLE_EVERY_SECONDS for item in bad_before))
            reason = "started after nearby low-value footage"
        if bad_after:
            end = min(end, min(float(item["second"]) for item in bad_after))
            reason = "ended before nearby low-value footage"
        return max(0.0, start), min(duration, max(start + 0.1, end)), reason

    def make_candidate(
        event_samples: list[dict],
        boundary_reason: str,
        forced_start: float | None = None,
        forced_end: float | None = None,
    ) -> dict | None:
        keep_samples = [
            item for item in event_samples
            if forced_start is None or forced_start <= float(item["second"]) < float(forced_end or duration)
        ]
        if not keep_samples:
            return None

        natural_start = min(float(item["second"]) for item in keep_samples)
        natural_end = max(float(item["second"]) for item in keep_samples) + SAMPLE_EVERY_SECONDS
        output_start = forced_start if forced_start is not None else natural_start - context_before
        output_end = forced_end if forced_end is not None else natural_end + context_after
        output_start, output_end, clean_reason = clean_bounds(output_start, output_end, keep_samples)

        if output_end - output_start < min_clip_seconds and not has_bad_sample(scored, output_start, output_end):
            center = (natural_start + natural_end) / 2.0
            output_start = max(0.0, center - (min_clip_seconds / 2.0))
            output_end = min(duration, output_start + min_clip_seconds)
            output_start = max(0.0, output_end - min_clip_seconds)
            output_start, output_end, clean_reason = clean_bounds(output_start, output_end, keep_samples)

        clip_duration = output_end - output_start
        if clip_duration <= 0.2:
            return None

        inside = [item for item in scored if output_start <= float(item["second"]) < output_end]
        bad_count = sum(1 for item in inside if is_bad_label(item.get("scene")))
        if any(is_strong_bad_label(item.get("scene")) for item in inside):
            return None
        if inside and bad_count / len(inside) > 0.35:
            return None

        labels = label_summary(keep_samples)
        if not labels:
            return None
        average_score = sum(float(item.get("score") or 0) for item in keep_samples) / len(keep_samples)
        max_score = max(float(item.get("score") or 0) for item in keep_samples)
        label_bonus = min(0.35, 0.08 * len(set(labels)))
        length_bonus = min(0.35, clip_duration / max(max_clip_seconds, 1.0) * 0.25)
        score = average_score + (max_score * 0.45) + label_bonus + length_bonus - (0.18 * bad_count)
        evidence_times = [format_time(float(item["second"])) for item in sorted(keep_samples, key=lambda item: item["score"], reverse=True)[:3]]
        lead_label = labels[0]
        return {
            "start": output_start,
            "end": output_end,
            "duration": clip_duration,
            "score": score,
            "labels": labels,
            "matched_labels": labels[:3],
            "reason": f"Kept because {lead_label} matched the edit request around {', '.join(evidence_times)}.",
            "boundary_reason": boundary_reason,
            "why_not_longer": clean_reason,
            "bad_ratio": round((bad_count / len(inside)) if inside else 0, 3),
        }

    events: list[dict] = []
    current: list[dict] = []
    last_keep_second: float | None = None
    current_boundary = "started at the first useful sampled moment"

    def flush_event(reason: str) -> None:
        nonlocal current, last_keep_second, current_boundary
        if current:
            events.append({"samples": current, "boundary_reason": reason or current_boundary})
        current = []
        last_keep_second = None
        current_boundary = "started after a gap in useful samples"

    for item in scored:
        second = float(item.get("second") or 0)
        if is_keep_sample(item):
            if last_keep_second is not None and second - last_keep_second > boundary_gap:
                flush_event(f"split after {second - last_keep_second:.1f}s without useful matching samples")
            current.append(item)
            last_keep_second = second
        elif current and is_strong_bad_label(item.get("scene")) and last_keep_second is not None:
            if second - last_keep_second <= boundary_gap:
                flush_event("stopped before unusable or blank footage")
    flush_event("ended at the last useful sampled moment")

    candidates = []
    max_candidate_count = max(12, int(np.ceil(target_short_seconds / max(min_clip_seconds, 1.0))) * 4)
    for event in events:
        event_samples = event["samples"]
        event_start = min(float(item["second"]) for item in event_samples)
        event_end = max(float(item["second"]) for item in event_samples) + SAMPLE_EVERY_SECONDS
        natural_duration = event_end - event_start

        if allow_single_long_clip or natural_duration <= max_clip_seconds:
            candidate = make_candidate(event_samples, event["boundary_reason"])
            if candidate:
                candidates.append(candidate)
            continue

        windows: list[tuple[float, float]] = []
        for peak in sorted(event_samples, key=lambda item: float(item.get("score") or 0), reverse=True):
            if len(windows) >= max_candidate_count:
                break
            peak_second = float(peak["second"])
            window_start = max(event_start, peak_second - (max_clip_seconds * 0.45))
            window_end = min(event_end, window_start + max_clip_seconds)
            window_start = max(event_start, window_end - max_clip_seconds)
            if any(window_start < existing_end and window_end > existing_start for existing_start, existing_end in windows):
                continue
            included = [item for item in event_samples if window_start <= float(item["second"]) < window_end]
            candidate = make_candidate(
                included,
                "split from a longer continuous useful run",
                forced_start=window_start,
                forced_end=window_end,
            )
            if candidate:
                windows.append((candidate["start"], candidate["end"]))
                candidates.append(candidate)

        cursor = event_start
        while cursor < event_end and len(windows) < max_candidate_count:
            window_start = cursor
            window_end = min(event_end, window_start + max_clip_seconds)
            if event_end - window_end < min_clip_seconds and windows:
                window_end = event_end
            if window_end - window_start < 0.5:
                break
            if not any(window_start < existing_end and window_end > existing_start for existing_start, existing_end in windows):
                included = [item for item in event_samples if window_start <= float(item["second"]) < window_end]
                candidate = make_candidate(
                    included,
                    "continued from a longer useful run",
                    forced_start=window_start,
                    forced_end=window_end,
                )
                if candidate:
                    windows.append((candidate["start"], candidate["end"]))
                    candidates.append(candidate)
            cursor = window_end

    if not candidates:
        for item in sorted(scored, key=lambda sample: float(sample.get("score") or 0), reverse=True):
            if is_strong_bad_label(item.get("scene")):
                continue
            candidate = make_candidate([item], "fallback to the strongest available sample")
            if candidate:
                candidates.append(candidate)
                break

    candidates = [candidate for candidate in candidates if candidate["score"] >= MIN_CLIP_SCORE]
    if not candidates:
        return []

    selected = []
    selected_duration = 0.0
    average_candidate_duration = sum(candidate["duration"] for candidate in candidates) / max(len(candidates), 1)
    desired_clip_count = int(selection_strategy.get("target_clip_count") or 0)
    if desired_clip_count <= 0:
        desired_clip_count = max(1, int(np.ceil(target_short_seconds / max(average_candidate_duration, min_clip_seconds, 1.0))))
    spread_across_timeline = bool(selection_strategy.get("spread_across_timeline", True))
    bucket_seconds = (
        max(min_clip_seconds, duration / max(desired_clip_count, 1))
        if spread_across_timeline
        else max(duration, min_clip_seconds)
    )
    bucketed: dict[int, list[dict]] = {}
    for candidate in candidates:
        bucket = int(candidate["start"] // bucket_seconds) if bucket_seconds else 0
        bucketed.setdefault(bucket, []).append(candidate)
    for bucket_candidates in bucketed.values():
        bucket_candidates.sort(
            key=lambda item: (
                item["score"],
                item["duration"],
                -abs(((item["start"] + item["end"]) / 2.0) - (duration / 2.0)),
            ),
            reverse=True,
        )

    def can_add(candidate: dict) -> bool:
        return not any(candidate["start"] < clip["end"] and candidate["end"] > clip["start"] for clip in selected)

    def add_candidate(candidate: dict) -> bool:
        nonlocal selected_duration
        if selected_duration >= target_short_seconds:
            return False
        if not can_add(candidate):
            return False

        candidate = dict(candidate)
        remaining = target_short_seconds - selected_duration
        candidate_duration = candidate["end"] - candidate["start"]
        minimum_trimmed_clip = max(1.0, min(min_clip_seconds, remaining))
        if candidate_duration > remaining and remaining >= minimum_trimmed_clip:
            candidate["end"] = candidate["start"] + remaining
            candidate["duration"] = candidate["end"] - candidate["start"]
            candidate["why_not_longer"] = "trimmed to match the requested final duration"
        elif selected_duration > 0 and candidate_duration > remaining:
            return False

        selected.append(candidate)
        selected_duration += candidate["end"] - candidate["start"]
        return True

    if spread_across_timeline:
        bucket_order = sorted(bucketed)
        while selected_duration < target_short_seconds:
            added_this_round = False
            for bucket in bucket_order:
                while bucketed[bucket]:
                    candidate = bucketed[bucket].pop(0)
                    if add_candidate(candidate):
                        added_this_round = True
                        break
            if not added_this_round:
                break
    else:
        for candidate in sorted(candidates, key=lambda item: item["score"], reverse=True):
            if selected_duration >= target_short_seconds:
                break
            add_candidate(candidate)

    if selected_duration < target_short_seconds:
        for candidate in sorted(candidates, key=lambda item: item["score"], reverse=True):
            if selected_duration >= target_short_seconds:
                break
            add_candidate(candidate)

    if selected_duration < min(target_short_seconds, min_clip_seconds) and not selected and candidates:
        for candidate in sorted(candidates, key=lambda item: item["score"], reverse=True):
            if add_candidate(candidate):
                break

    selected.sort(key=lambda item: item["start"])
    merged = []
    if selection_strategy.get("allow_single_long_clip"):
        max_merged_duration = target_short_seconds
    else:
        max_merged_duration = float(selection_strategy["maximum_clip_seconds"])
    for clip in selected:
        would_merge_duration = clip["end"] - merged[-1]["start"] if merged else 0.0
        if merged and clip["start"] <= merged[-1]["end"] + 0.5 and would_merge_duration <= max_merged_duration:
            merged[-1]["end"] = max(merged[-1]["end"], clip["end"])
            merged[-1]["score"] = max(merged[-1]["score"], clip["score"])
            merged[-1]["labels"] = sorted(set(merged[-1]["labels"]) | set(clip["labels"]))
            merged[-1]["matched_labels"] = sorted(set(merged[-1].get("matched_labels", [])) | set(clip.get("matched_labels", [])))[:4]
            merged[-1]["reason"] = f"Kept as one continuous run because {', '.join(merged[-1]['matched_labels'])} stayed useful."
        else:
            merged.append(clip)

    transition_policy = normalize_transition_policy(EDIT_PLAN.get("transition_policy"))
    for index, clip in enumerate(merged, start=1):
        clip["index"] = index
        clip["duration"] = clip["end"] - clip["start"]
        clip["score"] = round(clip["score"], 4)
        clip["transition"] = {
            "type": transition_policy["type"] if transition_policy["enabled"] and index > 1 else "cut",
            "duration_seconds": transition_policy["duration_seconds"] if transition_policy["enabled"] and index > 1 else 0,
        }
    return merged


def summarize_timeline(predictions: list[dict]) -> list[dict]:
    if not predictions:
        return []

    sorted_predictions = sorted(predictions, key=lambda item: item["second"])
    runs = []

    for prediction in sorted_predictions:
        scene = prediction.get("scene") or "unknown"
        confidence = prediction.get("confidence")
        second = float(prediction.get("second") or 0)

        if runs and runs[-1]["scene"] == scene and second <= runs[-1]["end"] + (SAMPLE_EVERY_SECONDS * 1.5):
            runs[-1]["end"] = second + SAMPLE_EVERY_SECONDS
            runs[-1]["count"] += 1
            if isinstance(confidence, (int, float)):
                runs[-1]["confidence_sum"] += confidence
        else:
            runs.append(
                {
                    "start": second,
                    "end": second + SAMPLE_EVERY_SECONDS,
                    "scene": scene,
                    "count": 1,
                    "confidence_sum": confidence if isinstance(confidence, (int, float)) else 0,
                }
            )

    for run in runs:
        run["avg_confidence"] = run["confidence_sum"] / run["count"]
    return runs


def review_clip_plan(info: dict, predictions: list[dict], highlights: list[dict]) -> dict:
    target_seconds = float(EDIT_PLAN["target_short_seconds"])
    selected_duration = sum(float(clip.get("duration") or 0) for clip in highlights)
    issues = []
    warnings = []
    if not predictions:
        issues.append("No frame analysis was available.")
    if not highlights:
        issues.append("No clips were selected.")

    last_end = -1.0
    for clip in sorted(highlights, key=lambda item: float(item.get("start") or 0)):
        start = float(clip.get("start") or 0)
        end = float(clip.get("end") or 0)
        if start < 0 or end <= start or end > float(info["duration"]) + 0.1:
            issues.append(f"Clip #{clip.get('index')} has invalid timing.")
        if start < last_end:
            issues.append(f"Clip #{clip.get('index')} overlaps a previous clip.")
        last_end = max(last_end, end)
        clip_predictions = [
            prediction
            for prediction in predictions
            if start <= float(prediction.get("second") or 0) < end
        ]
        if any(is_strong_bad_label(prediction.get("scene")) for prediction in clip_predictions):
            issues.append(f"Clip #{clip.get('index')} contains unusable frames.")

    if selected_duration < min(target_seconds * 0.75, target_seconds - 5):
        warnings.append(
            f"Selected duration is {selected_duration:.1f}s, below the {target_seconds:.1f}s target because fewer high-value clips were found."
        )

    strategy = normalize_selection_strategy(EDIT_PLAN.get("selection_strategy"))
    if strategy.get("avoid_single_start_chunk") and len(highlights) == 1 and float(highlights[0].get("start") or 0) <= 1:
        warnings.append("Only one early clip was selected; ask for broader criteria if you want more timeline variety.")

    review = {
        "approved_for_render": not issues,
        "issues": issues,
        "warnings": warnings,
        "target_short_seconds": target_seconds,
        "selected_duration": round(selected_duration, 3),
        "clip_count": len(highlights),
        "export_format": normalize_export_format(EDIT_PLAN.get("export_format")),
        "selection_strategy": strategy,
        "preview_policy": normalize_preview_policy(EDIT_PLAN.get("preview_policy")),
        "transition_policy": normalize_transition_policy(EDIT_PLAN.get("transition_policy")),
        "roboflow_scenarios": ANALYSIS_SCENARIOS,
        "label_weights": EDIT_PLAN["label_weights"],
    }
    save_json(CLIP_REVIEW_PATH, review)
    return review


def write_natural_report(info: dict, predictions: list[dict], highlights: list[dict], review: dict | None = None) -> None:
    total_predictions = len(predictions)
    label_counts = {}
    for prediction in predictions:
        label = prediction.get("scene") or "unknown"
        label_counts[label] = label_counts.get(label, 0) + 1

    sorted_labels = sorted(label_counts.items(), key=lambda item: item[1], reverse=True)
    selected_duration = sum(float(clip.get("duration") or 0) for clip in highlights)
    timeline_runs = summarize_timeline(predictions)

    lines = [
        "Universal Video Shorts Editing Report",
        "",
        f"User edit request: {EDIT_PLAN['request']}",
        "",
        f"Source video: {VIDEO_PATH}",
        f"Original length: {format_time(info['duration'])} ({info['duration']:.1f} seconds)",
        f"Original size: {info['width']}x{info['height']} at {info['fps']:.2f} FPS",
        f"Frames analyzed: {total_predictions} samples, one sample every {format_sample_interval(SAMPLE_EVERY_SECONDS)}",
        f"Target short length: about {EDIT_PLAN['target_short_seconds']:.0f} seconds",
        f"Export format requested by plan: {normalize_export_format(EDIT_PLAN.get('export_format'))}",
        f"Clip boundary mode: full-video dynamic selection, max clip {normalize_selection_strategy(EDIT_PLAN.get('selection_strategy'))['maximum_clip_seconds']:.0f}s",
        f"Transition style: {normalize_transition_policy(EDIT_PLAN.get('transition_policy'))['type']}",
        "",
        "Final result:",
        f"The editor created a {selected_duration:.1f}-second short from the strongest visual moments matching the chat request.",
        f"Vertical Shorts file: {SHORT_VERTICAL_PATH}",
        f"Horizontal file: {SHORT_HORIZONTAL_PATH}",
        "",
        "Why these clips were chosen:",
        "The scoring follows the user request. High-weight labels are generated from the chat prompt, while low-weight labels represent filler, static, repeated, or low-quality footage.",
        "Before rendering, the backend cross-checks selected clips against the AI JSON plan and saves that review beside the job outputs.",
        "",
        "Reusable analysis labels and current edit weights:",
    ]

    for label in ANALYSIS_SCENARIOS:
        lines.append(f"- {label}: weight {EDIT_PLAN['label_weights'].get(label, 0):.2f}")

    if EDIT_PLAN.get("request_scenarios"):
        lines.extend(["", "Prompt-specific intent notes:"])
        for label in EDIT_PLAN["request_scenarios"]:
            lines.append(f"- {label}")

    if review:
        lines.extend(
            [
                "",
                "Pre-render cross-check:",
                f"- Approved for render: {'yes' if review.get('approved_for_render') else 'no'}",
                f"- Selected duration: {review.get('selected_duration')}s",
                f"- Clip count: {review.get('clip_count')}",
            ]
        )
        for issue in review.get("issues", []):
            lines.append(f"- Issue: {issue}")
        for warning in review.get("warnings", []):
            lines.append(f"- Warning: {warning}")

    lines.extend(["", "Selected clips:"])

    for clip in highlights:
        clip_predictions = [
            prediction
            for prediction in predictions
            if float(clip["start"]) <= float(prediction.get("second") or 0) < float(clip["end"])
        ]
        clip_counts = {}
        for prediction in clip_predictions:
            label = prediction.get("scene") or "unknown"
            clip_counts[label] = clip_counts.get(label, 0) + 1
        top_labels = sorted(clip_counts.items(), key=lambda item: item[1], reverse=True)
        top_label_text = ", ".join(f"{label} ({count}s)" for label, count in top_labels[:3])
        lines.extend(
            [
                f"{clip['index']}. {format_time(clip['start'])} to {format_time(clip['end'])} ({clip['duration']:.1f}s)",
                f"   Main content: {top_label_text or ', '.join(clip.get('labels', []))}",
                f"   Reason: {clip.get('reason') or 'this section matched the requested high-value labels.'}",
                f"   Boundary: {clip.get('why_not_longer') or clip.get('boundary_reason') or 'selected at natural scene edges.'}",
            ]
        )

    lines.extend(["", "Overall scene breakdown:"])
    for label, count in sorted_labels:
        percent = (count / total_predictions * 100) if total_predictions else 0
        lines.append(f"- {label}: {count} sampled seconds ({percent:.1f}%)")

    lines.extend(["", "Readable timeline:"])
    for run in timeline_runs:
        if run["count"] < 2 and EDIT_PLAN["label_weights"].get(run["scene"], 0) < 0.8:
            continue
        lines.append(
            f"- {format_time(run['start'])} to {format_time(run['end'])}: "
            f"{run['scene']} for about {run['end'] - run['start']:.0f}s "
            f"(avg confidence {run['avg_confidence']:.3f})"
        )

    lines.extend(
        [
            "",
            "Editing note:",
            "The chosen short uses the original full-resolution video clips, not the sampled preview frames. Audio is preserved when the source has audio, and silent videos export normally without requiring an audio track.",
        ]
    )

    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def clean_segments_dir() -> None:
    SEGMENTS_DIR.mkdir(exist_ok=True)
    for path in SEGMENTS_DIR.glob("*"):
        if path.is_file():
            path.unlink()


def render_horizontal_short(highlights: list[dict]) -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required to render shorts")
    if not highlights:
        raise RuntimeError("No highlights were selected")

    clean_segments_dir()
    segment_paths = []
    transition_policy = normalize_transition_policy(EDIT_PLAN.get("transition_policy"))
    write_progress("rendering", 82, "Rendering selected clip segments.", {"clip_count": len(highlights)})
    for clip_no, clip in enumerate(highlights, start=1):
        segment_path = SEGMENTS_DIR / f"segment_{clip['index']:02d}.mp4"
        clip_duration = max(float(clip["end"]) - float(clip["start"]), 0.1)
        command = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{clip['start']:.3f}",
            "-to",
            f"{clip['end']:.3f}",
            "-i",
            str(VIDEO_PATH),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
        ]
        fade_duration = min(float(transition_policy["duration_seconds"]), clip_duration / 3.0)
        if transition_policy["enabled"] and fade_duration > 0.05:
            fade_out_start = max(0.0, clip_duration - fade_duration)
            command.extend(
                [
                    "-vf",
                    f"fade=t=in:st=0:d={fade_duration:.3f},fade=t=out:st={fade_out_start:.3f}:d={fade_duration:.3f},format=yuv420p",
                ]
            )
        command.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "21",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
                str(segment_path),
            ]
        )
        run_command(command)
        segment_paths.append(segment_path)
        write_progress(
            "rendering",
            82 + (10 * (clip_no / max(len(highlights), 1))),
            f"Rendered clip {clip_no}/{len(highlights)}.",
            {"clip_index": clip["index"]},
        )

    concat_list = SEGMENTS_DIR / "concat.txt"
    concat_lines = ["file '" + str(path).replace("\\", "/").replace("'", "'\\''") + "'" for path in segment_paths]
    concat_list.write_text("\n".join(concat_lines), encoding="utf-8")

    run_command(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(SHORT_HORIZONTAL_PATH),
        ]
    )
    write_progress("rendering", 94, "Combined clip segments into the horizontal short.")


def render_vertical_short() -> None:
    write_progress("exporting", 96, "Creating the vertical Shorts export.")
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(SHORT_HORIZONTAL_PATH),
            "-filter_complex",
            (
                "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
                "crop=1080:1920,boxblur=24:2[bg];"
                "[0:v]scale=1080:-2[fg];"
                "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]"
            ),
            "-map",
            "[v]",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(SHORT_VERTICAL_PATH),
        ]
    )


def render_requested_outputs(highlights: list[dict]) -> None:
    export_format = normalize_export_format(EDIT_PLAN.get("export_format"))
    render_horizontal_short(highlights)
    if export_format in ("vertical", "both", "auto"):
        render_vertical_short()


def main() -> None:
    if not VIDEO_PATH.exists():
        raise FileNotFoundError(f"Video file not found: {VIDEO_PATH}")

    write_progress("planning", 3, "Preparing the AI edit plan and video metadata.")
    info = video_info(VIDEO_PATH)
    predictions = classify_video(info)
    write_progress("selecting", 66, "Choosing dynamic highlight boundaries across the full video.")
    highlights = build_highlights(predictions, info["duration"])
    save_json(HIGHLIGHTS_PATH, highlights)
    write_progress("reviewing", 74, "Cross-checking selected clips before render.", {"clip_count": len(highlights)})
    review = review_clip_plan(info, predictions, highlights)
    write_natural_report(info, predictions, highlights, review)

    print("Selected clips:", flush=True)
    if highlights:
        for clip in highlights:
            print(
                f"  #{clip['index']} {clip['start']:.1f}s-{clip['end']:.1f}s "
                f"({clip['duration']:.1f}s) score={clip['score']} labels={', '.join(clip['labels'])}",
                flush=True,
            )

        if not review.get("approved_for_render"):
            raise RuntimeError("Clip cross-check failed before render: " + "; ".join(review.get("issues", [])))
        render_requested_outputs(highlights)
        write_progress("completed", 100, "Short export completed.", {"clip_count": len(highlights)})
    else:
        print("  No high-value clips found yet. Analyze more samples or adjust the edit request.", flush=True)
        write_progress("completed", 100, "Analysis finished, but no high-value clips matched the request.")

    print(f"Done. Predictions: {PREDICTIONS_PATH}", flush=True)
    print(f"Highlights: {HIGHLIGHTS_PATH}", flush=True)
    print(f"Clip review: {CLIP_REVIEW_PATH}", flush=True)
    print(f"Report: {REPORT_PATH}", flush=True)
    print(f"Horizontal short: {SHORT_HORIZONTAL_PATH}", flush=True)
    print(f"Vertical short: {SHORT_VERTICAL_PATH}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Processing failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise
