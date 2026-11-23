# Swipe Room daily pipeline

This is the once-a-day analysis run for Swipe Room (channel "Your Call"). It is plain Python with
deterministic steps around one judgement step. In that step the Claude Code session running the
pipeline reads the ideas and judges them itself. No LLM API is called.

```
python -m pipeline export     Firestore -> runs/<date>/{snapshot,new_ideas,video_stats}.json
[Claude step]                 read new_ideas.json + know-how.md -> write judgements.json   (CLAUDE_STEP.md)
python -m pipeline validate   check judgements.json (exit 1 + list of errors if invalid)
python -m pipeline publish    score clusters -> batches/<date> (top 15 + carried-over items), mark ideas processed
python -m pipeline ingest     owner verdicts -> trust/badge/ratedCount on raters/{uid}, approved/{id},
                              raters/*.md, approved-ideas.md, runs/<date>/digest.md
python -m pipeline daily                    = export, then print the Claude step instructions
python -m pipeline daily --after-judgement  = publish + ingest
```
Options: `--date YYYY-MM-DD` (default today), `--workdir DIR` (default `<out>/runs/<date>/`; when
given without `--date`, publish/ingest/validate take the date from its `new_ideas.json`), and
`--force` (publish: replace an existing `batches/<date>`). Exit codes: 0 ok, 1 invalid or a
write that could not be confirmed, 2 Firestore or publish error.

## Daily session (what a Claude Code session does)
```bash
cd /home/user/swipe
pip install -r pipeline/requirements.txt            # google-auth, requests (+pytest)
export FIREBASE_SERVICE_ACCOUNT="$(cat /path/sa.json)"   # or the path itself
python -m pipeline daily                             # prints the workdir + the Claude step
# ... the Claude step: follow pipeline/CLAUDE_STEP.md, write runs/<date>/judgements.json ...
python -m pipeline validate --workdir /mnt/project-files/rating-app/runs/<date>/
python -m pipeline daily --after-judgement --workdir /mnt/project-files/rating-app/runs/<date>/
# report runs/<date>/digest.md to the owner
```
Rerunning `ingest` later in the day is safe (it is idempotent and picks up new owner verdicts).
`publish` refuses to run twice for the same work dir.

