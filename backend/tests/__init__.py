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
        try:
            _suite_db_path.unlink(missing_ok=True)
        except OSError:
            # Windows keeps a handle on the file until the engine is collected.
            # A leftover temp file is not worth a noisy exit.
            pass


def reset_database():
    """Empty every table between tests.

    Most tests here clean up on their last few lines, which only runs when every
    assertion passed. One failing test then leaks rows into the next and the
    real failure is buried under a second, unrelated one. Truncating between
    tests makes each one independent of whether its neighbour succeeded.
    """
    from backend.database import engine
    from backend import models

    with engine.begin() as conn:
        for table in reversed(models.Base.metadata.sorted_tables):
            conn.execute(table.delete())
