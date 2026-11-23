"""Markdown output: per-rater files, approved-ideas.md (append-only, newest first), digest."""
from __future__ import annotations

from collections import Counter
from pathlib import Path

from . import config, storage

APPROVED_HEADER = (
    "# Approved ideas\n\n"
    "Owner-approved improvement ideas from Swipe Room raters, newest first. Append-only: the daily\n"
    "pipeline adds new approvals at the top and never edits older entries.\n\n"
)
APPROVED_MARK = "<!-- entries below; newest first -->\n"


def _cell(s) -> str:
    s = "" if s is None else str(s)
    return s.replace("|", "\\|").replace("\n", " ").strip()


def _fmt(x, nd=2):
    return "-" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def prepend_approved(path: Path, date: str, new_items: list[tuple[str, dict]], videos: dict) -> None:
    old = storage.read_text(path, "")
    body = old.split(APPROVED_MARK, 1)[1] if APPROVED_MARK in old else (old if old.strip() else "")
    block = [f"## {date}\n"]
    for item_id, e in new_items:
        it = e["item"]
        vids = ", ".join(f"{v} ({(videos.get(v) or {}).get('title') or '?'})" for v in it.get("videoIds", [])) or "channel-wide"
        who = ", ".join(f"{s.get('nickname')} ({s.get('trust')})" for s in it.get("suggesters", []))
        block.append(f"### {it.get('title')}\n")
        block.append(f"- **Item:** `{item_id}` (batch {e['batch_id']}), score {it.get('score')}, "
                     f"impact {it.get('impact')}, effort {it.get('effort')}")
        block.append(f"- **Videos:** {vids}")
        block.append(f"- **What:** {it.get('summary')}")
        if it.get("conflicts"):
            block.append(f"- **Conflicts:** {it.get('conflicts')}")
        if e.get("note"):
            block.append(f"- **Owner note:** {e['note']}")
        block.append(f"- **Suggested by:** {who}")
        for q in it.get("quotes", [])[:3]:
            block.append(f"  > {_cell(q)}")
        block.append("")
    storage.write_text(path, APPROVED_HEADER + APPROVED_MARK + "\n".join(block) + "\n" + body.lstrip("\n"))


