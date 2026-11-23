// Owner dashboard e2e against the seeded emulators.
// Run: cd tests/rules && npm run test:admin   (builds admin, starts auth+firestore emulators on test ports,
// seeds them, serves app/ and drives Chromium). Screenshots -> tests/shots/admin-*.png
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SHOTS = path.join(root, 'tests', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

process.env.METADATA_SERVER_DETECTION ||= 'none';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:18080';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:19099';
process.env.FIRESTORE_EMULATOR_HOST = FS_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;

const requireTools = createRequire(path.join(root, 'tests', 'rules', 'package.json'));
const { initializeApp, deleteApp } = requireTools('firebase-admin/app');
const { getFirestore } = requireTools('firebase-admin/firestore');
const { chromium } = createRequire(import.meta.url)('playwright');

const { firebaseConfig } = await import(path.join(root, 'src', 'firebase-config.js'));
const PROJECT = 'demo-swipe-room';

let server, browser, adminApp, db, BASE;
const consoleErrors = [];

function seed() {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'seed_emulator.mjs')], { stdio: 'inherit', env: process.env });
}

async function newPage(viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${page.url()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  return { ctx, page };
}

const url = () => `${BASE}/admin.html?emuAuth=${AUTH_HOST.split(':')[1]}&emuFs=${FS_HOST.split(':')[1]}`;

async function signIn(page, email) {
  await page.goto(url());
  await page.waitForSelector('#emu-signin');
  await page.fill('#emu-email', email);
  await page.click('#emu-signin');
}

const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(SHOTS, `admin-${name}.png`), fullPage });
const tab = (page, id) => page.locator(`.tab[data-tab=${id}]:visible`).click();

