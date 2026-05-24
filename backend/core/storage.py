import json
import os
import time
from pathlib import Path
from typing import Any


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


def tail_text(path: Path, limit: int = 12000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-limit:]
