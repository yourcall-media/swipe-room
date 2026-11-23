# The Claude step: judge today's ideas

You are the Claude Code session running the Swipe Room daily pipeline. `python -m pipeline daily`
has exported today's ideas. **You** do the judging, by reading and thinking. Do not call any LLM
API and do not write a script that scores ideas by keywords. Then you write one file,
`judgements.json`, and the deterministic pipeline does everything else (scores, batch, trust).

## Inputs (read all three in full before writing anything)

1. `<workdir>/new_ideas.json`. The workdir is printed by `daily` and is `runs/<date>/` by default.
   - `ideas[]`: every idea not judged before. Each has `idea_id`, `text`, `source` (`rating` = typed
     or spoken on a video card, `feedback` = a general idea not tied to a video), `uid`, `nickname`,
     `trust` (0-100, start 50), `video_id`, `video_title`, `video_hook`, the rater's `verdict`
     (good/bad), `reasons`, `other`, and watch data (`watched_pct`, `watched_sec`, `duration_sec`,
     `drop_off_sec`, `swiped_early`).
   - `open_clusters[]`: clusters from earlier days that were judged but not published yet (the
     backlog). If today's idea says the same thing, reuse that `cluster_id` (see "Merging").
   - `recent_items[]`: items already shown to the owner, with the owner's `verdict` and `note`. If a
     new idea repeats one of these, set `same_as_item` (see "Repeats").
   - `video_stats`: per video ratings, weighted score and reason counts, for context only.
2. `/mnt/project-files/brand/know-how.md`: the channel's quality standard. Pay most attention to
   the red lines (Part 2.1, R1-R19), the breakout rules (Part 6, B1-B31), the series rules (Part 7)
   and the visual standard (Parts 8-9). Where a rule and an idea disagree, say so in `conflicts`.
   It is about 50 KB. Read it in parts if you need to, but read all of it.
3. `pipeline/judgements.schema.json`: the exact output shape.

## What to produce

Write `<workdir>/judgements.json` (UTF-8, write a temp file and then rename it):

```json
{
  "run_date": "<same as new_ideas.json run_date>",
  "clusters": [
    {
      "cluster_id": "kebab-case-id",
      "title": "Imperative change, max 80 chars",
      "summary": "What to change, where (timestamp/scene if known), and why it should help. 1-3 sentences, max 500 chars.",
      "idea_ids": ["...today's ids only..."],
      "video_ids": ["video ids this applies to, [] = channel-wide"],
      "impact": 1,
      "effort": 1,
      "quality": {"<idea_id>": 0.0},
      "conflicts": null,
      "same_as_item": null
    }
  ],
  "spam": ["<idea_id>", "..."],
  "notes": "optional: patterns you noticed, doubts for the owner (shown in the digest)"
}
```

Hard rules (the validator enforces all of these):
- **Every** `idea_id` in `ideas[]` appears **exactly once**: in one cluster's `idea_ids`, or in `spam`.
- `quality` has one entry per `idea_id` of its cluster (spam ideas get no quality entry; they count as 0).
- `impact` and `effort` are integers from 1 to 5. `quality` values are numbers from 0 to 1.
- `cluster_id` matches `^[a-z0-9][a-z0-9-]{1,47}$`. It is either new (never used before) or an id
  from `open_clusters`.
- `video_ids` must be real video ids (from the ideas or `video_stats`).
- `conflicts` is `null` or a non-empty string. `same_as_item` is optional, `null` or a `recent_items` id.
- No other keys.

Then run `python -m pipeline validate --workdir <workdir>`. Fix every ERROR it prints and run it
again until it prints `OK`. Look at the WARNINGs too: they usually mean `video_ids` is missing a
video the ideas talk about.

## How to judge

