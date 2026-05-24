import os
from typing import Any

from backend.core.config import MEMORY_PATH
from backend.core.storage import read_json, write_json


def read_memory() -> dict[str, Any]:
    if os.getenv("ENABLE_SERVER_MEMORY") != "1":
        return {}
    memory = read_json(MEMORY_PATH, {})
    return memory if isinstance(memory, dict) else {}


def write_memory(memory: dict[str, Any]) -> None:
    if os.getenv("ENABLE_SERVER_MEMORY") != "1":
        return
    write_json(MEMORY_PATH, memory)
