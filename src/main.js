import * as store from './store.js';
import { authReady, ensureSignedIn } from './store.js';
import { manifestUrl, LIMITS, EARLY_PCT } from './config.js';
import { buildQueue, skipInQueue } from './queue.js';
import { Card, playback } from './card.js';
import { openReasonSheet, openFeedbackSheet, openInfoSheet, sheetOpen } from './sheet.js';
import { $, h, ICON, LOGO, toast, reducedMotion, vibrate } from './ui.js';

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

const S = {
  uid: null,
  rater: null,
  videos: [],
  byId: new Map(),
  rated: new Set(),
  undone: new Set(),
  queue: [],
  top: null,
  next: null,
  history: [],
  pending: 0,
  snapPending: 0,
  bootSync: false,
  online: navigator.onLine,
  feedReady: false,
};

const root = $('#app');
const show = (view) => {
  for (const el of root.children) el.hidden = el.id !== view;
  document.body.dataset.view = view;
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  captureInvite();
  const [manifest, user] = await Promise.all([loadManifest(), authReady()]);
  if (!manifest) return showFatal('We couldn’t load the videos. Check your connection and try again.');
  setVideos(manifest);

  if (user && LS.get('swipe.onboarded') === user.uid) return startFeed(user.uid);
  if (user) {
    if (await store.getRater(user.uid)) {
      LS.set('swipe.onboarded', user.uid);
      return startFeed(user.uid);
    }
  }
  showWelcome();
}

function captureInvite() {
  const params = new URLSearchParams(location.search);
  const code = params.get('invite');
  if (code) {
    LS.set('swipe.invite', code.trim());
    params.delete('invite');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  }
}

async function loadManifest() {
  const url = new URL(manifestUrl(), location.href).href;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    LS.set('swipe.manifest.cache', JSON.stringify({ url, data }));
    return { url, data };
  } catch {
    try {
      const cached = JSON.parse(LS.get('swipe.manifest.cache') || 'null');
      if (cached?.data?.videos) return cached;
    } catch { /* corrupt cache */ }
    return null;
  }
}

function setVideos({ url, data }) {
  const cats = new Map(data.cats || []);
  S.videos = (data.videos || []).filter((v) => v && v.id && v.v).map((v) => ({
    ...v,
    videoUrl: new URL(v.v, url).href,
    posterUrl: v.p ? new URL(v.p, url).href : undefined,
    catLabel: cats.get(v.cat) || null,
  }));
  S.byId = new Map(S.videos.map((v) => [v.id, v]));
}

function showFatal(msg) {
  $('#fatal-msg').textContent = msg;
  show('fatal');
}

