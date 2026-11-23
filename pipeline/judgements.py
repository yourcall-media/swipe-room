"""Validator for judgements.json (the Claude step's output)."""
from __future__ import annotations

import re
from pathlib import Path

from . import common, storage

CLUSTER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
TOP_KEYS = {"run_date", "clusters", "spam", "notes"}
CLUSTER_KEYS = {"cluster_id", "title", "summary", "idea_ids", "video_ids", "impact", "effort",
                "quality", "conflicts"}
CLUSTER_OPTIONAL = {"same_as_item"}


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate(judgements: dict, new_ideas: dict, state: dict, videos: dict | None = None
             ) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Empty errors = valid."""
    E: list[str] = []
    W: list[str] = []
    if not isinstance(judgements, dict):
        return ["judgements.json must be a JSON object"], W
    extra = set(judgements) - TOP_KEYS
    if extra:
        E.append(f"unknown top-level keys: {sorted(extra)}")
    for k in ("run_date", "clusters", "spam"):
        if k not in judgements:
            E.append(f"missing top-level key '{k}'")
    if E:
        return E, W
    if judgements["run_date"] != new_ideas.get("run_date"):
        E.append(f"run_date {judgements['run_date']!r} != new_ideas run_date {new_ideas.get('run_date')!r}")
    if "notes" in judgements and not isinstance(judgements["notes"], str):
        E.append("notes must be a string")

    ideas = {i["idea_id"]: i for i in new_ideas.get("ideas", [])}
    open_ids = {c["cluster_id"] for c in new_ideas.get("open_clusters", [])}
    recent_items = {i["item_id"] for i in new_ideas.get("recent_items", [])}
    known_videos = set(videos or {}) | set(new_ideas.get("video_stats", {})) | {
        i["video_id"] for i in ideas.values() if i.get("video_id")}
    seen: dict[str, str] = {}

    def mark(iid: str, where: str):
        if iid not in ideas:
            E.append(f"{where}: unknown idea_id {iid!r} (not in today's new_ideas.json)")
        elif iid in seen:
            E.append(f"{where}: idea_id {iid!r} already used in {seen[iid]}")
        else:
            seen[iid] = where

    spam = judgements["spam"]
    if not isinstance(spam, list) or not all(isinstance(x, str) for x in spam):
        E.append("spam must be a list of idea_id strings")
        spam = []
    for iid in spam:
        mark(iid, "spam")

    clusters = judgements["clusters"]
    if not isinstance(clusters, list):
        E.append("clusters must be a list")
        clusters = []
    cids = set()
    for n, c in enumerate(clusters):
        where = f"clusters[{n}]"
        if not isinstance(c, dict):
            E.append(f"{where}: must be an object")
            continue
        cid = c.get("cluster_id")
        where = f"cluster {cid!r}" if isinstance(cid, str) else where
        missing = CLUSTER_KEYS - set(c)
        if missing:
            E.append(f"{where}: missing keys {sorted(missing)}")
        unknown = set(c) - CLUSTER_KEYS - CLUSTER_OPTIONAL
        if unknown:
            E.append(f"{where}: unknown keys {sorted(unknown)}")
        if not isinstance(cid, str) or not CLUSTER_ID_RE.match(cid):
            E.append(f"{where}: cluster_id must match {CLUSTER_ID_RE.pattern}")
        else:
            if cid in cids:
                E.append(f"{where}: duplicate cluster_id")
            cids.add(cid)
            if cid in state.get("clusters", {}) and cid not in open_ids:
                E.append(f"{where}: cluster_id was used before and is not an open cluster; pick a new id")
        title, summary = c.get("title"), c.get("summary")
        if not isinstance(title, str) or not 3 <= len(title.strip()) <= 80:
            E.append(f"{where}: title must be a 3-80 char string")
        if not isinstance(summary, str) or not 10 <= len(summary.strip()) <= 500:
            E.append(f"{where}: summary must be a 10-500 char string")
        for k in ("impact", "effort"):
            v = c.get(k)
            if not _is_int(v) or not 1 <= v <= 5:
                E.append(f"{where}: {k} must be an integer 1-5 (got {v!r})")
        conf = c.get("conflicts", None)
        if conf is not None and (not isinstance(conf, str) or not conf.strip()):
            E.append(f"{where}: conflicts must be null or a non-empty string")
        sai = c.get("same_as_item")
        if sai is not None and sai not in recent_items:
            E.append(f"{where}: same_as_item {sai!r} is not a recent_items id")
        iids = c.get("idea_ids")
        if not isinstance(iids, list) or not iids or not all(isinstance(x, str) for x in iids):
            E.append(f"{where}: idea_ids must be a non-empty list of strings")
            iids = []
        if len(set(iids)) != len(iids):
            E.append(f"{where}: idea_ids has duplicates")
        for iid in iids:
            mark(iid, where)
        q = c.get("quality")
        if not isinstance(q, dict):
            E.append(f"{where}: quality must be an object idea_id -> 0..1")
        else:
            if set(q) != set(iids):
                miss, ext = set(iids) - set(q), set(q) - set(iids)
                E.append(f"{where}: quality keys must equal idea_ids (missing {sorted(miss)}, extra {sorted(ext)})")
            for iid, v in q.items():
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1:
                    E.append(f"{where}: quality[{iid!r}] must be a number 0..1 (got {v!r})")
        vids = c.get("video_ids")
        if not isinstance(vids, list) or not all(isinstance(x, str) for x in vids):
            E.append(f"{where}: video_ids must be a list of strings")
        else:
            if len(set(vids)) != len(vids):
                E.append(f"{where}: video_ids has duplicates")
            for v in vids:
                if known_videos and v not in known_videos:
                    E.append(f"{where}: unknown video_id {v!r}")
            idea_videos = {ideas[i]["video_id"] for i in iids if i in ideas and ideas[i].get("video_id")}
            if vids and not idea_videos <= set(vids):
                W.append(f"{where}: ideas are about {sorted(idea_videos - set(vids))} which are not in video_ids")
    missing = set(ideas) - set(seen)
    if missing:
        E.append(f"{len(missing)} idea(s) not judged (put each in a cluster or in spam): "
                 f"{sorted(missing)[:20]}")
    if not E and len(clusters) == 0 and ideas:
        W.append("no clusters: every idea marked spam")
    return E, W


def load_and_validate(wdir: Path) -> tuple[dict | None, dict | None, list[str], list[str]]:
    jpath, npath = Path(wdir) / "judgements.json", Path(wdir) / "new_ideas.json"
    new_ideas = storage.read_json(npath, None)
    if new_ideas is None:
        return None, None, [f"{npath} not found: run `python -m pipeline export` first"], []
    try:
        judgements = storage.read_json(jpath, None)
    except ValueError as exc:
        return None, new_ideas, [f"{jpath} is not valid JSON: {exc}"], []
    if judgements is None:
        return None, new_ideas, [f"{jpath} not found: the Claude step has not written it"], []
    errors, warnings = validate(judgements, new_ideas, common.load_state(), common.load_videos())
    return judgements, new_ideas, errors, warnings
