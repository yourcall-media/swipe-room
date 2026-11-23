const IS_LOCAL = typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname);

/** Default manifest, relative to the page. Video/poster paths inside resolve relative to it. */
export const MANIFEST_URL = 'videos.json';

/** On localhost a `?manifest=` override (persisted) lets tests point at a fixture manifest. */
export function manifestUrl() {
  if (!IS_LOCAL) return MANIFEST_URL;
  const q = new URLSearchParams(location.search).get('manifest');
  try {
    if (q) localStorage.setItem('swipe.manifest', q);
    return q || localStorage.getItem('swipe.manifest') || MANIFEST_URL;
  } catch {
    return q || MANIFEST_URL;
  }
}

export const REASONS = {
  good: [
    ['hook', 'Hook grabbed me'],
    ['story', 'Story kept me watching'],
    ['learned', 'Learned something new'],
    ['visuals', 'Animation looks great'],
    ['share', "I'd share or follow"],
  ],
  bad: [
    ['slow', 'Slow or boring start'],
    ['confusing', 'Hard to follow'],
    ['cheap', 'Looks cheap'],
    ['audio', 'Voice or sound is off'],
    ['long', 'Too long or it dragged'],
  ],
};

export const EARLY_PCT = 0.8;
export const LIMITS = { nickMin: 2, nickMax: 24, other: 500, idea: 2000, ua: 300 };
