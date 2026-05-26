import sys
import types
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

backend_package = sys.modules.get("backend")
if backend_package is None:
    backend_package = types.ModuleType("backend")
    backend_package.__path__ = [str(BACKEND_ROOT)]
    sys.modules["backend"] = backend_package

from backend.server import app
