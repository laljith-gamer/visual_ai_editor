import os
from pathlib import Path


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_project_env(current_file: str) -> None:
    current_path = Path(current_file).resolve()
    project_root = current_path.parents[1]
    for parent in current_path.parents:
        if (parent / ".env").exists() or (parent / "requirements.txt").exists():
            project_root = parent
            break
    load_env_file(project_root / ".env")
