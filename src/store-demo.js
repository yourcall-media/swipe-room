// Demo data layer: same interface as src/store.js, backed by localStorage only.
// Ratings never leave the device. Any well-formed invite code is accepted.
export const DEMO = true;

const KEY = 'swipe.demo.v1';
let mem = null;

function load() {
  if (mem) return mem;
  try { mem = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { mem = null; }
  if (!mem || typeof mem !== 'object') mem = {};
  mem.user ||= null;
  mem.raters ||= {};
  mem.ratings ||= {};
  mem.feedback ||= [];
  return mem;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* storage blocked: keep in memory */ }
}
const now = () => new Date().toISOString();
const listeners = { ratings: new Set(), rater: new Set() };
const emitRatings = () => listeners.ratings.forEach((fn) => fn());
const emitRater = () => listeners.rater.forEach((fn) => fn());

export async function authReady() { return load().user; }

export async function ensureSignedIn() {
  const s = load();
  if (!s.user) {
    const rnd = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9]/gi, '').slice(0, 20);
    s.user = { uid: `demo${rnd}` };
    save();
  }
  return s.user;
}

export async function getRater(uid) { return load().raters[uid] || null; }

export async function getInvite(code) {
  return /^[A-Za-z0-9_-]{4,40}$/.test(code) ? { active: true, label: 'demo' } : null;
}

export async function createRater(uid, { nickname, inviteCode }) {
  const s = load();
  s.raters[uid] = { nickname, inviteCode, createdAt: now(), lastSeenAt: now(), trust: 50, badge: 'bronze', ratedCount: 0 };
  save();
  emitRater();
}

export async function touchRater(uid) {
  const s = load();
  if (s.raters[uid]) { s.raters[uid].lastSeenAt = now(); save(); }
}

export function watchRater(uid, cb) {
  const fn = () => { const r = load().raters[uid]; if (r) cb(r); };
  listeners.rater.add(fn);
  queueMicrotask(fn);
  return () => listeners.rater.delete(fn);
}

export function watchRatings(uid, cb) {
  const fn = () => cb(Object.values(load().ratings).filter((r) => r.uid === uid).map((r) => ({ videoId: r.videoId, pending: false })));
  listeners.ratings.add(fn);
  queueMicrotask(fn);
  return () => listeners.ratings.delete(fn);
}

export const pendingWrites = () => Promise.resolve();

export async function saveRating(uid, videoId, rating) {
  const s = load();
  s.ratings[`${uid}__${videoId}`] = { ...rating, createdAt: now(), updatedAt: now() };
  if (s.raters[uid]) s.raters[uid].ratedCount = Object.values(s.ratings).filter((r) => r.uid === uid).length;
  save();
  emitRatings();
}

export async function deleteRating(uid, videoId) {
  const s = load();
  delete s.ratings[`${uid}__${videoId}`];
  save();
  emitRatings();
}

export async function addFeedback(uid, { text, via }) {
  const s = load();
  s.feedback.push({ uid, text, via, createdAt: now() });
  save();
}