// ---------------------------------------------------------------------------
// Welcome / onboarding
// ---------------------------------------------------------------------------
function showWelcome() {
  const form = $('#welcome-form');
  const nick = $('#nick');
  const code = $('#invite');
  const err = $('#welcome-error');
  const btn = $('#welcome-go');
  code.value = LS.get('swipe.invite') || (store.DEMO ? 'DEMO' : '');
  nick.value = LS.get('swipe.nick') || '';
  show('welcome');

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const nickname = nick.value.trim().replace(/\s+/g, ' ');
    const inviteCode = code.value.trim();
    if (nickname.length < LIMITS.nickMin || nickname.length > LIMITS.nickMax) {
      return fail(`Pick a nickname between ${LIMITS.nickMin} and ${LIMITS.nickMax} characters.`, nick);
    }
    if (/[\u0000-\u001F\u007F<>]/.test(nickname)) return fail('Nicknames can’t contain < or > characters.', nick);
    if (!inviteCode) return fail('Add the invite code from your link.', code);
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(inviteCode)) {
      return fail('Invite codes are 4 to 40 letters, numbers, dashes or underscores. Check the link you were sent.', code);
    }
    LS.set('swipe.invite', inviteCode);
    LS.set('swipe.nick', nickname);
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      const user = await ensureSignedIn();
      const inv = await store.getInvite(inviteCode);
      if (!inv || inv.active !== true) {
        return fail('That invite code isn’t active. Check the link you were sent, or ask for a new one.', code);
      }
      await store.createRater(user.uid, { nickname, inviteCode });
      LS.set('swipe.onboarded', user.uid);
      startFeed(user.uid, { fresh: true });
    } catch (ex) {
      const offline = !navigator.onLine || ex?.code === 'unavailable' || ex?.code === 'auth/network-request-failed';
      fail(offline ? 'You seem to be offline. Connect and try again.' : 'Couldn’t sign you in. Check the invite code and try again.');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  };

  function fail(msg, field) {
    err.textContent = msg;
    err.hidden = false;
    field?.focus();
    field?.setAttribute('aria-invalid', 'true');
    field?.addEventListener('input', () => field.removeAttribute('aria-invalid'), { once: true });
  }
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------
function startFeed(uid, { fresh = false } = {}) {
  S.uid = uid;
  show('feed');
  document.body.classList.add('loading-feed');
  wireFeedChrome();

  store.watchRater(uid, (data) => { S.rater = data; renderIdentity(); });
  if (!fresh) store.touchRater(uid).catch(() => {});

  let first = true;
  const build = () => {
    if (!first) return;
    first = false;
    S.queue = buildQueue(S.videos, S.rated);
    S.feedReady = true;
    document.body.classList.remove('loading-feed');
    renderStack();
    renderProgress();
  };
  const fallback = setTimeout(build, 3500);
  store.watchRatings(uid, (list) => {
    let added = false;
    let pending = 0;
    for (const { videoId: id, pending: p } of list) {
      if (p) pending++;
      if (id && !S.rated.has(id) && !S.undone.has(id)) { S.rated.add(id); added = true; }
    }
    S.snapPending = pending;
    renderSync();
    if (first) { clearTimeout(fallback); build(); return; }
    if (added) reconcile();
  }, () => { clearTimeout(fallback); build(); });

  S.bootSync = true;
  store.pendingWrites().then(() => { S.bootSync = false; renderSync(); }, () => { S.bootSync = false; renderSync(); });
  renderSync();
}

/** Server told us about ratings we didn't know (another tab/device). */
function reconcile() {
  const before = S.queue.slice(0, 2).join();
  S.queue = S.queue.filter((id) => !S.rated.has(id) || (S.top && S.top.v.id === id && S.top.locked));
  if (S.queue.slice(0, 2).join() !== before) renderStack();
  renderProgress();
}

let chromeWired = false;
function wireFeedChrome() {
  if (chromeWired) return;
  chromeWired = true;
  $('#btn-bad').addEventListener('click', () => buttonSwipe('bad'));
  $('#btn-good').addEventListener('click', () => buttonSwipe('good'));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-skip').addEventListener('click', skip);
  $('#menu-btn').addEventListener('click', toggleMenu);
  $('#menu-idea').addEventListener('click', () => { closeMenu(); generalIdea(); });
  $('#menu-help').addEventListener('click', () => { closeMenu(); showHelp(); });
  $('#done-idea').addEventListener('click', generalIdea);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden) S.top?.pause(); });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu, #menu-btn')) closeMenu();
  });
  addEventListener('online', () => { S.online = true; renderSync(); });
  addEventListener('offline', () => { S.online = false; renderSync(); });
  $('#stack').addEventListener('cardprogress', (e) => {
    $('#stack').style.setProperty('--p', e.detail);
    const dir = e.target.style.transform.includes('translate3d(-') ? 'bad' : 'good';
    $('#btn-good').style.setProperty('--glow', dir === 'good' ? e.detail : 0);
    $('#btn-bad').style.setProperty('--glow', dir === 'bad' ? e.detail : 0);
  });
  renderIdentity();
}