### 1. Spam first
Put an idea in `spam` only if it is not an attempt to improve the video or the channel: ads or
self-promotion, links, abuse, gibberish, keyboard mash, copy-pasted text unrelated to the video,
or an empty "test". Low effort is **not** spam. "make it better", "nice" and "more like this" are
real but useless, so they go in a cluster with low quality. Rude but specific criticism is not
spam either.

### 2. Cluster: merge duplicates
One cluster = **one change the owner could approve or reject as a single decision.**
- Merge ideas that ask for the same change, even in different words or languages, and even on
  different videos. For example, "cut the logo intro" on three videos becomes one cluster with
  three `video_ids`.
- Split an idea that asks for two unrelated changes. Put its id in the cluster that matches its
  main point. One id cannot sit in two clusters, so in the summary of the other cluster mention
  that this suggester raised it too.
- Channel-wide ideas (most `feedback` ideas) get `video_ids: []`, unless they name videos.
- Vague ideas with nothing actionable ("make it better", "more like this") go in one catch-all
  cluster per day, for example `vague-general-<date>`, with impact 1. This keeps them out of the
  owner's way while still crediting the raters.
- **Merging:** if an idea matches an `open_clusters` entry, reuse its `cluster_id` and list only
  today's ids. The pipeline adds them to the old cluster. Write `title`, `summary`, `impact`,
  `effort` and `conflicts` for the combined cluster, because your values replace the old ones.
- **Repeats:** if an idea asks for something the owner already decided in `recent_items`, create a
  new cluster for it (new id) with `same_as_item` set to that item id. It will not be shown to the
  owner again, and its suggesters are credited with the owner's verdict. Use this only for a true
  repeat of the same change, not for a related one.

Write the `title` as the change itself ("Open on the burger, not the logo"), not as a topic
("Hook feedback"). The `summary` says what, where and why in plain words, so the owner can decide
without reading the quotes.

### 3. Impact (1-5): if we do this, how much better do views, retention or shares get?
| Score | Meaning | Example |
|---|---|---|
| 5 | Fixes a red line, or a breakout rule, across many videos | "Every video opens on the date card", which breaks B1 (story promise in the first 2 s) channel-wide |
| 4 | Clear retention or share fix on one strong video, or a medium fix channel-wide | "The 0-3 s of Costco gas is a logo; open on the gas pump price" |
| 3 | A real but local improvement | "The chart at 22 s repeats the one at 15 s; cut it" |
| 2 | Polish that few viewers would notice | "The ticker font is slightly small" |
| 1 | Vague, taste-only, or almost no effect | "make it better", "use another music" with no reason |

Raise impact when many independent raters (different uids) say it, when the raters' watch data
supports it (for example most `drop_off_sec` values sit just before the moment the idea names), or
when it lines up with a know-how B-rule backed by evidence. Lower it when only low-trust raters
say it and the stats disagree.

### 4. Effort (1-5): cost to the channel to do it
| Score | Meaning |
|---|---|
| 1 | Change text, the title, the thumbnail, or trim a cut. Minutes. |
| 2 | Re-edit the timing, swap a shot, redo the voice line for one sentence. |
| 3 | A new scene or new 3D shot in one video, or a re-render. |
| 4 | Rework the whole script or structure of a video, or a small change across every video. |
| 5 | New format, series or recurring character, or a pipeline change across the channel. |

### 5. Quality per idea (0-1): how useful was this rater's idea, on its own
Score each idea, not the cluster. Start from 0.5 and use the four parts of the rubric:
- **Specific** (up to +0.2): names a moment, scene, line or number ("at 0:12 the voice says…").
- **Actionable** (up to +0.15): an editor knows exactly what to do.
- **Novel** (up to +0.1): not obvious, and not already in the know-how. Ideas that say the same
  thing on the same day get the same novelty score, because raters cannot see each other's ideas.
  A repeat of an item the owner already decided (`same_as_item`) gets -0.1.
