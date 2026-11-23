// Swipe Room owner dashboard (app/admin.html). Bundled by scripts/build_admin.mjs -> app/dist/admin.js
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  connectAuthEmulator, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithCredential,
  signInWithRedirect, getRedirectResult, signOut,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, query, where, orderBy, limit,
} from 'firebase/firestore';
import { firebaseConfig } from '../firebase-config.js';
import { h, clear, toast, icon, initials, prettifyId } from './util.js';
import { renderReview } from './review.js';
import { renderVideos } from './videos.js';
import { renderRaters } from './raters.js';

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// A named app keeps the owner's Google session separate from the rater app's anonymous
// session on the same origin (both pages share IndexedDB persistence otherwise).
const app = initializeApp(firebaseConfig, 'owner');
// The popup/redirect resolver is passed per call (not at init) so Google's gapi script is only
// fetched when the owner actually starts a sign-in, not on every page load.
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const REDIRECT_FLAG = 'yc-owner-redirect';
const db = getFirestore(app);

if (IS_LOCAL) {
  // Ports can be overridden for tests (?emuAuth=19099&emuFs=18080); only honoured on localhost.
  const qs = new URLSearchParams(location.search);
  const port = (k, d) => { const v = Number(qs.get(k)); return Number.isInteger(v) && v > 0 && v < 65536 ? v : d; };
  connectAuthEmulator(auth, `http://127.0.0.1:${port('emuAuth', 9099)}`, { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', port('emuFs', 8080));
}

const root = document.getElementById('root');
const TABS = [
  ['review', 'Review', 'review'],
  ['videos', 'Videos', 'video'],
  ['raters', 'Raters', 'people'],
];

const ctx = {
  db, auth,
  user: null,
  data: null, // { raters, ratersById, ratings, feedback, invites, batch, videos, videosById }
  tab: 'review',
  rerender: () => renderTab(),
  reload: () => loadData().then(renderTab),
  goVideo: (id) => { ctx.focusVideo = id; setTab('videos'); },
  videoTitle: (id) => ctx.data?.videosById[id]?.title || prettifyId(id),
};
window.__admin = ctx; // handy for debugging in the console; holds nothing secret

// ---------------------------------------------------------------- screens
function screenCenter(...children) {
  clear(root);
  root.appendChild(h('main', { class: 'center' }, h('div', { class: 'center-card' }, brand(), ...children)));
}

function brand() {
  return h('div', { class: 'brand' },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, h('span'), h('span')),
    h('span', { class: 'brand-text' }, h('b', null, 'Your Call'), h('span', null, 'Swipe Room · Owner')));
}

function showLoading(msg = 'Loading…') {
  screenCenter(h('div', { class: 'spinner', role: 'status', 'aria-label': msg }), h('p', { class: 'muted' }, msg));
}

function showSignIn(errMsg) {
  const btn = h('button', { class: 'btn btn-google', id: 'signin', onclick: doSignIn },
    googleG(), 'Sign in with Google');
  screenCenter(
    h('h1', null, 'Owner dashboard'),
    h('p', { class: 'muted' }, 'Review rater ideas, see how every video lands, and manage invites.'),
    btn,
    errMsg ? h('p', { class: 'error', role: 'alert' }, errMsg) : null,
    IS_LOCAL ? emulatorSignIn() : null,
  );
}

// Emulator only: sign in with a fake Google identity without the popup (the Auth emulator accepts
// an unsigned JSON id_token). Handy offline and in automated tests.
function emulatorSignIn() {
  const email = h('input', { class: 'input', id: 'emu-email', type: 'email', value: 'owner@yourcall.test', 'aria-label': 'Emulator email', autocomplete: 'off' });
  const form = h('form', { class: 'emu', id: 'emu-form', onsubmit: async (e) => {
    e.preventDefault();
    const em = email.value.trim().toLowerCase();
    if (!em) return;
    const claims = { sub: emulatorSub(em), email: em, email_verified: true, name: em.split('@')[0] };
    try {
      await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify(claims)));
    } catch (err) { showSignIn(friendlyAuthError(err)); }
  } },
  h('p', { class: 'hint' }, 'Local emulator mode'),
  h('div', { class: 'emu-row' }, email, h('button', { class: 'btn btn-ghost', id: 'emu-signin', type: 'submit' }, 'Fake Google sign-in')));
  return form;
}
// Keep in sync with scripts/seed_emulator.mjs (seeded owner's Google rawId).
function emulatorSub(email) { return `emu-${email.replace(/[^a-z0-9]/g, '-')}`; }

