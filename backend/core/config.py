import os
from pathlib import Path

from backend.env import load_project_env


load_project_env(__file__)

BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT = BACKEND_DIR.parent
RUNTIME_ROOT = Path(os.getenv("RUNTIME_DIR") or ("/tmp/visual-ai-editor" if os.getenv("VERCEL") else ROOT)).resolve()
JOBS_DIR = RUNTIME_ROOT / "jobs"
LOGS_DIR = RUNTIME_ROOT / "logs"
JOB_LOGS_DIR = LOGS_DIR / "jobs"
MEMORY_PATH = RUNTIME_ROOT / "editor_memory.json"

for directory in (RUNTIME_ROOT, JOBS_DIR, LOGS_DIR, JOB_LOGS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

DEFAULT_PROMPT = os.getenv("DEFAULT_PROMPT", "").strip()
APP_TITLE = os.getenv("APP_TITLE", "Universal Video Shorts Editor")
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,https://visual-ai-editor-ten.vercel.app",
    ).split(",")
    if origin.strip()
]
