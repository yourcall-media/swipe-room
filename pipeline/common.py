"""Shared helpers: run dates, work dirs, state.json, idea ids, video manifest, stats."""
from __future__ import annotations

import datetime as dt
import hashlib
import re
from pathlib import Path
from typing import Any

from . import config, storage

STATE_VERSION = 1


def today() -> str:
    return dt.date.today().isoformat()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def work_dir(date: str, override: str | None = None) -> Path:
    return Path(override) if override else config.runs_dir() / date


# --------------------------------------------------------------------------- state
def empty_state() -> dict:
    return {
        "version": STATE_VERSION,
        "processed": {},        # idea_id -> ledger record (quality, cluster, item, text...)
        "clusters": {},         # cluster_id -> cluster (backlog = item_id null)
        "items": {},            # batch item id -> {batch_id, cluster_id, idea_ids}
        "approved_written": [],
        "rater_files": {},
        "trust_history": {},    # uid -> [{date, trust, badge, components, counts}]
        "runs": [],
        "last_export_at": None,
    }


def load_state() -> dict:
    st = storage.read_json(config.state_path(), None) or empty_state()
    base = empty_state()
    for k, v in base.items():
        st.setdefault(k, v)
    return st


def save_state(st: dict) -> None:
    storage.write_json(config.state_path(), st)


def log_run(st: dict, date: str, step: str, **info: Any) -> None:
    st["runs"].append({"date": date, "step": step, "at": now_iso(), **info})
    st["runs"] = st["runs"][-400:]


# --------------------------------------------------------------------------- ids
def text_hash(text: str) -> str:
    norm = re.sub(r"\s+", " ", (text or "").strip().lower())
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:8]


def rating_idea_id(rating_doc_id: str, text: str) -> str:
    # an edited idea gets a new id, so it is judged again
    return f"r:{rating_doc_id}:{text_hash(text)}"


def feedback_idea_id(feedback_doc_id: str) -> str:
    return f"f:{feedback_doc_id}"


def slug(s: str, maxlen: int = 40) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s or "").strip("-").lower()
    return (s or "rater")[:maxlen]


def rater_filename(nickname: str, uid: str) -> str:
    return f"{slug(nickname)}-{uid[:6]}.md"


# --------------------------------------------------------------------------- videos
def load_videos() -> dict[str, dict]:
    data = storage.read_json(config.videos_manifest_path(), None) or {}
    return {v["id"]: v for v in data.get("videos", []) if "id" in v}


# --------------------------------------------------------------------------- stats
def trust_weight(trust: float | None) -> float:
    t = config.TRUST_START if trust is None else float(trust)
    return max(t, 0.0) / 50.0


def weighted_score(ratings: list[dict], trust_by_uid: dict[str, float]) -> float | None:
    """Spec: Σ(trust/50 · (good?1:-1)) / Σ(trust/50)."""
    num = den = 0.0
    for r in ratings:
        w = trust_weight(trust_by_uid.get(r.get("uid")))
        num += w * (1 if r.get("verdict") == "good" else -1)
        den += w
    return round(num / den, 4) if den > 0 else None


def video_stats(ratings: list[dict], trust_by_uid: dict[str, float], videos: dict[str, dict]) -> dict:
    by_video: dict[str, list[dict]] = {}
    for r in ratings:
        by_video.setdefault(r.get("videoId"), []).append(r)
    out = {}
    for vid, rs in sorted(by_video.items(), key=lambda kv: str(kv[0])):
        reasons: dict[str, int] = {}
        for r in rs:
            for k in r.get("reasons") or []:
                reasons[k] = reasons.get(k, 0) + 1
        drops = [r["dropOffSec"] for r in rs if isinstance(r.get("dropOffSec"), (int, float))]
        pcts = [float(r.get("watchedPct") or 0) for r in rs]
        out[vid] = {
            "video_id": vid,
            "title": (videos.get(vid) or {}).get("title"),
            "n": len(rs),
            "good": sum(1 for r in rs if r.get("verdict") == "good"),
            "bad": sum(1 for r in rs if r.get("verdict") == "bad"),
            "weighted_score": weighted_score(rs, trust_by_uid),
            "mean_watched_pct": round(sum(pcts) / len(pcts), 3) if pcts else None,
            "swiped_early": sum(1 for r in rs if r.get("swipedEarly")),
            "median_drop_off_sec": sorted(drops)[len(drops) // 2] if drops else None,
            "reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
            "ideas": sum(1 for r in rs if (r.get("idea") or "").strip()),
        }
    return out