function googleG() {
  const svg = h('svg', { viewBox: '0 0 48 48', width: 20, height: 20, 'aria-hidden': 'true' });
  [['#EA4335', 'M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.3 13.6 17.6 9.5 24 9.5z'],
    ['#4285F4', 'M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z'],
    ['#FBBC05', 'M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.8-6z'],
    ['#34A853', 'M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.4 0-11.7-4.1-13.6-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z'],
  ].forEach(([fill, d]) => svg.appendChild(h('path', { fill, d })));
  return svg;
}

async function doSignIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  } catch (e) {
    const code = e && e.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/web-storage-unsupported') {
      try { sessionStorage.setItem(REDIRECT_FLAG, '1'); } catch { /* private mode */ }
      try { await signInWithRedirect(auth, provider, browserPopupRedirectResolver); } catch (e2) { showSignIn(friendlyAuthError(e2)); }
      return;
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
    showSignIn(friendlyAuthError(e));
  }
}

function friendlyAuthError(e) {
  const code = (e && e.code) || '';
  if (code === 'auth/unauthorized-domain') return `This domain (${location.hostname}) is not authorised for sign-in. Add it in Firebase console → Authentication → Settings → Authorized domains.`;
  if (code === 'auth/operation-not-allowed') return 'Google sign-in is not enabled. Enable it in Firebase console → Authentication → Sign-in method.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  return `Sign-in failed (${code || 'unknown error'}).`;
}

function showNotAuthorized(user) {
  const uidBox = h('code', { class: 'uid', id: 'uid' }, user.uid);
  screenCenter(
    h('h1', null, 'Not authorized'),
    h('p', { class: 'muted' },
      `Signed in as ${user.email || user.displayName || 'this account'}, which is not an admin yet. ` +
      'To grant access, create an empty document admins/{uid} in Firestore (console or Admin SDK) with this uid:'),
    h('div', { class: 'uid-row' }, uidBox,
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => copy(user.uid), 'aria-label': 'Copy uid' }, icon('copy'), 'Copy')),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn btn-ghost', onclick: () => location.reload() }, icon('refresh'), 'Check again'),
      h('button', { class: 'btn btn-ghost', id: 'signout', onclick: () => signOut(auth) }, icon('logout'), 'Sign out')),
  );
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed, select and copy manually', 'bad'); }
}

