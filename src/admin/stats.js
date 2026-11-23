// Pure aggregation helpers (no DOM, no Firebase) so they are easy to reason about.

export const GOOD_REASONS = [
  ['hook', 'Hook grabbed me'],
  ['story', 'Story kept me watching'],
  ['learned', 'Learned something new'],
  ['visuals', 'Animation looks great'],
  ['share', "I'd share or follow"],
];
export const BAD_REASONS = [
  ['slow', 'Slow or boring start'],
  ['confusing', 'Hard to follow'],
  ['cheap', 'Looks cheap'],
  ['audio', 'Voice or sound is off'],
  ['long', 'Too long or it dragged'],
];

export const DEFAULT_TRUST = 50;

export function trustOf(rater) {
  const t = rater && typeof rater.trust === 'number' ? rater.trust : DEFAULT_TRUST;
  return Math.max(0, Math.min(100, t));
}

/** Weighted score = Σ(trust/50 · (good?1:-1)) / Σ(trust/50). Range −1..+1, null when no weight. */
export function weightedScore(ratings, ratersById) {
  let num = 0, den = 0;
  for (const r of ratings) {
    const w = trustOf(ratersById[r.uid]) / 50;
    num += w * (r.verdict === 'good' ? 1 : -1);
    den += w;
  }
  return den > 0 ? num / den : null;
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Histogram of drop-off seconds over [0, duration] in `bins` equal bins. */
export function histogram(values, duration, bins = 12) {
  const max = Math.max(1, duration || Math.max(1, ...values));
  const size = max / bins;
  const counts = new Array(bins).fill(0);
  for (const x of values) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) continue;
    counts[Math.min(bins - 1, Math.floor(x / size))]++;
  }
  return { counts, size, max };
}

export function aggregateVideo(videoId, ratings, ratersById, video) {
  const good = ratings.filter((r) => r.verdict === 'good');
  const reasonCounts = {};
  for (const r of ratings) for (const k of r.reasons || []) reasonCounts[k] = (reasonCounts[k] || 0) + 1;
  const duration = (video && video.dur) || median(ratings.map((r) => r.durationSec)) || 0;
  const drops = ratings.map((r) => r.dropOffSec).filter((x) => typeof x === 'number');
  const ideas = ratings
    .filter((r) => r.idea && r.idea.trim())
    .sort((a, b) => (tsMs(b.updatedAt) - tsMs(a.updatedAt)))
    .map((r) => ({ text: r.idea, uid: r.uid, via: r.ideaVia, at: r.updatedAt }));
  const others = ratings.filter((r) => r.other && r.other.trim()).map((r) => ({ text: r.other, uid: r.uid, verdict: r.verdict }));
  return {
    videoId,
    count: ratings.length,
    good: good.length,
    bad: ratings.length - good.length,
    score: weightedScore(ratings, ratersById),
    medianWatched: median(ratings.map((r) => r.watchedPct)),
    swipedEarly: ratings.filter((r) => r.swipedEarly).length,
    reasonCounts,
    duration,
    drops,
    hist: histogram(drops, duration),
    ideas,
    others,
  };
}

export function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return 0;
}