function makeCard(id) {
  const v = S.byId.get(id);
  const card = new Card(v, {
    onSwipe: (dir) => onSwiped(card, dir),
    onDropOff: (c, update) => {
      vibrate(12);
      toast(update ? `Updated: you’d scroll away at ${fmt(c.dropOffSec)}` : `Noted: you’d scroll away at ${fmt(c.dropOffSec)}`, { tone: 'info' });
    },
  });
  return card;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Make the DOM stack match queue[0] (top) and queue[1] (next). */
function renderStack() {
  const stack = $('#stack');
  const [a, b] = S.queue;
  if (!a) {
    S.top?.destroy(); S.next?.destroy();
    S.top = S.next = null;
    showDone();
    return;
  }
  $('#done').hidden = true;
  stack.hidden = false;
  document.body.classList.remove('all-done');
  if (S.top?.v.id !== a) {
    if (S.next?.v.id === a) { S.top?.destroy(); S.top = S.next; S.next = null; }
    else { S.top?.destroy(); S.top = makeCard(a); stack.append(S.top.el); }
  }
  if (S.next?.v.id !== b) {
    S.next?.destroy();
    S.next = b ? makeCard(b) : null;
    if (S.next) stack.prepend(S.next.el);
  }
  S.next?.el.classList.add('is-next');
  S.top.el.classList.remove('is-next');
  stack.style.setProperty('--p', 0);
  S.top.activate();
  renderControls();
}

function renderControls() {
  $('#btn-undo').disabled = S.history.length === 0;
  $('#btn-skip').disabled = S.queue.length < 2;
  const lock = !S.top || S.top.locked;
  $('#btn-good').disabled = lock;
  $('#btn-bad').disabled = lock;
}

function buttonSwipe(dir) {
  const card = S.top;
  if (!card || card.locked || sheetOpen()) return;
  vibrate(10);
  card.flyOut(dir, 0);
  onSwiped(card, dir);
}

function onSwiped(card, dir) {
  vibrate(14);
  dismissCoach();
  renderControls();
  openReasonSheet(dir, {
    onCancel: () => {
      card.returnToCentre({ from: card.offDir });
      renderControls();
      card.play();
    },
    onSubmit: (answers) => submitRating(card, dir, answers),
  });
}

function submitRating(card, dir, answers) {
  const id = card.v.id;
  const stats = card.stats();
  const rating = {
    uid: S.uid,
    videoId: id,
    verdict: dir,
    reasons: answers.reasons,
    other: answers.other,
    ...stats,
    swipedEarly: stats.watchedPct == null ? true : stats.watchedPct < EARLY_PCT,
    idea: answers.idea,
    ideaVia: answers.ideaVia,
    client: {
      ua: (navigator.userAgent || '').slice(0, LIMITS.ua),
      vw: Math.round(innerWidth),
      vh: Math.round(innerHeight),
    },
  };
  S.rated.add(id);
  S.undone.delete(id);
  S.queue = S.queue.filter((q) => q !== id);
  S.history.push({ id, dir });
  if (S.history.length > 20) S.history.shift();
  track(store.saveRating(S.uid, id, rating), () => {
    // Rejected by the server: give the video back.
    S.rated.delete(id);
    S.history = S.history.filter((x) => x.id !== id);
    if (!S.queue.includes(id)) { S.queue.splice(1, 0, id); renderStack(); }
    renderProgress();
    toast('That rating didn’t save. The video is back in your queue.', { tone: 'error', ms: 4000 });
  });
  card.destroy();
  if (S.top === card) S.top = null;
  renderStack();
  renderProgress();
  toast(dir === 'good' ? 'Saved as good' : 'Saved as bad', { tone: dir, action: { label: 'Undo', run: undo } });
}

function undo() {
  if (sheetOpen()) return;
  const last = S.history.pop();
  if (!last) return;
  const { id, dir } = last;
  track(store.deleteRating(S.uid, id), () => {
    toast('Couldn’t undo on the server.', { tone: 'error' });
  });
  S.rated.delete(id);
  S.undone.add(id);
  S.queue = [id, ...S.queue.filter((q) => q !== id)];
  // Current top slides under; the undone card flies back in from its side.
  const stack = $('#stack');
  if (S.next) S.next.destroy();
  S.next = S.top;
  if (S.next) { S.next.deactivate(); S.next.el.classList.add('is-next'); }
  S.top = makeCard(id);
  stack.append(S.top.el);
  S.top.returnToCentre({ from: dir });
  S.top.activate();
  stack.style.setProperty('--p', 0);
  renderControls();
  renderProgress();
  $('#done').hidden = true;
  stack.hidden = false;
  document.body.classList.remove('all-done');
  toast('Undone. Rate it again', { tone: 'info' });
}

function skip() {
  const card = S.top;
  if (!card || card.locked || sheetOpen() || S.queue.length < 2) return;
  const id = card.v.id;
  S.queue = skipInQueue(S.queue, id, S.byId);
  if (S.queue[0] === id) { toast('Nothing else to show yet'); return; }
  card.locked = true;
  card.pause();
  card.el.classList.add('skipping');
  vibrate(8);
  dismissCoach();
  const finish = () => {
    if (S.top !== card) return;
    S.top = null;
    card.destroy();
    renderStack();
  };
  if (reducedMotion()) finish(); else setTimeout(finish, 240);
  toast('Skipped for now. It’ll come back at the end');
}

function track(promise, onError) {
  S.pending++;
  renderSync();
  promise.then(() => {
    S.pending--;
    renderSync();
  }, (err) => {
    S.pending--;
    renderSync();
    if (err?.code === 'permission-denied' || err?.code === 'invalid-argument' || err?.code === 'failed-precondition') onError?.(err);
  });
}

// ---------------------------------------------------------------------------
// Header bits
// ---------------------------------------------------------------------------
function renderProgress() {
  const total = S.videos.length;
  const done = S.videos.reduce((n, v) => n + (S.rated.has(v.id) ? 1 : 0), 0);
  $('#progress-text').textContent = `${done} of ${total} rated`;
  $('#progress-fill').style.transform = `scaleX(${total ? done / total : 0})`;
  $('#progress').setAttribute('aria-valuenow', String(done));
  $('#progress').setAttribute('aria-valuemax', String(total));
  $('#done-count').textContent = String(total);
  if (S.feedReady && !S.queue.length) showDone();
}

function renderSync() {
  const el = $('#sync');
  const n = Math.max(S.pending, S.snapPending);
  let state = 'ok';
  let label = 'All ratings saved';
  let text = 'Saved';
  if (store.DEMO) {
    label = 'Demo: ratings are saved on this device only';
  } else if (!S.online) {
    state = 'offline';
    text = n ? `Offline · ${n}` : 'Offline';
    label = n ? `Offline. ${n} saved on this device, will sync when you’re back online` : 'Offline. Ratings will sync when you’re back online';
  } else if (n || S.bootSync) {
    state = 'syncing';
    text = n ? `Syncing ${n}` : 'Syncing';
    label = 'Syncing ratings';
  }
  el.dataset.state = state;
  el.setAttribute('aria-label', label);
  el.title = label;
  $('#sync-text').textContent = text;
}

function renderIdentity() {
  const nick = S.rater?.nickname || LS.get('swipe.nick') || '';
  const badge = ['bronze', 'silver', 'gold'].includes(S.rater?.badge) ? S.rater.badge : null;
  const me = $('#me');
  me.dataset.badge = badge || 'none';
  $('#me-initial').textContent = (nick[0] || '?').toUpperCase();
  $('#me-name').textContent = nick;
  me.setAttribute('aria-label', `${nick}${badge ? `, ${badge} badge` : ''}`);
  $('#menu-nick').textContent = nick;
  const mb = $('#menu-badge');
  mb.hidden = !badge;
  mb.dataset.badge = badge || '';
  mb.textContent = badge ? `${badge[0].toUpperCase()}${badge.slice(1)} rater` : '';
}

function toggleMenu() {
  const m = $('#menu');
  if (m.hidden) {
    m.hidden = false;
    $('#menu-btn').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => m.classList.add('open'));
    $('#menu-idea').focus({ preventScroll: true });
  } else closeMenu();
}
function closeMenu() {
  const m = $('#menu');
  m.classList.remove('open');
  m.hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

function generalIdea() {
  S.top?.pause();
  openFeedbackSheet({
    onSubmit: ({ text, via }) => {
      track(store.addFeedback(S.uid, { text, via }), () => {
        toast('That idea didn’t send. Try again in a moment.', { tone: 'error' });
      });
      toast('Thanks! Idea sent', { tone: 'good' });
    },
  });
}

function showHelp() {
  S.top?.pause();
  const row = (k, t) => h('li', {}, h('span', { class: 'help-k' }, k), h('span', {}, t));
  openInfoSheet('How rating works', [
    h('ul', { class: 'help-list' },
      row('Watch', 'Tap once for sound, tap again to pause.'),
      row('Swipe →', 'You’d keep watching or share it.'),
      row('Swipe ←', 'You’d scroll past it.'),
      row('Scroll away', 'Tap “I’d scroll away here” the moment you’d leave. It’s gold for us.'),
      row('Skip', 'Not sure yet? It comes back at the end.')),
    h('p', { class: 'help-fine' }, 'Be honest, harsh is helpful. Videos are AI-generated drafts and not financial advice.'),
  ]);
}

// ---------------------------------------------------------------------------
// Coach mark + done screen
// ---------------------------------------------------------------------------
function dismissCoach() {
  const c = $('#coach');
  if (!c.hidden) { c.classList.add('gone'); setTimeout(() => { c.hidden = true; }, 300); }
  LS.set('swipe.coached', '1');
}

function showDone() {
  const done = $('#done');
  if (!done.hidden) return;
  $('#stack').hidden = true;
  done.hidden = false;
  document.body.classList.add('all-done');
  renderControls();
  const burst = $('#burst');
  burst.replaceChildren();
  if (!reducedMotion()) {
    const colors = ['#C8FF2E', '#E8EAED', '#C8FF2E', '#E0342B', '#9AA0A6'];
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + Math.random() * 0.3;
      const r = 90 + Math.random() * 90;
      burst.append(h('i', {
        style: `--x:${Math.cos(a) * r}px;--y:${Math.sin(a) * r}px;--r:${Math.random() * 360}deg;--d:${Math.random() * 120}ms;background:${colors[i % colors.length]}`,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function onKey(e) {
  if (document.body.dataset.view !== 'feed' || sheetOpen()) return;
  if (e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.key === 'Escape' && !$('#menu').hidden) { closeMenu(); return; }
  const card = S.top;
  const k = e.key;
  if ((k === 'z' || k === 'Z') && e.ctrlKey) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey) return;
  const map = {
    ArrowRight: () => buttonSwipe('good'),
    ArrowLeft: () => buttonSwipe('bad'),
    ' ': () => card?.tap(),
    k: () => card?.tap(),
    m: () => card?.toggleMute(),
    ArrowDown: () => card && !card.locked && card.markDropOff(),
    d: () => card && !card.locked && card.markDropOff(),
    s: () => skip(),
    u: () => undo(),
  };
  const fn = map[k] || map[k.toLowerCase?.()];
  if (!fn) return;
  e.preventDefault();
  dismissCoach();
  fn();
}

// ---------------------------------------------------------------------------
if (LS.get('swipe.coached')) $('#coach').hidden = true;
// Fonts load as media=print (non-blocking); flip them on here rather than via an inline handler (CSP-safe).
const fontCss = document.getElementById('font-css');
if (fontCss) { if (fontCss.sheet) fontCss.media = 'all'; else fontCss.addEventListener('load', () => { fontCss.media = 'all'; }); }
if (store.DEMO) {
  document.body.classList.add('demo');
  for (const el of document.querySelectorAll('[data-demo-note]')) el.hidden = false;
}
$('#fatal-retry').addEventListener('click', () => location.reload());
window.__swipe = S; // handy for debugging on a phone via remote inspector
void playback;
boot().catch(() => showFatal('Something went wrong while starting. Reload to try again.'));
