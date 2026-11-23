// Shared helpers for the Playwright e2e suite (emulators + static server).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { startServer } from './serve.mjs';

// Playwright is preinstalled globally (not an npm dependency of this repo).
const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch { /* fall through to global */ }
  const g = execSync('npm root -g').toString().trim();
  return require(path.join(g, 'playwright'));
}
export const pw = loadPlaywright();

export const PROJECT = 'demo-swipe-room';
// The suite runs its own emulators (see run.mjs) so other work on 8080/9099 can't interfere.
export const FS_PORT = Number(process.env.E2E_FS_PORT || 28080);
export const AUTH_PORT = Number(process.env.E2E_AUTH_PORT || 29099);
export const FS = `http://127.0.0.1:${FS_PORT}`;
export const AUTH = `http://127.0.0.1:${AUTH_PORT}`;
export const INVITE = 'E2E-CREW';
export const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const DOCS = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;

let server;
export async function appUrl(extra = '') {
  if (!server) server = await startServer(0);
  const { port } = server.address();
  return `http://127.0.0.1:${port}/app/?manifest=/tests/fixtures/videos.json&emu=${FS_PORT}:${AUTH_PORT}${extra}`;
}
export async function stopServer() { await new Promise((r) => (server ? server.close(r) : r())); server = null; }

export async function emulatorsUp() {
  for (const u of [FS, AUTH]) {
    const ok = await fetch(u).then((r) => r.ok, () => false);
    if (!ok) throw new Error(`Emulator not reachable at ${u}. Run: node tests/e2e/run.mjs`);
  }
}

export async function seedInvite(code = INVITE, active = true) {
  const body = { fields: { active: { booleanValue: active }, label: { stringValue: `e2e ${code}` }, createdAt: { timestampValue: new Date().toISOString() } } };
  const r = await fetch(`${DOCS}/invites/${code}`, { method: 'PATCH', headers: OWNER, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`seed invite failed ${r.status} ${await r.text()}`);
}

/** Decode a Firestore REST value into plain JS. */
export function decode(v) {
  if (v == null) return v;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return { ts: v.timestampValue };
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  return v;
}

export async function getDoc(path) {
  const r = await fetch(`${DOCS}/${path}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, x]) => [k, decode(x)]));
}

export async function listDocs(collection) {
  const r = await fetch(`${DOCS}/${collection}?pageSize=300`, { headers: OWNER });
  const j = await r.json();
  return (j.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, decode(x)])) }));
}

export async function waitFor(fn, { timeout = 10000, every = 150, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Stub Google Fonts so the offline sandbox doesn't log network errors. */
export async function stubFonts(context) {
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
}

/** Collect console errors / page errors for a page. */
export function watchConsole(page, { ignore = [] } = {}) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (ignore.some((re) => re.test(t))) return;
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function uidOf(page) {
  return page.evaluate(() => window.__swipe?.uid);
}

/** Onboard a fresh rater through the welcome screen. */
export async function onboard(page, { nick = 'Tester', invite = INVITE, viaUrl = true } = {}) {
  await page.goto(await appUrl(viaUrl ? `&invite=${invite}` : ''));
  await page.locator('#welcome').waitFor();
  await page.fill('#nick', nick);
  if (!viaUrl) await page.fill('#invite', invite);
  await page.click('#welcome-go');
  await page.locator('#feed').waitFor();
  await page.locator('.card.is-top').waitFor();
  return uidOf(page);
}
