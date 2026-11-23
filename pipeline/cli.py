"""Command line: python -m pipeline {export,validate,publish,ingest,daily}."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import common, config, storage


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def claude_step_text(wdir: Path, n_ideas: int, n_open: int) -> str:
    w = storage.dir_str(wdir)
    return f"""
==================== CLAUDE STEP (do this yourself, no API call) ====================
{n_ideas} new idea(s), {n_open} open backlog cluster(s).
1. Read the instructions:   {config.CLAUDE_STEP_PATH}
2. Read the ideas:          {w}new_ideas.json
3. Read the channel rules:  {config.knowhow_path()}
4. Write:                   {w}judgements.json   (schema: {config.SCHEMA_PATH})
5. Check it:                python -m pipeline validate --workdir {wdir}
   (fix every error it prints and re-run until it says OK)
6. Then publish + ingest:   python -m pipeline daily --after-judgement --workdir {wdir}
7. Tell the owner the digest: {w}digest.md
=====================================================================================
"""


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m pipeline", description="Swipe Room daily pipeline")
    p.add_argument("command", choices=["export", "validate", "publish", "ingest", "daily"])
    p.add_argument("--date", default=None, help="run date YYYY-MM-DD (default: today)")
    p.add_argument("--workdir", default=None, help="work dir (default: <out>/runs/<date>/)")
    p.add_argument("--force", action="store_true", help="publish: replace an existing batches/<date>")
    p.add_argument("--after-judgement", action="store_true", help="daily: run publish + ingest")
    a = p.parse_args(argv)
    date = a.date
    if date is None and a.workdir and a.command != "export" and not (a.command == "daily" and not a.after_judgement):
        # publish/ingest/validate on an existing work dir keep the date the export used
        date = (storage.read_json(Path(a.workdir) / "new_ideas.json", {}) or {}).get("run_date")
    date = date or common.today()
    wdir = common.work_dir(date, a.workdir)

    from .firestore import FirestoreError
    from .publish import PublishError

    try:
        if a.command == "export" or (a.command == "daily" and not a.after_judgement):
            from . import export

            res = export.run(date, wdir)
            _print(res)
            if a.command == "daily":
                if res["ideas"] == 0:
                    jpath = wdir / "judgements.json"
                    if not jpath.exists():
                        storage.write_json(jpath, {"run_date": date, "clusters": [], "spam": [],
                                                   "notes": "No new ideas today."})
                        storage.confirm_writes()
                    print(f"\nNo new ideas: wrote an empty {jpath}. Next: "
                          f"python -m pipeline daily --after-judgement --workdir {wdir}")
                else:
                    print(claude_step_text(wdir, res["ideas"], res["open_clusters"]))
            return 1 if res["problems"] else 0

        if a.command == "validate":
            from .judgements import load_and_validate

            _, _, errors, warnings = load_and_validate(wdir)
            for w in warnings:
                print(f"WARNING: {w}")
            for e in errors:
                print(f"ERROR: {e}")
            print("OK: judgements.json is valid" if not errors else f"INVALID: {len(errors)} error(s)")
            return 1 if errors else 0

        if a.command in ("publish", "daily"):
            from . import publish

            res = publish.run(date, wdir, force=a.force)
            print("publish:")
            _print(res)
            if a.command == "publish":
                return 1 if res["problems"] else 0

        if a.command in ("ingest", "daily"):
            from . import ingest

            res = ingest.run(date, wdir)
            print("ingest:")
            _print(res)
            if a.command == "daily":
                print(f"\nDigest: {res['digest']}")
            return 1 if res["problems"] else 0
    except (PublishError, FirestoreError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0
