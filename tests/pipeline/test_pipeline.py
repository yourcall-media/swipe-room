"""End-to-end: emulator seed -> export -> fixture judgements -> publish -> owner verdicts -> ingest."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import seed
from pipeline import cli, common, config, storage

D1, D2, D3 = "2031-01-01", "2031-01-02", "2031-01-03"
ITEM_KEYS = {"id", "title", "summary", "videoIds", "suggesters", "quotes", "impact", "effort", "score",
             "conflicts", "verdict", "note"}


def run(*args) -> int:
    return cli.main(list(args))


def wdir(out: Path, date: str) -> Path:
    return out / "runs" / date


def write_judgements(out: Path, date: str, **kw) -> dict:
    ni = json.loads((wdir(out, date) / "new_ideas.json").read_text())
    j = seed.judge(ni, **kw)
    (wdir(out, date) / "judgements.json").write_text(json.dumps(j, indent=2))
    return j


def owner_review(fs, batch_id: str, decide) -> None:
    """decide(item) -> (verdict|None, note). Writes verdicts like admin.html would."""
    b = fs.get_doc(f"batches/{batch_id}")
    items = b["items"]
    for it in items:
        v, note = decide(it)
        it["verdict"], it["note"] = v, note
    fs.update_fields(f"batches/{batch_id}", {"items": items})


def assert_batch_shape(b: dict) -> None:
    assert set(b) - {"_id", "_updateTime"} == {"createdAt", "status", "items"}
    assert b["status"] in ("open", "closed")
    assert isinstance(b["createdAt"], str) and b["createdAt"].endswith("Z")   # Firestore timestamp
    for it in b["items"]:
        assert set(it) == ITEM_KEYS, set(it) ^ ITEM_KEYS
        assert isinstance(it["id"], str) and it["id"]
        assert isinstance(it["title"], str) and isinstance(it["summary"], str)
        assert isinstance(it["videoIds"], list) and all(isinstance(v, str) for v in it["videoIds"])
        assert isinstance(it["suggesters"], list) and it["suggesters"]
        for s in it["suggesters"]:
            assert set(s) == {"uid", "nickname", "trust"}
            assert isinstance(s["uid"], str) and isinstance(s["nickname"], str)
            assert isinstance(s["trust"], (int, float))
        assert isinstance(it["quotes"], list) and all(isinstance(q, str) for q in it["quotes"])
        assert isinstance(it["impact"], int) and 1 <= it["impact"] <= 5
        assert isinstance(it["effort"], int) and 1 <= it["effort"] <= 5
        assert isinstance(it["score"], (int, float))
        assert it["conflicts"] is None or isinstance(it["conflicts"], str)
        assert it["verdict"] in (None, "approve", "reject", "later")
        assert isinstance(it["note"], str)


def test_full_daily_flow(fs, out, capsys):
    # ------------------------------------------------------------------ day 1
    seed.seed_day1(fs)
    assert run("daily", "--date", D1) == 0
    printed = capsys.readouterr().out
    assert "CLAUDE STEP" in printed and "judgements.json" in printed
    w1 = wdir(out, D1)
    for f in ("snapshot.json", "new_ideas.json", "video_stats.json"):
        assert (w1 / f).exists(), f
    ni = json.loads((w1 / "new_ideas.json").read_text())
    n_rating_ideas = 6 * 6 + 3 * 2 + 3 * 2
    assert len(ni["ideas"]) == n_rating_ideas + 2
    one = next(i for i in ni["ideas"] if i["source"] == "rating")
    for k in ("idea_id", "uid", "nickname", "trust", "video_id", "video_title", "verdict", "reasons",
              "watched_pct", "watched_sec", "drop_off_sec", "swiped_early"):
        assert k in one
    assert one["video_title"].startswith("Test video")

    # validate before writing judgements -> error
    assert run("validate", "--workdir", str(w1)) == 1
    j1 = write_judgements(out, D1)
    assert len(j1["clusters"]) > config.BATCH_SIZE          # forces the top-15 cut
    assert run("validate", "--workdir", str(w1)) == 0
    assert run("daily", "--after-judgement", "--workdir", str(w1)) == 0

    b1 = fs.get_doc(f"batches/{D1}")
    assert_batch_shape(b1)
    assert b1["status"] == "open"
    assert len(b1["items"]) == config.BATCH_SIZE
    scores = [it["score"] for it in b1["items"]]
    assert scores == sorted(scores, reverse=True)
    all_suggesters = {s["uid"] for it in b1["items"] for s in it["suggesters"]}
    assert not any(u.startswith("spam") for u in all_suggesters)
    assert any(it["id"].endswith("generic-polish") for it in b1["items"])
    st = json.loads((out / "state.json").read_text())
    assert set(i["idea_id"] for i in ni["ideas"]) <= set(st["processed"])
    backlog = [c for c in st["clusters"].values() if c["item_id"] is None]
    assert len(backlog) == len(j1["clusters"]) - config.BATCH_SIZE

    # owner: approve good-rater items, reject the lazy one, leave two unreviewed
    good_items = [it["id"] for it in b1["items"] if not it["id"].endswith("generic-polish")]
    unreviewed = set(good_items[-2:])

    def decide1(it):
        if it["id"].endswith("generic-polish"):
            return "reject", "Too vague."
        if it["id"] in unreviewed:
            return None, ""
        if it["id"] == good_items[0]:
            return "later", "Next season."
        return "approve", "Do it in the next render."
    owner_review(fs, D1, decide1)

    # re-run ingest so the verdicts count (daily order is publish -> ingest; verdicts arrive later)
    assert run("ingest", "--workdir", str(w1)) == 0
    raters = {r["_id"]: r for r in fs.list_docs("raters")}
    t = {u: raters[u]["trust"] for u in raters}
    assert min(t[u] for u in seed.GOOD) > max(t[u] for u in seed.LAZY), t
    assert min(t[u] for u in seed.LAZY) > max(t[u] for u in seed.SPAM), t
    for u, r in raters.items():
        assert r["badge"] == config.badge_for(r["trust"])
        assert r["ratedCount"] == seed.N_VIDEOS
        assert r["nickname"] and r["inviteCode"] == "TESTCODE"   # untouched fields survive
    assert all(raters[u]["badge"] == "bronze" for u in seed.SPAM + seed.LAZY)

    # files
    rfiles = sorted(p.name for p in (out / "raters").glob("*.md"))
    assert len(rfiles) == len(seed.GOOD + seed.LAZY + seed.SPAM)
    g = (out / "raters" / common.rater_filename(raters[seed.GOOD[1]]["nickname"], seed.GOOD[1])).read_text()
    for section in ("## Profile", "## Trust history", "## Ideas", "## Rating stats"):
        assert section in g
    assert "Do it in the next render." in g and "0.85" in g
    s = (out / "raters" / common.rater_filename(raters[seed.SPAM[0]]["nickname"], seed.SPAM[0])).read_text()
    assert "| spam |" in s
    approved_md = (out / "approved-ideas.md").read_text()
    assert f"## {D1}" in approved_md and "Do it in the next render." in approved_md
    digest = (w1 / "digest.md").read_text()
    for k in ("New ratings since last run", "Top videos", "Bottom videos", "Trust movers", "Review:"):
        assert k in digest
    approved_docs = fs.list_docs("approved")
    n_approved = len(good_items) - len(unreviewed) - 1
    assert len(approved_docs) == n_approved
    assert all(a["verdict"] == "approve" and a["batchId"] == D1 for a in approved_docs)
    st = json.loads((out / "state.json").read_text())
    assert st["trust_history"][seed.GOOD[0]][-1]["date"] == D1

    # ------------------------------------------------------------------ day 2
    approved_item = next(it for it in b1["items"] if it["id"] in {a["_id"] for a in approved_docs})
    approved_vid = approved_item["videoIds"][0]
    open_ids = {c for c, x in st["clusters"].items() if x["item_id"] is None and x["video_ids"]}
    open_cluster = sorted(open_ids)[0]
    open_vid = st["clusters"][open_cluster]["video_ids"][0]
    fs.set_doc("raters/new-rater-0001xx", seed.rater_doc("Newbie", 2))
    for uid, vid in (("new-rater-0001xx", open_vid), (seed.GOOD[2], approved_vid)):
        doc_id, d = seed.rating(uid, vid, "good", ["hook"], 0.95, day=2,
                                idea=f"Open on the coin itself for {vid}, then the odd claim.")
        fs.set_doc(f"ratings/{doc_id}", d)
    capsys.readouterr()
    assert run("daily", "--date", D2) == 0
    w2 = wdir(out, D2)
    ni2 = json.loads((w2 / "new_ideas.json").read_text())
    assert len(ni2["ideas"]) == 2                      # only unprocessed ideas
    assert open_cluster in {c["cluster_id"] for c in ni2["open_clusters"]}
    write_judgements(out, D2, extra_cluster_ids={open_vid: open_cluster},
                     same_as={approved_vid: approved_item["id"]})
    assert run("validate", "--workdir", str(w2)) == 0
    assert run("daily", "--after-judgement", "--workdir", str(w2)) == 0
    b1 = fs.get_doc(f"batches/{D1}")
    b2 = fs.get_doc(f"batches/{D2}")
    assert_batch_shape(b2)
    assert b1["status"] == "open"                      # not fully reviewed -> kept open
    ids2 = [it["id"] for it in b2["items"]]
    assert unreviewed <= set(ids2)                     # carried over
    assert ids2[: len(unreviewed)] == [i for i in good_items if i in unreviewed]
    assert approved_item["id"] not in ids2             # same_as_item never republished
    merged = next(it for it in b2["items"] if it["id"].endswith(open_cluster))
    assert "new-rater-0001xx" in {s["uid"] for s in merged["suggesters"]}

    # owner reviews everything in the day-2 batch (including the carried items)
    owner_review(fs, D2, lambda it: ("approve", "ok") if it["id"] in unreviewed else ("reject", "no"))
    assert run("ingest", "--workdir", str(w2)) == 0
    approved_md = (out / "approved-ideas.md").read_text()
    assert approved_md.index(f"## {D2}") < approved_md.index(f"## {D1}")   # newest first, append-only
    raters = {r["_id"]: r for r in fs.list_docs("raters")}
    assert seed.GOOD[2] in raters and raters["new-rater-0001xx"]["ratedCount"] == 1
    # day-1 batch is now fully reviewed (its leftovers got verdicts in the day-2 batch) -> ingest closes it
    assert fs.get_doc(f"batches/{D1}")["status"] == "closed"

    # ------------------------------------------------------------------ day 3: no ideas -> both batches close
    capsys.readouterr()
    assert run("daily", "--date", D3) == 0
    assert "No new ideas" in capsys.readouterr().out
    assert run("daily", "--after-judgement", "--workdir", str(wdir(out, D3))) == 0
    statuses = {b["_id"]: b["status"] for b in fs.list_docs("batches")}
    assert statuses[D1] == "closed" and statuses[D2] == "closed"
    assert D3 not in statuses                          # day 2 published the whole backlog; nothing left
    assert json.loads((wdir(out, D3) / "publish.json").read_text())["batch_id"] is None
    hist = json.loads((out / "state.json").read_text())["trust_history"][seed.GOOD[0]]
    assert [h["date"] for h in hist] == [D1, D2, D3]

    # publishing the same day twice is refused
    assert run("publish", "--workdir", str(wdir(out, D2))) == 2


def test_nothing_written_to_project_files():
    for d in (D1, D2, D3):
        assert not (config.DEFAULT_OUT / "runs" / d).exists()
    assert storage.dir_str(config.DEFAULT_OUT).endswith("/")
