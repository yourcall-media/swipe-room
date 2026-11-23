"""Fixtures: a real Firestore emulator (firebase-tools jar) and a temp output dir (SWIPE_OUT)."""
from __future__ import annotations

import glob
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[2]          # /home/user/swipe
sys.path.insert(0, str(ROOT))
TOOLS = ROOT / "pipeline" / ".tools"
PROJECT = "demo-swipe-test"

os.environ["SWIPE_CONFIRM_DELAY"] = "0"
os.environ.setdefault("SWIPE_ADMIN_URL", "http://localhost/admin.html#review/{batch_id}")


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _emulator_jar() -> str:
    pattern = os.path.expanduser("~/.cache/firebase/emulators/cloud-firestore-emulator-*.jar")
    jars = sorted(glob.glob(pattern))
    if not jars:
        firebase = TOOLS / "node_modules" / ".bin" / "firebase"
        if not firebase.exists():
            pytest.skip("firebase-tools not installed: cd pipeline/.tools && npm install firebase-tools@13")
        subprocess.run([str(firebase), "setup:emulators:firestore"], check=True, cwd=str(TOOLS))
        jars = sorted(glob.glob(pattern))
    return jars[-1]


@pytest.fixture(scope="session")
def emulator():
    host = os.environ.get("SWIPE_TEST_EMULATOR")  # reuse a running emulator if given (host:port)
    proc = None
    if not host:
        port = _free_port()
        host = f"127.0.0.1:{port}"
        log = open(TOOLS / "emulator-test.log", "w")
        proc = subprocess.Popen(["java", "-jar", _emulator_jar(), "--host", "127.0.0.1", "--port", str(port)],
                                stdout=log, stderr=subprocess.STDOUT)
        for _ in range(120):
            try:
                if requests.get(f"http://{host}/", timeout=1).ok:
                    break
            except requests.RequestException:
                pass
            time.sleep(0.5)
        else:
            proc.kill()
            raise RuntimeError("Firestore emulator did not start")
    os.environ["FIRESTORE_EMULATOR_HOST"] = host
    os.environ["SWIPE_PROJECT_ID"] = PROJECT
    os.environ.pop("FIREBASE_SERVICE_ACCOUNT", None)
    yield host
    if proc:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture()
def fs(emulator):
    from pipeline.firestore import Firestore

    client = Firestore()
    client.emulator_clear()
    yield client
    client.emulator_clear()


@pytest.fixture()
def out(tmp_path, monkeypatch):
    """Temp output root + videos manifest + know-how stub; nothing goes to /mnt/project-files."""
    o = tmp_path / "out"
    o.mkdir()
    monkeypatch.setenv("SWIPE_OUT", str(o))
    from seed import VIDEOS

    vpath = tmp_path / "videos.json"
    vpath.write_text(json.dumps({"version": "test", "cats": [["test", "Test"]], "videos": VIDEOS}))
    monkeypatch.setenv("SWIPE_VIDEOS", str(vpath))
    kh = tmp_path / "know-how.md"
    kh.write_text("# know-how stub for tests\n")
    monkeypatch.setenv("SWIPE_KNOWHOW", str(kh))
    return o
