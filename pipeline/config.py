"""All tunable numbers and paths for the Swipe Room daily pipeline.

Change weights/priors here only; README.md documents what each one does.
Paths can be overridden with environment variables (tests use SWIPE_OUT).
"""
from __future__ import annotations

import os
from pathlib import Path

# --------------------------------------------------------------------------- paths
PROJECT_FILES = Path("/mnt/project-files")
DEFAULT_OUT = PROJECT_FILES / "rating-app"


def out_root() -> Path:
    """Root for state.json, runs/, raters/, approved-ideas.md."""
    return Path(os.environ.get("SWIPE_OUT", str(DEFAULT_OUT)))


def state_path() -> Path:
    return out_root() / "state.json"


def runs_dir() -> Path:
    return out_root() / "runs"


def raters_dir() -> Path:
    return out_root() / "raters"


def approved_md_path() -> Path:
    return out_root() / "approved-ideas.md"


def knowhow_path() -> Path:
    return Path(os.environ.get("SWIPE_KNOWHOW", str(PROJECT_FILES / "brand" / "know-how.md")))


def videos_manifest_path() -> Path:
    """videos.json of the app (titles/hooks). Missing file is tolerated."""
    return Path(os.environ.get("SWIPE_VIDEOS", "/home/user/swipe/app/videos.json"))


PIPELINE_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = PIPELINE_DIR / "judgements.schema.json"
CLAUDE_STEP_PATH = PIPELINE_DIR / "CLAUDE_STEP.md"

# Seconds to wait before re-reading files written on the network mount (/mnt/project-files).
# Files outside /mnt/project-files are confirmed immediately (no wait).
CONFIRM_DELAY_SEC = float(os.environ.get("SWIPE_CONFIRM_DELAY", "10"))

# Link to the owner's review page printed in the digest. {batch_id} is filled in.
ADMIN_URL = os.environ.get("SWIPE_ADMIN_URL", "admin.html#review/{batch_id}")

# --------------------------------------------------------------------------- firestore
FIRESTORE_SCOPES = ["https://www.googleapis.com/auth/datastore"]
EMULATOR_DEFAULT_PROJECT = "demo-swipe-room"
COLLECTIONS = ["raters", "ratings", "feedback", "batches", "admins"]

# --------------------------------------------------------------------------- publish
BATCH_SIZE = 15                 # new clusters per daily batch (carried-over items come on top)
SUGGESTER_BONUS = 0.15          # score × (1 + 0.15·(n_suggesters-1))
EFFORT_EXPONENT = 0.5           # score / effort^0.5
MAX_QUOTES = 5                  # quotes per batch item
QUOTE_MAX_CHARS = 400
BACKLOG_DAYS = 14               # unpublished clusters compete again for this many days

# --------------------------------------------------------------------------- trust
TRUST_START = 50.0
TRUST_WEIGHTS = {               # must sum to 1
    "verdicts": 0.45,
    "quality": 0.25,
    "effort": 0.20,
    "taste": 0.10,
}
# Owner verdicts: approve=1, reject=0, later ignored. Beta(a, b) prior.
VERDICT_PRIOR_A = 2.0
VERDICT_PRIOR_B = 2.0
# Idea quality: mean Claude quality shrunk toward PRIOR_MEAN with PRIOR_WEIGHT pseudo-ideas.
QUALITY_PRIOR_MEAN = 0.5
QUALITY_PRIOR_WEIGHT = 3.0
SPAM_QUALITY = 0.0              # ideas flagged as spam count with this quality
SPAM_COUNTS_AS_REJECT = True    # each spam idea also adds one 'reject' to the verdict component
# Rating effort, per rating:  (W_WATCH·watch + W_REASON·reasons) × fast_penalty
EFFORT_WATCH_FULL = 0.8         # watchedPct >= this counts as fully watched
EFFORT_EARLY_EXIT_OK = 0.3      # 'bad' + slow/long/confusing reason + watched >= this = honest early exit
EFFORT_EARLY_EXIT_CREDIT = 0.75
EFFORT_W_WATCH = 0.6
EFFORT_W_REASON = 0.4
EFFORT_FAST_SWIPE_SEC = 3.0     # a decision after fewer seconds than this is a very fast swipe
EFFORT_FAST_PENALTY = 0.3       # per-rating multiplier for very fast swipes
EFFORT_PRIOR_MEAN = 0.5
EFFORT_PRIOR_WEIGHT = 5.0
STRAIGHT_LINE_MIN_RATINGS = 15
STRAIGHT_LINE_SHARE = 0.95      # > this share of one verdict = straight-lining
STRAIGHT_LINE_FACTOR = 0.5      # effort component multiplier when straight-lining
# Taste match: leave-one-out trust-weighted consensus per video.
TASTE_MIN_OTHERS = 3
TASTE_PRIOR_MEAN = 0.5
TASTE_PRIOR_WEIGHT = 5.0
TASTE_ITERATIONS = 3            # consensus uses trust from the previous iteration

BADGES = [(80.0, "gold"), (60.0, "silver"), (0.0, "bronze")]  # trust >= threshold

GOOD_REASONS = {"hook", "story", "learned", "visuals", "share"}
BAD_REASONS = {"slow", "confusing", "cheap", "audio", "long"}
EARLY_EXIT_REASONS = {"slow", "long", "confusing"}
REASON_LABELS = {
    "hook": "Hook grabbed me", "story": "Story kept me watching", "learned": "Learned something new",
    "visuals": "Animation looks great", "share": "I'd share or follow",
    "slow": "Slow or boring start", "confusing": "Hard to follow", "cheap": "Looks cheap",
    "audio": "Voice or sound is off", "long": "Too long or it dragged",
}


def badge_for(trust: float) -> str:
    for threshold, name in BADGES:
        if trust >= threshold:
            return name
    return "bronze"
