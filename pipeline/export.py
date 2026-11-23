"""Step 1: read Firestore, write the day's snapshot + new_ideas.json for the Claude step."""
from __future__ import annotations

from pathlib import Path

from . import common, config, storage
from .firestore import Firestore


def fetch_all(fs: Firestore) -> dict[str, list[dict]]:
    return {c: fs.list_docs(c) for c in config.COLLECTIONS}


def build_new_ideas(snap: dict, st: dict, videos: dict, date: str, wdir: Path) -> dict:
    raters = {r["_id"]: r for r in snap["raters"]}
    processed = st["processed"]
    ideas = []
    for r in snap["ratings"]:
        text = (r.get("idea") or "").strip()
        if not text:
            continue
        iid = common.rating_idea_id(r["_id"], text)
        if iid in processed:
            continue
        rater = raters.get(r.get("uid"), {})
        v = videos.get(r.get("videoId"), {})
        ideas.append({
            "idea_id": iid,
            "source": "rating",
            "text": text,
            "via": r.get("ideaVia"),
            "uid": r.get("uid"),
            "nickname": rater.get("nickname"),
            "trust": float(rater.get("trust", config.TRUST_START)),
            "video_id": r.get("videoId"),
            "video_title": v.get("title"),
            "video_hook": v.get("hook"),
            "verdict": r.get("verdict"),
            "reasons": r.get("reasons") or [],
            "other": r.get("other") or "",
            "watched_pct": r.get("watchedPct"),
            "watched_sec": r.get("watchedSec"),
            "duration_sec": r.get("durationSec"),
            "drop_off_sec": r.get("dropOffSec"),
            "swiped_early": r.get("swipedEarly"),
            "created_at": r.get("createdAt"),
        })
    for f in snap["feedback"]:
        text = (f.get("text") or "").strip()
        if not text:
            continue
        iid = common.feedback_idea_id(f["_id"])
        if iid in processed:
            continue
        rater = raters.get(f.get("uid"), {})
        ideas.append({
            "idea_id": iid, "source": "feedback", "text": text, "via": f.get("via"),
            "uid": f.get("uid"), "nickname": rater.get("nickname"),
            "trust": float(rater.get("trust", config.TRUST_START)),
            "video_id": None, "video_title": None, "video_hook": None, "verdict": None,
            "reasons": [], "other": "", "watched_pct": None, "watched_sec": None,
            "duration_sec": None, "drop_off_sec": None, "swiped_early": None,
            "created_at": f.get("createdAt"),
        })
    ideas.sort(key=lambda i: (str(i["video_id"] or "~"), str(i["created_at"] or "")))

    open_clusters = []
    for cid, c in st["clusters"].items():
        if c.get("item_id") is None and c.get("last_run", date) >= _days_ago(date, config.BACKLOG_DAYS):
            open_clusters.append({k: c.get(k) for k in
                                  ("title", "summary", "video_ids", "impact", "effort", "conflicts")}
                                 | {"cluster_id": cid, "n_ideas": len(c.get("idea_ids", []))})
    recent_items = []
    for b in sorted(snap["batches"], key=lambda b: b["_id"], reverse=True)[:30]:
        for it in b.get("items", []):
            recent_items.append({"item_id": it.get("id"), "batch_id": b["_id"], "title": it.get("title"),
                                 "summary": it.get("summary"), "verdict": it.get("verdict"),
                                 "note": it.get("note") or ""})
    return {
        "run_date": date,
        "generated_at": common.now_iso(),
        "instructions": str(config.CLAUDE_STEP_PATH),
        "schema": str(config.SCHEMA_PATH),
        "knowhow": str(config.knowhow_path()),
        "write_judgements_to": str(wdir / "judgements.json"),
        "counts": {"ideas": len(ideas), "open_clusters": len(open_clusters)},
        "ideas": ideas,
        "open_clusters": open_clusters,
        "recent_items": recent_items,
    }


def _days_ago(date: str, days: int) -> str:
    import datetime as dt

    return (dt.date.fromisoformat(date) - dt.timedelta(days=days)).isoformat()


def run(date: str, wdir: Path, fs: Firestore | None = None) -> dict:
    fs = fs or Firestore()
    snap = fetch_all(fs)
    st = common.load_state()
    videos = common.load_videos()
    trust = {r["_id"]: float(r.get("trust", config.TRUST_START)) for r in snap["raters"]}
    stats = common.video_stats(snap["ratings"], trust, videos)
    new_ideas = build_new_ideas(snap, st, videos, date, wdir)
    new_ideas["video_stats"] = {k: {kk: v[kk] for kk in ("title", "n", "good", "bad", "weighted_score",
                                                          "mean_watched_pct", "reasons")}
                                for k, v in stats.items()}
    storage.ensure_dir(wdir)
    storage.write_json(wdir / "snapshot.json", {"run_date": date, "exported_at": common.now_iso(),
                                                "project_id": fs.project_id, **snap})
    storage.write_json(wdir / "video_stats.json", stats)
    storage.write_json(wdir / "new_ideas.json", new_ideas)
    common.log_run(st, date, "export", ideas=len(new_ideas["ideas"]), ratings=len(snap["ratings"]))
    common.save_state(st)
    problems = storage.confirm_writes()
    return {"work_dir": str(wdir), "ideas": len(new_ideas["ideas"]), "ratings": len(snap["ratings"]),
            "raters": len(snap["raters"]), "open_clusters": len(new_ideas["open_clusters"]),
            "problems": problems}
