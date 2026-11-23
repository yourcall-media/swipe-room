"""Unit tests: validator, trust model, score formula, effective verdicts."""
from __future__ import annotations

import copy

import pytest

from pipeline import common, config, trust
from pipeline.judgements import validate
from pipeline.publish import cluster_score, effective_verdicts

NEW_IDEAS = {
    "run_date": "2031-02-01",
    "ideas": [
        {"idea_id": "r:a__v1:1", "uid": "a", "video_id": "v1", "text": "x"},
        {"idea_id": "r:b__v1:2", "uid": "b", "video_id": "v1", "text": "y"},
        {"idea_id": "f:z", "uid": "c", "video_id": None, "text": "z"},
    ],
    "open_clusters": [{"cluster_id": "old-open"}],
    "recent_items": [{"item_id": "2031-01-31-thing"}],
    "video_stats": {"v1": {}},
}
GOOD_J = {
    "run_date": "2031-02-01",
    "clusters": [{"cluster_id": "v1-hook", "title": "Sharper hook", "summary": "Open on the object itself.",
                  "idea_ids": ["r:a__v1:1", "r:b__v1:2"], "video_ids": ["v1"], "impact": 4, "effort": 2,
                  "quality": {"r:a__v1:1": 0.9, "r:b__v1:2": 0.6}, "conflicts": None}],
    "spam": ["f:z"],
}


def errs(j, state=None):
    return validate(j, NEW_IDEAS, state or common.empty_state(), {"v1": {}})[0]


def test_validator_accepts_good():
    assert errs(GOOD_J) == []


@pytest.mark.parametrize("mutate, needle", [
    (lambda j: j["spam"].clear(), "not judged"),
    (lambda j: j["spam"].append("r:a__v1:1"), "already used"),
    (lambda j: j["clusters"][0].update(impact=6), "impact"),
    (lambda j: j["clusters"][0].update(effort=2.5), "effort"),
    (lambda j: j["clusters"][0]["quality"].pop("r:a__v1:1"), "quality keys"),
    (lambda j: j["clusters"][0]["quality"].update({"r:a__v1:1": 1.5}), "0..1"),
    (lambda j: j["clusters"][0].update(cluster_id="Bad Id"), "cluster_id"),
    (lambda j: j["clusters"][0].update(video_ids=["nope"]), "unknown video_id"),
    (lambda j: j["clusters"][0].update(same_as_item="missing"), "same_as_item"),
    (lambda j: j["clusters"][0].update(conflicts=""), "conflicts"),
    (lambda j: j["clusters"][0].update(extra=1), "unknown keys"),
    (lambda j: j.update(run_date="2031-02-02"), "run_date"),
    (lambda j: j["clusters"][0]["idea_ids"].append("ghost"), "unknown idea_id"),
])
def test_validator_rejects(mutate, needle):
    j = copy.deepcopy(GOOD_J)
    mutate(j)
    e = errs(j)
    assert any(needle in x for x in e), e


def test_validator_cluster_id_reuse():
    st = common.empty_state()
    st["clusters"]["v1-hook"] = {"item_id": "published"}
    assert any("used before" in x for x in errs(GOOD_J, st))
    j = copy.deepcopy(GOOD_J)
    j["clusters"][0]["cluster_id"] = "old-open"
    st["clusters"]["old-open"] = {"item_id": None}
    assert errs(j, st) == []


def test_new_rater_starts_at_50():
    r = trust.compute(["u"], [], {}, {}, {})["u"]
    assert r["trust"] == 50.0 and r["badge"] == "bronze"


def test_badges():
    assert config.badge_for(59.9) == "bronze"
    assert config.badge_for(60) == "silver" and config.badge_for(79.9) == "silver"
    assert config.badge_for(80) == "gold"


def test_weights_sum_to_one():
    assert abs(sum(config.TRUST_WEIGHTS.values()) - 1) < 1e-9


def test_straight_lining_and_fast_swipes():
    base = {"verdict": "good", "reasons": ["hook"], "watchedPct": 1.0, "watchedSec": 40, "durationSec": 40}
    honest = [dict(base, verdict="good" if i % 2 else "bad", reasons=["hook"] if i % 2 else ["slow"])
              for i in range(20)]
    liner = [dict(base) for _ in range(20)]
    fast = [dict(base, watchedSec=1.0, watchedPct=0.03) for _ in range(5)]
    assert not trust.straight_lining(honest) and trust.straight_lining(liner)
    assert trust.effort_component(honest)[0] > trust.effort_component(liner)[0]
    assert trust.rating_effort(fast[0]) < 0.15
    # honest early exit on a boring video is not punished like a lazy skip
    early = dict(base, verdict="bad", reasons=["slow"], watchedPct=0.4, watchedSec=16)
    lazy = dict(base, verdict="good", reasons=[], watchedPct=0.4, watchedSec=16)
    assert trust.rating_effort(early) > trust.rating_effort(lazy)


def test_taste_leave_one_out():
    ratings = []
    for v in range(5):
        for u in ("a", "b", "c", "d"):
            ratings.append({"uid": u, "videoId": f"v{v}", "verdict": "good"})
        ratings.append({"uid": "x", "videoId": f"v{v}", "verdict": "bad"})
    t = trust.taste_components(ratings, {})
    assert t["a"][0] > 0.5 > t["x"][0]
    assert t["a"][1] == 5


def test_cluster_score_formula():
    assert cluster_score(4, 4, [50]) == 2.0
    assert cluster_score(3, 1, [100, 50]) == round(3 * 1.5 * 1.15, 3)
    assert cluster_score(3, 1, []) == 0.0


def test_effective_verdicts_newest_non_null_wins():
    b = [{"_id": "2031-01-01", "items": [{"id": "i1", "verdict": None}]},
         {"_id": "2031-01-02", "items": [{"id": "i1", "verdict": "approve", "note": "y"}]},
         {"_id": "2031-01-03", "items": [{"id": "i1", "verdict": None}]}]
    e = effective_verdicts(b)
    assert e["i1"]["verdict"] == "approve" and e["i1"]["batch_id"] == "2031-01-02"


def test_weighted_score_spec():
    rs = [{"uid": "a", "verdict": "good"}, {"uid": "b", "verdict": "bad"}]
    assert common.weighted_score(rs, {"a": 100, "b": 50}) == round((2 - 1) / 3, 4)


def test_service_account_json_or_path(tmp_path, monkeypatch):
    rsa = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.rsa")
    from cryptography.hazmat.primitives import serialization
    import json as _json

    from pipeline.firestore import Firestore

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    sa = {"type": "service_account", "project_id": "proj-x", "private_key_id": "1", "private_key": key,
          "client_email": "x@proj-x.iam.gserviceaccount.com", "client_id": "1",
          "token_uri": "https://oauth2.googleapis.com/token"}
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    monkeypatch.delenv("SWIPE_PROJECT_ID", raising=False)
    monkeypatch.delenv("GCLOUD_PROJECT", raising=False)
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT", _json.dumps(sa))
    assert Firestore().project_id == "proj-x"
    p = tmp_path / "sa.json"
    p.write_text(_json.dumps(sa))
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT", str(p))
    fs = Firestore()
    assert fs.project_id == "proj-x" and fs.base.startswith("https://firestore.googleapis.com")
