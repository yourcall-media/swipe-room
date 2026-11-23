"""Step 4: owner verdicts -> trust for every rater -> Firestore + markdown files + digest."""
from __future__ import annotations

import datetime as dt
from collections import defaultdict
from pathlib import Path

from . import common, config, reports, storage, trust
from .firestore import Firestore
from .publish import effective_verdicts


def _parse_ts(s) -> dt.datetime | None:
    if not isinstance(s, str):
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def run(date: str, wdir: Path, fs: Firestore | None = None) -> dict:
    fs = fs or Firestore()
    st = common.load_state()
    raters_docs = fs.list_docs("raters")
    ratings = fs.list_docs("ratings")
    batches = fs.list_docs("batches")
    admins = {a["_id"] for a in fs.list_docs("admins")}
    videos = common.load_videos()
    raters = {r["_id"]: r for r in raters_docs}

    # ---------------------------------------------------------------- verdict credits
    eff = effective_verdicts(batches)
    # older open batches whose every item now has a verdict (here or in a newer batch) are closed
    for b in batches:
        if b.get("status") == "open" and b["_id"] < date and all(
                eff.get(it.get("id"), {}).get("verdict") is not None for it in b.get("items", []) or []):
            fs.update_fields(f"batches/{b['_id']}", {"status": "closed"})
            b["status"] = "closed"
    verdict_obs: dict[str, list[float]] = defaultdict(list)
    item_uids: dict[str, set[str]] = {}
    for item_id, e in eff.items():
        uids = {s.get("uid") for s in e["item"].get("suggesters", []) or [] if s.get("uid")}
        for iid in st["items"].get(item_id, {}).get("idea_ids", []):
            led = st["processed"].get(iid)
            if led and not led.get("spam"):
                uids.add(led["uid"])
        item_uids[item_id] = uids
        if e["verdict"] in ("approve", "reject"):
            for uid in uids:
                verdict_obs[uid].append(1.0 if e["verdict"] == "approve" else 0.0)
    qualities: dict[str, list[float]] = defaultdict(list)
    spam_count: dict[str, int] = defaultdict(int)
    for led in st["processed"].values():
        if led.get("quality") is not None:
            qualities[led["uid"]].append(float(led["quality"]))
        if led.get("spam"):
            spam_count[led["uid"]] += 1
            if config.SPAM_COUNTS_AS_REJECT:
                verdict_obs[led["uid"]].append(0.0)

    # ---------------------------------------------------------------- trust
    uids = sorted(set(raters) | {r.get("uid") for r in ratings if r.get("uid")})
    prior = {u: float(raters.get(u, {}).get("trust", config.TRUST_START)) for u in uids}
    result = trust.compute(uids, ratings, verdict_obs, qualities, prior)
    rated_count = defaultdict(int)
    for r in ratings:
        rated_count[r.get("uid")] += 1

    updates = {}
    for uid in uids:
        if uid not in raters:
            continue  # ratings without a rater doc: never create rater docs from the pipeline
        updates[f"raters/{uid}"] = {"trust": result[uid]["trust"], "badge": result[uid]["badge"],
                                    "ratedCount": rated_count.get(uid, 0)}
    if updates:
        fs.update_many(updates)

    # ---------------------------------------------------------------- history
    for uid in uids:
        hist = st["trust_history"].setdefault(uid, [])
        hist[:] = [h for h in hist if h["date"] != date]
        hist.append({"date": date, "trust": result[uid]["trust"], "badge": result[uid]["badge"],
                     "previous": prior[uid], "components": result[uid]["components"],
                     "counts": {**result[uid]["counts"], "spam": spam_count.get(uid, 0)}})
        hist.sort(key=lambda h: h["date"])

    # ---------------------------------------------------------------- approved collection + md
    approved_now = {iid: e for iid, e in eff.items() if e["verdict"] == "approve"}
    approved_docs = {a["_id"] for a in fs.list_docs("approved")}
    for item_id, e in approved_now.items():
        if item_id not in approved_docs:
            fs.set_doc(f"approved/{item_id}", {**e["item"], "batchId": e["batch_id"],
                                                "approvedAt": dt.datetime.now(dt.timezone.utc)})
    for item_id in approved_docs - set(approved_now):
        if item_id in eff:  # verdict changed away from approve
            fs.delete_doc(f"approved/{item_id}")
    new_approved = [(iid, e) for iid, e in sorted(approved_now.items())
                    if iid not in set(st["approved_written"])]
    if new_approved:
        reports.prepend_approved(config.approved_md_path(), date, new_approved, videos)
        st["approved_written"].extend(iid for iid, _ in new_approved)

    # ---------------------------------------------------------------- rater files
    storage.ensure_dir(config.raters_dir())
    by_uid_ratings: dict[str, list[dict]] = defaultdict(list)
    for r in ratings:
        by_uid_ratings[r.get("uid")].append(r)
    ideas_by_uid: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for iid, led in st["processed"].items():
        ideas_by_uid[led["uid"]].append((iid, led))
    written = []
    for uid in uids:
        rdoc = raters.get(uid, {"nickname": "unknown"})
        fname = common.rater_filename(rdoc.get("nickname") or "rater", uid)
        old = st["rater_files"].get(uid)
        if old and old != fname:
            storage.remove(config.raters_dir() / old)
        md = reports.rater_markdown(uid, rdoc, uid in admins, result[uid], st["trust_history"].get(uid, []),
                                    ideas_by_uid.get(uid, []), eff, by_uid_ratings.get(uid, []), videos)
        storage.write_text(config.raters_dir() / fname, md)
        st["rater_files"][uid] = fname
        written.append(fname)

    # ---------------------------------------------------------------- digest
    last_ingest = _parse_ts(st.get("last_ingest_at"))
    new_ratings = [r for r in ratings if last_ingest is None
                   or ((_parse_ts(r.get("createdAt")) or dt.datetime.max.replace(tzinfo=dt.timezone.utc)) > last_ingest)]
    trust_now = {u: result[u]["trust"] for u in uids}
    stats = common.video_stats(ratings, trust_now, videos)
    publish_info = storage.read_json(Path(wdir) / "publish.json", {}) or {}
    open_batches = sorted(b["_id"] for b in batches if b.get("status") == "open")
    digest = reports.digest_markdown(
        date=date, new_ratings=len(new_ratings), total_ratings=len(ratings), stats=stats,
        movers=[(u, raters.get(u, {}).get("nickname") or u[:6], prior[u], trust_now[u]) for u in uids],
        publish_info=publish_info, open_batches=open_batches, eff=eff, new_approved=new_approved)
    storage.ensure_dir(Path(wdir))
    storage.write_text(Path(wdir) / "digest.md", digest)
    storage.write_json(Path(wdir) / "trust.json", result)

    st["last_ingest_at"] = common.now_iso()
    common.log_run(st, date, "ingest", raters=len(updates), new_ratings=len(new_ratings),
                   approved_new=len(new_approved))
    common.save_state(st)
    problems = storage.confirm_writes()
    return {"raters_updated": len(updates), "rater_files": len(written), "new_ratings": len(new_ratings),
            "approved_new": len(new_approved), "digest": str(Path(wdir) / "digest.md"), "problems": problems}
