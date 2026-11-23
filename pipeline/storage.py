"""File helpers that follow the network-mount rules for /mnt/project-files.

- every write is atomic: write a temp file in the same folder, fsync, rename;
- files on the mount are re-read ~CONFIRM_DELAY_SEC after writing and compared
  (one wait per command, for all files written by it: call confirm_writes()).
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from . import config

_pending: dict[Path, str] = {}  # path -> sha256 of what we wrote


def _on_mount(path: Path) -> bool:
    try:
        Path(path).resolve().relative_to(config.PROJECT_FILES)
        return True
    except ValueError:
        return False


def ensure_dir(path: Path) -> Path:
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_text(path: Path, text: str) -> Path:
    path = Path(path)
    ensure_dir(path.parent)
    data = text.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent) + os.sep)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _pending[path] = hashlib.sha256(data).hexdigest()
    return path


def write_json(path: Path, obj: Any) -> Path:
    return write_text(path, json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=False) + "\n")


def read_json(path: Path, default: Any = None) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def read_text(path: Path, default: str = "") -> str:
    path = Path(path)
    if not path.exists():
        return default
    return path.read_text(encoding="utf-8")


def remove(path: Path) -> None:
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
    _pending.pop(Path(path), None)


def confirm_writes(delay: float | None = None) -> list[str]:
    """Re-read every file written since the last call; return problems (empty = all good).

    Waits `delay` (default CONFIRM_DELAY_SEC) once if any file is on /mnt/project-files.
    A mismatching file is reported (not rewritten, so another writer is never clobbered).
    """
    if not _pending:
        return []
    delay = config.CONFIRM_DELAY_SEC if delay is None else delay
    if delay > 0 and any(_on_mount(p) for p in _pending):
        time.sleep(delay)
    problems = []
    for path, digest in list(_pending.items()):
        try:
            got = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        except OSError as exc:
            problems.append(f"{path}: cannot re-read ({exc})")
            continue
        if got != digest:
            problems.append(f"{path}: content differs after write (someone else wrote it?)")
    _pending.clear()
    return problems


def dir_str(path: Path) -> str:
    """Folder path with trailing slash (mount rule for listing/printing folders)."""
    s = str(path)
    return s if s.endswith("/") else s + "/"