## Environment
| Variable | Meaning |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The service-account JSON itself, or a path to it (production) |
| `FIRESTORE_EMULATOR_HOST` | `host:port`: use the emulator, with `Authorization: Bearer owner` |
| `SWIPE_PROJECT_ID` | Project id (default: the service account's `project_id`, else `demo-swipe-room`) |
| `SWIPE_OUT` | Output root (default `/mnt/project-files/rating-app/`). Tests set a temp dir. |
| `SWIPE_VIDEOS` | `videos.json` manifest for titles (default `/home/user/swipe/app/videos.json`, optional) |
| `SWIPE_KNOWHOW` | Know-how path shown to the Claude step (default `/mnt/project-files/brand/know-how.md`) |
| `SWIPE_CONFIRM_DELAY` | Seconds before re-reading files written to `/mnt/project-files` (default 10) |
| `SWIPE_ADMIN_URL` | Review link in the digest, `{batch_id}` is filled in |

## Files
Output root (`/mnt/project-files/rating-app/` by default):
- `state.json` holds the processed idea ids, with a ledger per idea (uid, text, Claude quality,
  cluster, batch item), the clusters (the backlog is the ones with `item_id: null`), the item to
  idea mapping, approvals already written to the md file, rater file names, the **trust history
  per rater per run**, and a run log.
- `runs/<date>/` holds `snapshot.json` (raw Firestore export), `new_ideas.json`, `video_stats.json`,
  `judgements.json` (written by Claude), `publish.json` (the full ranking), `trust.json`
  (components per rater) and `digest.md`.
- `raters/<nickname>-<uid6>.md` contains the profile, the trust history table, every idea with
  Claude's quality score and the owner's verdict and note, and rating stats.
- `approved-ideas.md` lists approved items for the video threads. It is append-only, newest first.

Network-mount rules (`/mnt/project-files`): every write is atomic (a temp file in the same folder,
fsync, then rename). At the end of each command, every file written to the mount is re-read once
after `SWIPE_CONFIRM_DELAY` seconds and compared by hash. A mismatch is reported and the command
exits 1. The code never lists or searches the whole mount, and folder paths are printed with a
trailing slash.

Ids: a rating idea is `r:<ratingDocId>:<hash8 of text>`, so an edited idea is judged again. A
feedback idea is `f:<docId>`. A batch item is `<date>-<cluster_id>`.

## Publish
- **Cluster score** = `impact × mean(trust/50 of distinct suggesters) × (1 + 0.15·(n_suggesters−1)) / effort^0.5`.
  It uses trust as of the export. Spam ideas are never suggesters.
- Candidates are today's clusters plus backlog clusters seen in the last `BACKLOG_DAYS` (14). The
  top `BATCH_SIZE` (15) by score become new items.
- `batches/<date>` = `{createdAt, status:'open', items:[carried..., new...]}`. Each item is exactly
  the spec's `{id, title, summary, videoIds, suggesters:[{uid,nickname,trust}], quotes, impact,
  effort, score, conflicts, verdict:null, note:''}`. Quotes are the cluster's best ideas, at most 5,
  ordered by quality.
- An older open batch is closed when every one of its items has a verdict, either in that batch
  or in a newer batch where it was carried. Otherwise it stays open and its unreviewed items are
  copied into today's batch. A verdict from the newest batch with a non-null verdict wins.
  `later` counts as reviewed.
- `same_as_item` clusters are not shown again. Their ideas are linked to that item, so their
  suggesters are credited with its verdict.

## Trust model (0-100, everyone starts at 50)
`trust = 100 × (0.45·V + 0.25·Q + 0.20·E + 0.10·T)`. Each component lies in [0, 1] and equals 0.5
with no data, so a new rater sits at 50 and moves only as evidence builds up (shrinkage). Badge:
bronze < 60, silver 60-79.9, gold ≥ 80. All numbers are in `config.py`.

| | Component | Data | Estimator (prior) |
|---|---|---|---|
| V | Owner verdicts | approve = 1, reject = 0 per item, credited to **every** suggester of the item (batch `suggesters` plus every idea linked to the item). `later` and pending are ignored. Each spam idea also counts as one reject (`SPAM_COUNTS_AS_REJECT`). | Beta(2, 2) posterior mean: `(a+2)/(a+r+4)` |
| Q | Idea quality | Claude's quality 0-1 for each of the rater's ideas; spam = 0 | `(Σq + 0.5·3)/(n + 3)` |
| E | Rating effort | Per rating: `0.6·watch + 0.4·reasons`, times 0.3 if it was decided in under 3 s. watch = 1 if watchedPct ≥ 0.8; 0.75 for an honest early exit (verdict bad, a slow/long/confusing reason, ≥ 30% watched); otherwise `0.5·pct/0.8`. reasons = 1 if every reason belongs to the verdict's side, 0 if any reason contradicts it, 0.5 if empty (0.75 with "other" text). | `(Σe + 0.5·5)/(n + 5)`, then ×0.5 when straight-lining (> 95% the same verdict over ≥ 15 ratings) |
| T | Taste match | For each video with ≥ 3 *other* raters: leave-one-out trust-weighted consensus `c ∈ [−1, 1]`; agreement = `(1 + own·c)/2` | `(Σagree + 0.5·5)/(n + 5)`. The consensus weights use the previous iteration's trust (3 iterations, starting from the stored trust). |

The ingest step writes `trust`, `badge` and `ratedCount` to `raters/{uid}` with update masks, so
other fields are never touched. It only updates existing rater docs. It also appends one entry per
rater per run date to `state.json → trust_history`, replacing a rerun on the same date.

In the synthetic test (16 videos), good raters end around 67-76 (silver), lazy straight-liners
around 37 and spammers around 27-30.

## Tests
```bash
cd /home/user/swipe/pipeline/.tools && npm install        # firebase-tools (already installed)
./node_modules/.bin/firebase setup:emulators:firestore    # downloads the emulator jar once (Java needed)
cd /home/user/swipe && python -m pytest tests/pipeline -q
```
The tests start the Firestore emulator jar on a free port (or reuse one through
`SWIPE_TEST_EMULATOR=host:port`). They seed good raters, lazy straight-liners and spammers, then
run three days: export, fixture judgements, publish, owner verdicts, ingest. They check the
trust ordering (good > lazy > spammer), the exact batch shape, the top-15 cut, carry-over and
closing, `same_as_item`, backlog merging, every output file, and that nothing is written under
`/mnt/project-files`. Unit tests cover the validator, the trust components, the score formula
and service-account loading.