// ---------------------------------------------------------------- data
async function loadVideos() {
  try {
    const res = await fetch('videos.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    return Array.isArray(j.videos) ? j : { cats: [], videos: [] };
  } catch {
    return { cats: [], videos: [] };
  }
}

async function loadData() {
  const [ratersSnap, ratingsSnap, feedbackSnap, invitesSnap, batchSnap, vids] = await Promise.all([
    getDocs(collection(db, 'raters')),
    getDocs(collection(db, 'ratings')),
    getDocs(collection(db, 'feedback')),
    getDocs(collection(db, 'invites')),
    getDocs(query(collection(db, 'batches'), where('status', '==', 'open'), orderBy('createdAt', 'desc'), limit(1))),
    loadVideos(),
  ]);
  const raters = ratersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const ratersById = Object.fromEntries(raters.map((r) => [r.uid, r]));
  const batchDoc = batchSnap.docs[0];
  ctx.data = {
    raters,
    ratersById,
    ratings: ratingsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    feedback: feedbackSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    invites: invitesSnap.docs.map((d) => ({ code: d.id, ...d.data() })),
    batch: batchDoc ? { id: batchDoc.id, ...batchDoc.data() } : null,
    videos: vids.videos,
    cats: Object.fromEntries((vids.cats || []).map(([k, l]) => [k, l])),
    videosById: Object.fromEntries(vids.videos.map((v) => [v.id, v])),
  };
}

// ---------------------------------------------------------------- shell
let shell;
function buildShell() {
  clear(root);
  const user = ctx.user;
  const tabBtn = ([id, label, ic]) => h('button', {
    class: 'tab', role: 'tab', id: `tab-${id}`, 'data-tab': id, 'aria-controls': 'view',
    onclick: () => setTab(id),
  }, icon(ic), h('span', null, label), h('span', { class: 'tab-badge', id: `badge-${id}` }));

  shell = {
    view: h('section', { id: 'view', class: 'view', role: 'tabpanel', tabindex: '-1' }),
    tabsTop: h('nav', { class: 'tabs-top', role: 'tablist', 'aria-label': 'Sections' }, TABS.map(tabBtn)),
    tabsBottom: h('nav', { class: 'tabs-bottom', role: 'tablist', 'aria-label': 'Sections' }, TABS.map(tabBtn)),
  };
  const avatar = user.photoURL
    ? h('img', { src: user.photoURL, alt: '', class: 'avatar-img', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'avatar-txt' }, initials(user.displayName || user.email));
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      brand(),
      shell.tabsTop,
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn', title: 'Refresh data', 'aria-label': 'Refresh data', id: 'refresh', onclick: async (e) => {
          const b = e.currentTarget; b.classList.add('spin');
          try { await ctx.reload(); toast('Up to date'); } catch (err) { reportError(err); } finally { b.classList.remove('spin'); }
        } }, icon('refresh')),
        h('details', { class: 'menu' },
          h('summary', { class: 'avatar', 'aria-label': 'Account' }, avatar),
          h('div', { class: 'menu-pop' },
            h('div', { class: 'menu-who' }, h('b', null, user.displayName || 'Owner'), h('span', null, user.email || user.uid)),
            h('button', { class: 'btn btn-ghost btn-sm', id: 'signout', onclick: () => signOut(auth) }, icon('logout'), 'Sign out'))))));
  root.append(header, h('main', { class: 'main' }, shell.view), shell.tabsBottom);
}

function setTab(id) {
  if (!TABS.some(([t]) => t === id)) id = 'review';
  ctx.tab = id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  renderTab();
  window.scrollTo({ top: 0 });
}

function renderTab() {
  if (!shell) return;
  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === ctx.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  const pending = ctx.data?.batch?.items?.filter((i) => !i.verdict).length || 0;
  for (const el of document.querySelectorAll('#badge-review')) el.textContent = pending ? String(pending) : '';
  clear(shell.view);
  const render = { review: renderReview, videos: renderVideos, raters: renderRaters }[ctx.tab];
  try {
    render(shell.view, ctx);
  } catch (e) {
    reportError(e);
  }
}

function reportError(e) {
  console.warn(e);
  const msg = e && e.code === 'permission-denied' ? 'Permission denied by Firestore rules.' : (e && e.message) || String(e);
  toast(msg, 'bad');
}
ctx.reportError = reportError;

// ---------------------------------------------------------------- boot
showLoading();
let redirected = false;
try { redirected = sessionStorage.getItem(REDIRECT_FLAG) === '1'; sessionStorage.removeItem(REDIRECT_FLAG); } catch { /* ignore */ }
if (redirected) getRedirectResult(auth, browserPopupRedirectResolver).catch((e) => showSignIn(friendlyAuthError(e)));

onAuthStateChanged(auth, async (user) => {
  ctx.user = user;
  shell = null;
  if (!user || user.isAnonymous) { showSignIn(); return; }
  showLoading('Checking access…');
  let isAdmin = false;
  try {
    isAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists();
  } catch (e) {
    if (e.code !== 'permission-denied') { showSignIn(`Could not check access: ${e.message}`); return; }
  }
  if (!isAdmin) { showNotAuthorized(user); return; }
  showLoading('Loading ratings…');
  try {
    await loadData();
  } catch (e) {
    screenCenter(h('h1', null, 'Could not load data'), h('p', { class: 'error', role: 'alert' }, e.message || String(e)),
      h('button', { class: 'btn btn-ghost', onclick: () => location.reload() }, 'Retry'));
    return;
  }
  buildShell();
  setTab((location.hash || '#review').slice(1));
});