- **Fits the brand** (up to +0.05, down to -0.3): it agrees with know-how.md. An idea that breaks a
  red line, for example "add a 'not financial advice' line in the voice" (R2), "add PART 1/4 tabs"
  (R11) or "use the creator's clip" (R10), scores at most 0.3. Put the conflict in `conflicts`.

Anchors:
| Quality | Example |
|---|---|
| 0.9-1.0 | "The hook says '$12B' before we know who; open on the CEO's face saying the odd claim, then the number (B1, B18)." |
| 0.7-0.8 | "The ending drags about 5 s after the twist. Stop on the twist and loop to the first shot." |
| 0.5 | "The beginning is a bit slow." (true, but not where or how) |
| 0.2-0.3 | "make it better", "more like this", "nice" |
| 0.1 | Off-topic but sincere ("make a video about crypto"), on a video it does not fit |

Quality is about the idea, not about whether you agree with the rater's verdict. Do not use the
rater's trust to set quality, because trust is computed from quality and that would be circular.

### 6. Conflicts
Set `conflicts` when doing the change would break or bend a know-how rule, or when raters disagree
with each other (some ask for X and others ask for not-X). Name the rule and the tension in one or
two sentences, for example: "R11 bans step chips like 'Step 1'; suggest saying the step in the
voice instead." Otherwise use `null`. Do not drop a good idea because it conflicts. The owner
decides.

## Worked example

`ideas[]` (shortened):
- `r:u1__costco-gas:ab12cd34`: "first 3 sec is just the logo, show the gas price sign right away" (video `costco-gas`, watched 0.15, dropped at 2.8 s)
- `r:u2__costco-gas:ee11ff22`: "Opening is slow"
- `r:u3__tesla-decoy:99aa88bb`: "same problem as other vids: logo first, I swipe"
- `f:Xy7`: "put NOT FINANCIAL ADVICE at the start of every video"
- `r:u4__tesla-decoy:12121212`: "SUBSCRIBE TO MY CHANNEL!!! link in bio"

`judgements.json`:
```json
{
  "run_date": "2026-11-24",
  "clusters": [
    {
      "cluster_id": "open-on-object-not-logo",
      "title": "Open on the object, not the logo",
      "summary": "Raters swipe in the first 3 s while the logo shows. Start on the subject mid-action (the Costco gas price sign; the Tesla Roadster) and move the logo into the Pulse sweep (B1, B28).",
      "idea_ids": ["r:u1__costco-gas:ab12cd34", "r:u2__costco-gas:ee11ff22", "r:u3__tesla-decoy:99aa88bb"],
      "video_ids": ["costco-gas", "tesla-decoy"],
      "impact": 5,
      "effort": 2,
      "quality": {"r:u1__costco-gas:ab12cd34": 0.9, "r:u2__costco-gas:ee11ff22": 0.45, "r:u3__tesla-decoy:99aa88bb": 0.7},
      "conflicts": null
    },
    {
      "cluster_id": "disclaimer-at-start",
      "title": "Add a 'not financial advice' line at the start",
      "summary": "One rater wants a disclaimer up front. The brand keeps it as small text on the Call card only.",
      "idea_ids": ["f:Xy7"],
      "video_ids": [],
      "impact": 1,
      "effort": 1,
      "quality": {"f:Xy7": 0.25},
      "conflicts": "R2: no disclaimer in the voice, only small text on the Call card. A disclaimer in the first frame would also break B1."
    }
  ],
  "spam": ["r:u4__tesla-decoy:12121212"],
  "notes": "Logo intro is the dominant complaint again (3 raters, 2 videos)."
}
```

## When you are done
1. `python -m pipeline validate --workdir <workdir>` prints `OK`.
2. Run `python -m pipeline daily --after-judgement --workdir <workdir>` (publish + ingest).
3. Read `<workdir>/digest.md` and give the owner a short summary: the batch size, the top 3 items,
   any conflicts, trust movers, and the best and worst videos.

If `new_ideas.json` has no ideas, `daily` already wrote an empty `judgements.json`. Go straight to step 2.
