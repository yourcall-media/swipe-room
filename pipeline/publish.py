"""Step 3: validated judgements -> scored clusters -> batches/{date} in Firestore."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

from . import common, config, storage
from .firestore import Firestore
from .judgements import load_and_validate


class PublishError(RuntimeError):
    pass


def cluster_score(impact: int, effort: int, trusts: list[float]) -> float:
    """impact × mean(trust/50) × (1 + 0.15·(n-1)) / effort^0.5, n = distinct suggesters."""
    if not trusts:
        return 0.0
    mean_w = sum(common.trust_weight(t) for t in trusts) / len(trusts)
    bonus = 1 + config.SUGGESTER_BONUS * (len(trusts) - 1)
    return round(impact * mean_w * bonus / (effort ** config.EFFORT_EXPONENT), 3)


def effective_verdicts(batches: list[dict]) -> dict[str, dict]:
    """item id -> {verdict, note, batch_id, item} using the newest batch with a non-null verdict."""
    out: dict[str, dict] = {}
    for b in sorted(batches, key=lambda b: b["_id"]):
        for it in b.get("items", []) or []:
            iid = it.get("id")
            if iid is None:
                continue
            if it.get("verdict") is not None or iid not in out:
                out[iid] = {"verdict": it.get("verdict"), "note": it.get("note") or "",
                            "batch_id": b["_id"], "item": it}
    return out


def _merge_judgements(st: dict, judgements: dict, new_ideas: dict, date: str) -> None:
    ideas = {i["idea_id"]: i for i in new_ideas["ideas"]}
    spam = set(judgements["spam"])

    def ledger(iid: str, cluster_id, item_id, quality, is_spam):
        i = ideas[iid]
        st["processed"][iid] = {
            "uid": i["uid"], "nickname": i.get("nickname"), "source": i["source"],
            "video_id": i.get("video_id"), "video_title": i.get("video_title"), "text": i["text"],
            "created_at": i.get("created_at"), "trust_at_suggestion": i.get("trust"),
            "quality": quality, "spam": is_spam, "cluster_id": cluster_id, "item_id": item_id,
            "run": date,
        }

    for iid in spam:
        ledger(iid, None, None, config.SPAM_QUALITY, True)
    for c in judgements["clusters"]:
        cid = c["cluster_id"]
        sai = c.get("same_as_item")
        rec = st["clusters"].get(cid)
        if rec is None:
            rec = st["clusters"][cid] = {"idea_ids": [], "video_ids": [], "first_run": date, "item_id": None}
        rec.update({"title": c["title"].strip(), "summary": c["summary"].strip(), "impact": c["impact"],
                    "effort": c["effort"], "conflicts": c["conflicts"], "last_run": date})
        rec["video_ids"] = list(dict.fromkeys(rec.get("video_ids", []) + c["video_ids"]))
        rec["idea_ids"] = list(dict.fromkeys(rec.get("idea_ids", []) + c["idea_ids"]))
        if sai:
            rec["item_id"] = sai
            rec["same_as_item"] = sai
            item = st["items"].setdefault(sai, {"batch_id": None, "cluster_id": None, "idea_ids": []})
            item["idea_ids"] = list(dict.fromkeys(item["idea_ids"] + c["idea_ids"]))
        for iid in c["idea_ids"]:
            ledger(iid, cid, sai, float(c["quality"][iid]), False)


def build_item(st: dict, cid: str, date: str, raters: dict[str, dict]) -> dict:
    c = st["clusters"][cid]
    led = [(iid, st["processed"][iid]) for iid in c["idea_ids"] if iid in st["processed"]]
    led = [(iid, x) for iid, x in led if not x.get("spam")]
    sugg: dict[str, dict] = {}
    for _, x in led:
        uid = x["uid"]
        r = raters.get(uid, {})
        sugg[uid] = {"uid": uid, "nickname": r.get("nickname") or x.get("nickname") or "",
                     "trust": float(r.get("trust", config.TRUST_START))}
    suggesters = sorted(sugg.values(), key=lambda s: (-s["trust"], s["nickname"]))
    led.sort(key=lambda p: (-(p[1].get("quality") or 0), -sugg[p[1]["uid"]]["trust"]))
    quotes, seen = [], set()
    for _, x in led:
        q = x["text"].strip()
        if len(q) > config.QUOTE_MAX_CHARS:
            q = q[: config.QUOTE_MAX_CHARS - 1].rstrip() + "…"
        if q.lower() in seen:
            continue
        seen.add(q.lower())
        quotes.append(q)
        if len(quotes) >= config.MAX_QUOTES:
            break
    item_id = f"{date}-{cid}"[:64]
    return {
        "id": item_id,
        "title": c["title"],
        "summary": c["summary"],
        "videoIds": list(c.get("video_ids", [])),
        "suggesters": suggesters,
        "quotes": quotes,
        "impact": int(c["impact"]),
        "effort": int(c["effort"]),
        "score": cluster_score(c["impact"], c["effort"], [s["trust"] for s in suggesters]),
        "conflicts": c.get("conflicts"),
        "verdict": None,
        "note": "",
    }


def run(date: str, wdir: Path, fs: Firestore | None = None, force: bool = False) -> dict:
    judgements, new_ideas, errors, warnings = load_and_validate(wdir)
    st = common.load_state()
    if new_ideas and new_ideas["ideas"] and all(i["idea_id"] in st["processed"] for i in new_ideas["ideas"]):
        raise PublishError(f"{wdir}/new_ideas.json was already published (ideas are marked processed). "
                           "Run export again for a new day.")
    if errors:
        raise PublishError("judgements.json is invalid:\n  - " + "\n  - ".join(errors))
    fs = fs or Firestore()
    snapshot = storage.read_json(Path(wdir) / "snapshot.json", {}) or {}
    raters = {r["_id"]: r for r in snapshot.get("raters", [])}

    batches = fs.list_docs("batches")
    if any(b["_id"] == date for b in batches) and not force:
        raise PublishError(f"batches/{date} already exists (use --force to replace it)")
    batches = [b for b in batches if b["_id"] != date]

    _merge_judgements(st, judgements, new_ideas, date)

    # candidates: clusters not yet published, seen within BACKLOG_DAYS
    cutoff = (dt.date.fromisoformat(date) - dt.timedelta(days=config.BACKLOG_DAYS)).isoformat()
    candidates = []
    for cid, c in st["clusters"].items():
        if c.get("item_id") is None and c.get("last_run", date) >= cutoff:
            item = build_item(st, cid, date, raters)
            if item["suggesters"]:
                candidates.append((cid, item))
    candidates.sort(key=lambda p: (-p[1]["score"], -p[1]["impact"], p[0]))
    chosen = candidates[: config.BATCH_SIZE]

    # older open batches: close if fully reviewed, else carry their unreviewed items
    eff = effective_verdicts(batches)
    closed, carried, kept_open = [], [], []
    for b in sorted(batches, key=lambda b: b["_id"]):
        if b.get("status") != "open" or b["_id"] >= date:
            continue
        pending = [it for it in b.get("items", []) or [] if eff.get(it.get("id"), {}).get("verdict") is None]
        if not pending:
            closed.append(b["_id"])
        else:
            kept_open.append(b["_id"])
            for it in pending:
                if all(it.get("id") != c.get("id") for c in carried):
                    carried.append({k: it.get(k) for k in
                                    ("id", "title", "summary", "videoIds", "suggesters", "quotes", "impact",
                                     "effort", "score", "conflicts", "verdict", "note")})
    for bid in closed:
        fs.update_fields(f"batches/{bid}", {"status": "closed"})

    new_items = [it for _, it in chosen]
    items = carried + new_items
    created = False
    if items:
        fs.set_doc(f"batches/{date}", {"createdAt": dt.datetime.now(dt.timezone.utc), "status": "open",
                                       "items": items})
        created = True
    for cid, it in chosen:
        st["clusters"][cid]["item_id"] = it["id"]
        st["items"][it["id"]] = {"batch_id": date, "cluster_id": cid, "idea_ids": list(st["clusters"][cid]["idea_ids"])}
        for iid in st["clusters"][cid]["idea_ids"]:
            if iid in st["processed"]:
                st["processed"][iid]["item_id"] = it["id"]

    result = {
        "batch_id": date if created else None, "new_items": len(new_items), "carried_items": len(carried),
        "closed_batches": closed, "kept_open": kept_open, "candidates": len(candidates),
        "spam": len(judgements["spam"]), "warnings": warnings,
    }
    storage.write_json(Path(wdir) / "publish.json", {
        **result,
        "ranking": [{"cluster_id": cid, "item_id": it["id"], "title": it["title"], "score": it["score"],
                     "impact": it["impact"], "effort": it["effort"], "n_suggesters": len(it["suggesters"]),
                     "published": i < config.BATCH_SIZE} for i, (cid, it) in enumerate(candidates)],
        "notes": judgements.get("notes"),
    })
    common.log_run(st, date, "publish", **{k: v for k, v in result.items() if k != "warnings"})
    common.save_state(st)
    result["problems"] = storage.confirm_writes()
    return result