def rater_markdown(uid: str, rdoc: dict, is_admin: bool, res: dict, history: list[dict],
                   ideas: list[tuple[str, dict]], eff: dict, ratings: list[dict], videos: dict) -> str:
    c, n, f = res["components"], res["counts"], res["flags"]
    L = [f"# {rdoc.get('nickname') or 'unknown'} ({uid[:6]})\n"]
    L.append("## Profile\n")
    L.append(f"- **uid:** `{uid}`" + (" (admin)" if is_admin else ""))
    L.append(f"- **Invite code:** {rdoc.get('inviteCode') or '-'}")
    L.append(f"- **Joined:** {rdoc.get('createdAt') or '-'}  |  **Last seen:** {rdoc.get('lastSeenAt') or '-'}")
    L.append(f"- **Trust:** {res['trust']} ({res['badge']})  |  **Ratings:** {n['ratings']}")
    L.append(f"- **Components:** verdicts {c['verdicts']:.2f} · quality {c['quality']:.2f} · "
             f"effort {c['effort']:.2f} · taste {c['taste']:.2f}")
    if f.get("straight_lining"):
        L.append("- **Flag:** straight-lining (almost every verdict the same)")
    L.append("\n## Trust history\n")
    L.append("| Date | Trust | Badge | Verdicts | Quality | Effort | Taste | Approved | Rejected | Spam | Ratings |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for h in sorted(history, key=lambda h: h["date"], reverse=True):
        hc, hn = h["components"], h["counts"]
        L.append(f"| {h['date']} | {h['trust']} | {h['badge']} | {hc['verdicts']:.2f} | {hc['quality']:.2f} | "
                 f"{hc['effort']:.2f} | {hc['taste']:.2f} | {hn.get('approved', 0)} | "
                 f"{hn.get('rejected', 0) - hn.get('spam', 0)} | {hn.get('spam', 0)} | {hn.get('ratings', 0)} |")
    L.append("\n## Ideas\n")
    if not ideas:
        L.append("_No ideas yet._")
    else:
        L.append("| Date | Video | Idea | Quality | Item | Verdict | Owner note |")
        L.append("|---|---|---|---|---|---|---|")
        for iid, led in sorted(ideas, key=lambda p: str(p[1].get("created_at") or ""), reverse=True):
            item_id = led.get("item_id")
            e = eff.get(item_id) if item_id else None
            if led.get("spam"):
                verdict = "spam"
            elif e:
                verdict = e["verdict"] or "pending"
            else:
                verdict = "not published"
            vid = led.get("video_id")
            vname = (videos.get(vid) or {}).get("title") or led.get("video_title") or vid or "general"
            L.append(f"| {_cell((led.get('created_at') or '')[:10])} | {_cell(vname)} | {_cell(led.get('text'))} | "
                     f"{_fmt(led.get('quality'))} | {_cell(item_id or '-')} | {verdict} | {_cell(e['note'] if e else '')} |")
    L.append("\n## Rating stats\n")
    if not ratings:
        L.append("_No ratings yet._")
    else:
        good = sum(1 for r in ratings if r.get("verdict") == "good")
        pcts = [float(r.get("watchedPct") or 0) for r in ratings]
        reasons = Counter(k for r in ratings for k in (r.get("reasons") or []))
        L.append(f"- Ratings: {len(ratings)} (good {good}, bad {len(ratings) - good}, "
                 f"{100 * good / len(ratings):.0f}% good)")
        L.append(f"- Mean watched: {100 * sum(pcts) / len(pcts):.0f}%  |  watched ≥80%: "
                 f"{100 * f.get('full_watch_share', 0):.0f}%  |  very fast swipes (<{config.EFFORT_FAST_SWIPE_SEC:g}s): "
                 f"{f.get('fast_swipes', 0)}")
        L.append(f"- Swiped early: {sum(1 for r in ratings if r.get('swipedEarly'))}  |  "
                 f"with an idea: {sum(1 for r in ratings if (r.get('idea') or '').strip())}")
        if reasons:
            L.append("- Reasons: " + ", ".join(f"{config.REASON_LABELS.get(k, k)} {v}" for k, v in reasons.most_common()))
    return "\n".join(L) + "\n"


def digest_markdown(*, date, new_ratings, total_ratings, stats, movers, publish_info, open_batches,
                    eff, new_approved) -> str:
    L = [f"# Swipe Room digest, {date}\n"]
    L.append(f"- **New ratings since last run:** {new_ratings} (total {total_ratings})")
    if publish_info:
        L.append(f"- **Batch:** {publish_info.get('batch_id') or 'none created'}: "
                 f"{publish_info.get('new_items', 0)} new items, {publish_info.get('carried_items', 0)} carried over; "
                 f"{publish_info.get('spam', 0)} spam ideas")
        bid = publish_info.get("batch_id")
        if bid:
            L.append(f"- **Review:** {config.ADMIN_URL.format(batch_id=bid)}")
    pending = sum(1 for e in eff.values() if e["verdict"] is None)
    L.append(f"- **Open batches:** {', '.join(open_batches) or 'none'} ({pending} items awaiting a verdict)")
    L.append(f"- **Newly approved:** {len(new_approved)}" +
             ("".join(f"\n  - {e['item'].get('title')}" for _, e in new_approved) if new_approved else ""))
    scored = [s for s in stats.values() if s.get("weighted_score") is not None]
    scored.sort(key=lambda s: (-s["weighted_score"], -s["n"]))

    def vrow(s):
        return f"| {_cell(s.get('title') or s['video_id'])} | {s['weighted_score']:+.2f} | {s['n']} | {_fmt(s.get('mean_watched_pct'))} |"

    if scored:
        L.append("\n## Top videos (weighted score)\n")
        L.append("| Video | Score | Ratings | Mean watched |\n|---|---|---|---|")
        L.extend(vrow(s) for s in scored[:5])
        L.append("\n## Bottom videos\n")
        L.append("| Video | Score | Ratings | Mean watched |\n|---|---|---|---|")
        L.extend(vrow(s) for s in list(reversed(scored))[:5])
    moved = sorted(movers, key=lambda m: -abs(m[3] - m[2]))
    moved = [m for m in moved if abs(m[3] - m[2]) >= 0.5][:8]
    L.append("\n## Trust movers\n")
    if moved:
        L.append("| Rater | Before | Now | Change |\n|---|---|---|---|")
        L.extend(f"| {_cell(nick)} | {before:.1f} | {now:.1f} | {now - before:+.1f} |" for _, nick, before, now in moved)
    else:
        L.append("_No trust changes of 0.5 or more._")
    if publish_info.get("notes"):
        L.append(f"\n## Notes from the Claude step\n\n{publish_info['notes']}")
    return "\n".join(L) + "\n"