before(async () => {
  seed();
  server = await startServer(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  adminApp = initializeApp({ projectId: PROJECT }, 'e2e');
  db = getFirestore(adminApp);
});

after(async () => {
  await browser?.close();
  server?.close();
  if (adminApp) await deleteApp(adminApp);
});

test('sign-in screen renders', async () => {
  const { ctx, page } = await newPage();
  await page.goto(url());
  await page.waitForSelector('#signin');
  assert.equal(await page.locator('#signin').innerText(), 'Sign in with Google');
  await shot(page, 'signin-mobile');
  await ctx.close();
});

test('non-admin sees "Not authorized" with their uid, can sign out', async () => {
  const { ctx, page } = await newPage();
  await signIn(page, 'stranger@example.com');
  await page.waitForSelector('text=Not authorized');
  const uid = (await page.locator('#uid').innerText()).trim();
  assert.match(uid, /^[A-Za-z0-9]{10,}$/);
  assert.equal(await page.locator('.tabs-bottom').count(), 0, 'no dashboard for non-admin');
  await shot(page, 'not-authorized-mobile');
  // granting admin + "Check again" lets them in
  await db.doc(`admins/${uid}`).set({});
  await page.click('text=Check again');
  await page.waitForSelector('.item');
  await db.doc(`admins/${uid}`).delete();
  await page.locator('summary.avatar').click();
  await page.click('#signout');
  await page.waitForSelector('#signin');
  await ctx.close();
});

test('owner reviews: approve / reject / later + note persist', async () => {
  const { ctx, page } = await newPage();
  await signIn(page, 'owner@yourcall.test');
  await page.waitForSelector('.item');
  assert.equal(await page.locator('#progress-text').innerText(), '0 of 10 reviewed');
  await shot(page, 'review-mobile');

  const firstId = await page.locator('.item').first().getAttribute('data-item');
  await page.locator(`[data-item="${firstId}"] .act-approve`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-item="${id}"]`), firstId);
  assert.equal(await page.locator('#progress-text').innerText(), '1 of 10 reviewed');

  const secondId = await page.locator('.item').first().getAttribute('data-item');
  await page.locator(`[data-item="${secondId}"] .act-reject`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-item="${id}"]`), secondId);

  const thirdId = await page.locator('.item').first().getAttribute('data-item');
  await page.locator(`[data-item="${thirdId}"] .link-btn`).click();
  await page.locator(`[data-item="${thirdId}"] textarea`).fill('Revisit after the December batch');
  await page.locator(`[data-item="${thirdId}"] .act-later`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-item="${id}"]`), thirdId);
  assert.equal(await page.locator('#progress-text').innerText(), '3 of 10 reviewed');

  // Firestore state
  const batch = (await db.doc('batches/2026-11-23').get()).data();
  const byId = Object.fromEntries(batch.items.map((i) => [i.id, i]));
  assert.equal(byId[firstId].verdict, 'approve');
  assert.equal(byId[secondId].verdict, 'reject');
  assert.equal(byId[thirdId].verdict, 'later');
  assert.equal(byId[thirdId].note, 'Revisit after the December batch');
  assert.equal(batch.items.filter((i) => i.verdict).length, 3);
  const approved = await db.doc(`approved/${firstId}`).get();
  assert.ok(approved.exists, 'approved copy written');
  assert.equal(approved.data().batchId, '2026-11-23');
  assert.equal((await db.doc(`approved/${secondId}`).get()).exists, false);

  // persists across reload; filter chips show decided items
  await page.reload();
  await page.waitForSelector('.item');
  assert.equal(await page.locator('#progress-text').innerText(), '3 of 10 reviewed');
  await page.click('[data-filter="later"]');
  await page.waitForSelector(`[data-item="${thirdId}"] textarea`);
  assert.equal(await page.locator(`[data-item="${thirdId}"] textarea`).inputValue(), 'Revisit after the December batch');

  // changing an approval to reject removes approved/{id}
  await page.click('[data-filter="approve"]');
  await page.locator(`[data-item="${firstId}"] .act-reject`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-item="${id}"]`), firstId);
  assert.equal((await db.doc(`approved/${firstId}`).get()).exists, false);
  await page.locator(`.chip[data-filter="reject"]`).click();
  await page.locator(`[data-item="${firstId}"] .act-approve`).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-item="${id}"]`), firstId);
  assert.ok((await db.doc(`approved/${firstId}`).get()).exists);
  await page.click('[data-filter="all"]');
  await page.waitForTimeout(350);
  await shot(page, 'review-all-mobile');
  await ctx.close();
});

test('desktop: review, videos and raters render', async () => {
  const { ctx, page } = await newPage({ width: 1280, height: 900 });
  await signIn(page, 'owner@yourcall.test');
  await page.waitForSelector('.item');
  await page.waitForTimeout(350);
  await shot(page, 'review-desktop');

  await tab(page, 'videos');
  await page.waitForSelector('.vitem');
  assert.equal(await page.locator('.vitem').count(), 20);
  // sort by ratings count, descending
  await page.click('[data-sort="count"]');
  const counts = await page.locator('.vitem .vnum:nth-of-type(4) b').allInnerTexts();
  const nums = counts.map(Number);
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  await page.click('[data-sort="score"]');
  const scores = (await page.locator('.vitem .vscore b').allInnerTexts()).map((s) => Number(s.replace('−', '-')));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  await page.locator('.vitem .vrow').first().click();
  await page.waitForSelector('.vitem.open .hist, .vitem.open .rbars');
  assert.ok(await page.locator('.vitem.open .rbar').count() >= 10);
  await shot(page, 'videos-desktop');

  await tab(page, 'raters');
  await page.waitForSelector('.rrow[data-rater]');
  assert.equal(await page.locator('.rrow[data-rater]').count(), 8);
  await shot(page, 'raters-desktop', true);
  await ctx.close();
});

test('mobile videos detail + jump from review chip', async () => {
  const { ctx, page } = await newPage();
  await signIn(page, 'owner@yourcall.test');
  await page.waitForSelector('.item');
  await page.click('[data-filter="all"]');
  const chip = page.locator('.vchip').first();
  await chip.click();
  await page.waitForSelector('.vitem.open');
  await page.waitForTimeout(600);
  await shot(page, 'videos-mobile');
  await ctx.close();
});

test('owner creates and deactivates an invite', async () => {
  const { ctx, page } = await newPage();
  await signIn(page, 'owner@yourcall.test');
  await page.waitForSelector('.item');
  await tab(page, 'raters');
  await page.waitForSelector('#invite-label');
  const before = await page.locator('.invite').count();
  await page.fill('#invite-label', 'Reddit r/investing group');
  await page.click('#invite-create');
  await page.waitForSelector('.invite.fresh');
  assert.equal(await page.locator('.invite').count(), before + 1);
  const code = await page.locator('.invite.fresh').getAttribute('data-code');
  assert.match(code, /^YC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  let inv = (await db.doc(`invites/${code}`).get()).data();
  assert.equal(inv.active, true);
  assert.equal(inv.label, 'Reddit r/investing group');
  await page.locator('.invite.fresh').scrollIntoViewIfNeeded();
  await shot(page, 'raters-mobile', true);
  await page.click(`[data-toggle="${code}"]`);
  await page.waitForSelector(`.invite.off[data-code="${code}"]`);
  inv = (await db.doc(`invites/${code}`).get()).data();
  assert.equal(inv.active, false);
  await ctx.close();
});

test('zero console errors', () => {
  assert.deepEqual(consoleErrors, []);
});
