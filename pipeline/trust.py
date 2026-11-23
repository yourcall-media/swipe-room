"""Rater trust (0-100) from four shrunk components. Pure functions, no I/O.

trust = 100 · Σ weight_k · component_k, every component in [0, 1] and equal to 0.5 with no data,
so a new rater starts at 50. See README.md for the full model.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from . import config as C


def verdict_component(outcomes: list[float]) -> float:
    """outcomes: 1 approve, 0 reject. Posterior mean of Beta(A, B)."""
    a = C.VERDICT_PRIOR_A + sum(outcomes)
    b = C.VERDICT_PRIOR_B + len(outcomes) - sum(outcomes)
    return a / (a + b)


def quality_component(qualities: list[float]) -> float:
    k = C.QUALITY_PRIOR_WEIGHT
    return (sum(qualities) + C.QUALITY_PRIOR_MEAN * k) / (len(qualities) + k)


def rating_effort(r: dict) -> float:
    """Effort score of one rating in [0, 1]."""
    verdict = r.get("verdict")
    pct = float(r.get("watchedPct") or 0.0)
    reasons = set(r.get("reasons") or [])
    if pct >= C.EFFORT_WATCH_FULL:
        watch = 1.0
    elif verdict == "bad" and reasons & C.EARLY_EXIT_REASONS and pct >= C.EFFORT_EARLY_EXIT_OK:
        watch = C.EFFORT_EARLY_EXIT_CREDIT       # honest "it dragged, I left"
    else:
        watch = 0.5 * min(pct / C.EFFORT_WATCH_FULL, 1.0)
    allowed = C.GOOD_REASONS if verdict == "good" else C.BAD_REASONS
    if reasons:
        consistent = 1.0 if reasons <= allowed else 0.0
    else:
        consistent = 0.75 if (r.get("other") or "").strip() else 0.5
    score = C.EFFORT_W_WATCH * watch + C.EFFORT_W_REASON * consistent
    sec, dur = r.get("watchedSec"), r.get("durationSec")
    if isinstance(sec, (int, float)) and sec < C.EFFORT_FAST_SWIPE_SEC and not (
            isinstance(dur, (int, float)) and dur <= C.EFFORT_FAST_SWIPE_SEC):
        score *= C.EFFORT_FAST_PENALTY
    return score


def straight_lining(ratings: list[dict]) -> bool:
    if len(ratings) < C.STRAIGHT_LINE_MIN_RATINGS:
        return False
    top = Counter(r.get("verdict") for r in ratings).most_common(1)[0][1]
    return top / len(ratings) > C.STRAIGHT_LINE_SHARE


def effort_component(ratings: list[dict]) -> tuple[float, dict]:
    k = C.EFFORT_PRIOR_WEIGHT
    scores = [rating_effort(r) for r in ratings]
    comp = (sum(scores) + C.EFFORT_PRIOR_MEAN * k) / (len(scores) + k)
    sl = straight_lining(ratings)
    if sl:
        comp *= C.STRAIGHT_LINE_FACTOR
    n = len(ratings) or 1
    info = {
        "straight_lining": sl,
        "full_watch_share": round(sum(1 for r in ratings if float(r.get("watchedPct") or 0) >= C.EFFORT_WATCH_FULL) / n, 3),
        "fast_swipes": sum(1 for r in ratings if isinstance(r.get("watchedSec"), (int, float))
                           and r["watchedSec"] < C.EFFORT_FAST_SWIPE_SEC),
        "mean_rating_effort": round(sum(scores) / n, 3) if ratings else None,
    }
    return comp, info


def taste_components(ratings: list[dict], trust: dict[str, float]) -> dict[str, tuple[float, int]]:
    """Leave-one-out trust-weighted consensus agreement per rater -> (component, n_videos)."""
    by_video: dict[str, list[dict]] = defaultdict(list)
    for r in ratings:
        if r.get("verdict") in ("good", "bad"):
            by_video[r.get("videoId")].append(r)
    agree: dict[str, list[float]] = defaultdict(list)
    for rs in by_video.values():
        if len(rs) < C.TASTE_MIN_OTHERS + 1:
            continue
        sign = {id(r): (1.0 if r["verdict"] == "good" else -1.0) for r in rs}
        w = {id(r): max(trust.get(r.get("uid"), C.TRUST_START), 0.0) / 50.0 for r in rs}
        tot_num = sum(w[id(r)] * sign[id(r)] for r in rs)
        tot_den = sum(w[id(r)] for r in rs)
        for r in rs:
            den = tot_den - w[id(r)]
            if den <= 0:
                continue
            consensus = (tot_num - w[id(r)] * sign[id(r)]) / den   # in [-1, 1]
            agree[r.get("uid")].append((1.0 + sign[id(r)] * consensus) / 2.0)
    k = C.TASTE_PRIOR_WEIGHT
    out = {}
    for uid, xs in agree.items():
        out[uid] = ((sum(xs) + C.TASTE_PRIOR_MEAN * k) / (len(xs) + k), len(xs))
    return out


def compute(uids: list[str], ratings: list[dict], verdicts: dict[str, list[float]],
            qualities: dict[str, list[float]], prior_trust: dict[str, float]) -> dict[str, dict]:
    """Return {uid: {trust, badge, components, counts, flags}} for every uid in `uids`."""
    by_uid: dict[str, list[dict]] = defaultdict(list)
    for r in ratings:
        by_uid[r.get("uid")].append(r)
    base = {}
    for uid in uids:
        e, einfo = effort_component(by_uid.get(uid, []))
        base[uid] = {
            "verdicts": verdict_component(verdicts.get(uid, [])),
            "quality": quality_component(qualities.get(uid, [])),
            "effort": e,
            "_einfo": einfo,
        }
    trust = {u: float(prior_trust.get(u, C.TRUST_START)) for u in uids}
    taste: dict[str, tuple[float, int]] = {}
    for _ in range(max(1, C.TASTE_ITERATIONS)):
        taste = taste_components(ratings, trust)
        new = {}
        for uid in uids:
            comps = dict(base[uid])
            comps["taste"] = taste.get(uid, (C.TASTE_PRIOR_MEAN, 0))[0]
            t = 100.0 * sum(C.TRUST_WEIGHTS[k] * comps[k] for k in C.TRUST_WEIGHTS)
            new[uid] = min(100.0, max(0.0, t))
        trust = new
    out = {}
    for uid in uids:
        v = verdicts.get(uid, [])
        out[uid] = {
            "trust": round(trust[uid], 1),
            "badge": C.badge_for(round(trust[uid], 1)),
            "components": {
                "verdicts": round(base[uid]["verdicts"], 4),
                "quality": round(base[uid]["quality"], 4),
                "effort": round(base[uid]["effort"], 4),
                "taste": round(taste.get(uid, (C.TASTE_PRIOR_MEAN, 0))[0], 4),
            },
            "counts": {
                "ratings": len(by_uid.get(uid, [])),
                "approved": int(sum(v)),
                "rejected": int(len(v) - sum(v)),
                "judged_ideas": len(qualities.get(uid, [])),
                "taste_videos": taste.get(uid, (0, 0))[1],
            },
            "flags": base[uid]["_einfo"],
        }
    return out
