"""Synthetic Swipe Room data: good raters, lazy straight-liners, spammers."""
from __future__ import annotations

import datetime as dt
import random

N_VIDEOS = 16
VIDEOS = [{"id": f"vid-{i:02d}", "cat": "test", "title": f"Test video {i:02d}", "hook": f"Hook {i:02d}",
           "dur": 40, "v": f"v/vid-{i:02d}.mp4", "p": f"p/vid-{i:02d}.jpg", "w": 540, "h": 960}
          for i in range(1, N_VIDEOS + 1)]
TRULY_GOOD = {v["id"] for v in VIDEOS[: N_VIDEOS // 2]}

GOOD = [f"good-rater-{i:02d}xx" for i in range(1, 7)]
LAZY = [f"lazy-rater-{i:02d}xx" for i in range(1, 4)]
SPAM = [f"spam-rater-{i:02d}xx" for i in range(1, 4)]
OWNER = "owner-uid-000001"

HOOK_IDEAS = [
    "Open on the {t} object itself mid-action in frame one, cut the 2 s logo intro; the hook should be the odd claim.",
    "First line should state the paradox in one breath, e.g. 'He paid zero tax on {t}', not the date.",
]
PACE_IDEAS = [
    "Middle section of {t} repeats the same chart twice around 20 s, cut it and add the reveal shot at 60% of runtime.",
    "Ending of {t} drags 5 s after the payoff; stop on the twist line and loop back to the opening shot.",
]


def ts(day: int, minute: int = 0) -> dt.datetime:
    return dt.datetime(2031, 1, day, 9, 0, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=minute)


def rater_doc(nick: str, day: int) -> dict:
    return {"nickname": nick, "inviteCode": "TESTCODE", "createdAt": ts(day), "lastSeenAt": ts(day, 30)}


def rating(uid, vid, verdict, reasons, pct, sec=None, idea="", day=1, minute=0, other=""):
    dur = 40.0
    watched = round(dur * pct, 1) if sec is None else sec
    return f"{uid}__{vid}", {
        "uid": uid, "videoId": vid, "verdict": verdict, "reasons": reasons, "other": other,
        "watchedSec": watched, "durationSec": dur, "watchedPct": pct,
        "dropOffSec": None if pct >= 0.99 else watched, "swipedEarly": pct < 0.99,
        "idea": idea, "ideaVia": "text" if idea else None,
        "createdAt": ts(day, minute), "updatedAt": ts(day, minute),
        "client": {"ua": "pytest", "vw": 390, "vh": 844},
    }


def seed_day1(fs) -> None:
    rnd = random.Random(42)
    fs.set_doc(f"admins/{OWNER}", {})
    for n, uid in enumerate(GOOD + LAZY + SPAM):
        kind = uid.split("-")[0]
        fs.set_doc(f"raters/{uid}", rater_doc(f"{kind.title()} {n:02d}", 1))
    docs = {}
    for gi, uid in enumerate(GOOD):
        for vi, v in enumerate(VIDEOS):
            truth = "good" if v["id"] in TRULY_GOOD else "bad"
            verdict = truth if rnd.random() > 0.1 else ("bad" if truth == "good" else "good")
            reasons = rnd.sample(sorted({"hook", "story", "learned", "visuals", "share"}), 2) if verdict == "good" \
                else rnd.sample(sorted({"slow", "confusing", "cheap", "audio", "long"}), 1)
            idea = ""
            if (vi - gi) % 16 in range(0, 6):                       # each good rater: ideas on 6 videos
                pool = HOOK_IDEAS if (gi + vi) % 2 == 0 else PACE_IDEAS
                idea = pool[(gi // 2) % 2].format(t=v["title"])
            docs.__setitem__(*rating(uid, v["id"], verdict, reasons, round(rnd.uniform(0.85, 1.0), 2),
                                     idea=idea, minute=vi))
    for uid in LAZY:
        for vi, v in enumerate(VIDEOS):
            idea = {0: "make it better", 5: "nice video, more like this"}.get(vi, "")
            docs.__setitem__(*rating(uid, v["id"], "good", [], round(rnd.uniform(0.4, 0.6), 2), idea=idea, minute=vi))
    for uid in SPAM:
        for vi, v in enumerate(VIDEOS):
            verdict = rnd.choice(["good", "bad"])
            reasons = ["cheap"] if verdict == "good" else ["hook"]   # contradictory
            idea = {1: "CHECK MY CHANNEL www.example.com/spam", 7: "asdfghjkl"}.get(vi, "")
            docs.__setitem__(*rating(uid, v["id"], verdict, reasons, 0.04, sec=round(rnd.uniform(0.8, 2.5), 1),
                                     idea=idea, minute=vi))
    for doc_id, d in docs.items():
        fs.set_doc(f"ratings/{doc_id}", d)
    fs.set_doc("feedback/fb-good-1", {"uid": GOOD[0], "text": "Add a recurring original character across the "
                                      "whole series so comments have someone to react to.", "via": "text",
                                      "createdAt": ts(1, 50)})
    fs.set_doc("feedback/fb-spam-1", {"uid": SPAM[0], "text": "follow me follow me follow me", "via": "text",
                                      "createdAt": ts(1, 51)})


def judge(new_ideas: dict, extra_cluster_ids: dict | None = None, same_as: dict | None = None) -> dict:
    """Deterministic stand-in for the Claude step.

    good ideas -> one cluster per (video, idea kind), quality 0.85;
    lazy ideas -> one generic cluster, quality 0.2; spam ideas -> spam.
    extra_cluster_ids: {video_id: open cluster id} to merge today's ideas into an existing cluster.
    same_as: {video_id: item id} to mark today's ideas on that video as a repeat of a published item.
    """
    extra_cluster_ids = extra_cluster_ids or {}
    same_as = same_as or {}
    clusters: dict[str, dict] = {}
    spam = []
    for i in new_ideas["ideas"]:
        uid, iid = i["uid"], i["idea_id"]
        if uid.startswith("spam"):
            spam.append(iid)
            continue
        if uid.startswith("lazy"):
            cid, title, impact, effort, q = "generic-polish", "Make the videos generally better", 3, 1, 0.2
            vids = []
        elif i["video_id"] is None:
            cid, title, impact, effort, q = "recurring-character", "Add a recurring original character", 4, 4, 0.9
            vids = []
        else:
            kind = "hook" if "Open on" in i["text"] or "First line" in i["text"] else "pacing"
            vid = i["video_id"]
            cid = extra_cluster_ids.get(vid) or (f"{vid}-{kind}-repeat" if vid in same_as else f"{vid}-{kind}")
            title = f"{'Sharper hook' if kind == 'hook' else 'Tighter pacing'} for {vid}"
            impact, effort, q = (4, 2, 0.85) if kind == "hook" else (3, 2, 0.8)
            vids = [vid]
        c = clusters.setdefault(cid, {
            "cluster_id": cid, "title": title,
            "summary": f"{title}: raters point at the same fix; see quotes for the exact moment.",
            "idea_ids": [], "video_ids": vids, "impact": impact, "effort": effort, "quality": {},
            "conflicts": None})
        if i.get("video_id") in same_as:
            c["same_as_item"] = same_as[i["video_id"]]
        c["idea_ids"].append(iid)
        c["quality"][iid] = q
    if "recurring-character" in clusters:
        clusters["recurring-character"]["conflicts"] = "B5 asks for an original recurring character; fine as long as it is not a copy (R10)."
    return {"run_date": new_ideas["run_date"], "clusters": list(clusters.values()), "spam": spam,
            "notes": "fixture judgement"}
