"""Minimal Firestore REST client (production via service account, or the emulator).

Production: env FIREBASE_SERVICE_ACCOUNT holds the service-account JSON itself, or a path to it.
Emulator:   env FIRESTORE_EMULATOR_HOST=host:port; requests use `Authorization: Bearer owner`
            (bypasses security rules). Project id: env SWIPE_PROJECT_ID / GCLOUD_PROJECT, else the
            service account's project_id, else config.EMULATOR_DEFAULT_PROJECT.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
from typing import Any, Iterator
from urllib.parse import quote

import requests

from . import config


class FirestoreError(RuntimeError):
    pass


# --------------------------------------------------------------------------- value codec
def encode_value(v: Any) -> dict:
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=dt.timezone.utc)
        return {"timestampValue": v.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, bytes):
        return {"bytesValue": base64.b64encode(v).decode()}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [encode_value(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: encode_value(x) for k, x in v.items()}}}
    raise TypeError(f"cannot encode {type(v)}")


def decode_value(v: dict) -> Any:
    if "nullValue" in v:
        return None
    if "booleanValue" in v:
        return v["booleanValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "timestampValue" in v:
        return v["timestampValue"]  # ISO-8601 string, UTC
    if "stringValue" in v:
        return v["stringValue"]
    if "bytesValue" in v:
        return v["bytesValue"]
    if "referenceValue" in v:
        return v["referenceValue"]
    if "geoPointValue" in v:
        return v["geoPointValue"]
    if "arrayValue" in v:
        return [decode_value(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: decode_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    return None


def encode_fields(d: dict) -> dict:
    return {k: encode_value(v) for k, v in d.items()}


def decode_doc(doc: dict) -> dict:
    out = {k: decode_value(v) for k, v in doc.get("fields", {}).items()}
    out["_id"] = doc["name"].rsplit("/", 1)[-1]
    out["_updateTime"] = doc.get("updateTime")
    return out


def strip_meta(d: dict) -> dict:
    return {k: v for k, v in d.items() if not k.startswith("_")}


# --------------------------------------------------------------------------- client
def _load_service_account() -> dict | None:
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        return None
    if raw.startswith("{"):
        return json.loads(raw)
    with open(os.path.expanduser(raw), "r", encoding="utf-8") as fh:
        return json.load(fh)


class Firestore:
    def __init__(self, project_id: str | None = None, timeout: float = 30.0):
        self.timeout = timeout
        self.session = requests.Session()
        self.emulator = os.environ.get("FIRESTORE_EMULATOR_HOST", "").strip()
        sa = None if self.emulator else _load_service_account()
        self.project_id = (
            project_id
            or os.environ.get("SWIPE_PROJECT_ID")
            or os.environ.get("GCLOUD_PROJECT")
            or (sa or {}).get("project_id")
            or config.EMULATOR_DEFAULT_PROJECT
        )
        self._creds = None
        if self.emulator:
            self.base = f"http://{self.emulator}/v1"
        else:
            if sa is None:
                raise FirestoreError(
                    "No Firestore access: set FIREBASE_SERVICE_ACCOUNT (JSON or path) "
                    "or FIRESTORE_EMULATOR_HOST.")
            from google.oauth2 import service_account  # imported lazily: not needed for emulator

            self._creds = service_account.Credentials.from_service_account_info(
                sa, scopes=config.FIRESTORE_SCOPES)
            self.base = "https://firestore.googleapis.com/v1"
        self.root = f"projects/{self.project_id}/databases/(default)/documents"

    # ------------------------------------------------------------------ auth/http
    def _headers(self) -> dict:
        if self.emulator:
            return {"Authorization": "Bearer owner"}
        from google.auth.transport.requests import Request

        if not self._creds.valid:
            self._creds.refresh(Request())
        return {"Authorization": f"Bearer {self._creds.token}"}

    def _req(self, method: str, url: str, **kw) -> dict:
        r = self.session.request(method, url, headers=self._headers(), timeout=self.timeout, **kw)
        if r.status_code == 404 and method == "GET":
            return {}
        if r.status_code >= 300:
            raise FirestoreError(f"{method} {url} -> {r.status_code}: {r.text[:500]}")
        return r.json() if r.content else {}

    def _url(self, path: str) -> str:
        return f"{self.base}/{self.root}/{quote(path, safe='/')}"

    # ------------------------------------------------------------------ reads
    def list_docs(self, collection: str) -> list[dict]:
        return list(self.iter_docs(collection))

    def iter_docs(self, collection: str) -> Iterator[dict]:
        token = None
        while True:
            params = {"pageSize": 300}
            if token:
                params["pageToken"] = token
            data = self._req("GET", self._url(collection), params=params)
            for doc in data.get("documents", []):
                yield decode_doc(doc)
            token = data.get("nextPageToken")
            if not token:
                break

    def get_doc(self, path: str) -> dict | None:
        data = self._req("GET", self._url(path))
        return decode_doc(data) if data.get("name") else None

    # ------------------------------------------------------------------ writes
    def set_doc(self, path: str, data: dict) -> dict:
        """Create or fully replace a document."""
        body = {"fields": encode_fields(strip_meta(data))}
        return self._req("PATCH", self._url(path), json=body)

    def update_fields(self, path: str, data: dict) -> dict:
        """Merge only the given top-level fields (updateMask), leave the rest untouched."""
        params = [("updateMask.fieldPaths", k) for k in data]
        body = {"fields": encode_fields(data)}
        return self._req("PATCH", self._url(path), params=params, json=body)

    def delete_doc(self, path: str) -> None:
        self._req("DELETE", self._url(path))

    def commit(self, writes: list[dict]) -> dict:
        """Raw batched commit (max 500 writes); writes use REST `Write` shape."""
        url = f"{self.base}/projects/{self.project_id}/databases/(default)/documents:commit"
        return self._req("POST", url, json={"writes": writes})

    def doc_name(self, path: str) -> str:
        return f"{self.root}/{path}"

    def update_many(self, updates: dict[str, dict]) -> None:
        """{path: fields} merged with update masks, committed in chunks of 400."""
        writes = [
            {"update": {"name": self.doc_name(p), "fields": encode_fields(f)},
             "updateMask": {"fieldPaths": list(f.keys())}}
            for p, f in updates.items()
        ]
        for i in range(0, len(writes), 400):
            self.commit(writes[i:i + 400])

    # ------------------------------------------------------------------ emulator only
    def emulator_clear(self) -> None:
        if not self.emulator:
            raise FirestoreError("emulator_clear is emulator-only")
        url = f"http://{self.emulator}/emulator/v1/projects/{self.project_id}/databases/(default)/documents"
        r = self.session.delete(url, timeout=self.timeout)
        if r.status_code >= 300:
            raise FirestoreError(f"clear failed: {r.status_code} {r.text[:200]}")
