"""Keep test discovery isolated from the local coaching database."""

import atexit
import os
import tempfile
from pathlib import Path


_suite_db_path = None
if not os.environ.get("DATABASE_URL"):
    handle = tempfile.NamedTemporaryFile(prefix="lanewatch-suite-", suffix=".db", delete=False)
    handle.close()
    _suite_db_path = Path(handle.name)
    _suite_db_path.unlink(missing_ok=True)
    os.environ["DATABASE_URL"] = f"sqlite:///{_suite_db_path.as_posix()}"


@atexit.register
def _remove_suite_database():
    if _suite_db_path:
        _suite_db_path.unlink(missing_ok=True)
