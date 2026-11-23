// End-to-end tests for the Swipe Room rater app.
// Needs the Firestore + Auth emulators running (see tests/e2e/run.mjs) and a built app/dist/app.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';

const { chromium, webkit, devices } = H.pw;
const SHOTS = new URL('../shots/', import.meta.url).pathname;
let browser;

async function newPage(opts = {}, { ignore = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ...opts });
  await H.stubFonts(context);
  const page = await context.newPage();
  const errors = H.watchConsole(page, { ignore });
  return { context, page, errors };
}

const topId = (page) => page.locator('.card.is-top').getAttribute('data-video-id');
const progress = (page) => page.locator('[data-testid=progress]').textContent();
const synced = (page) => page.locator('#sync[data-state=ok]').waitFor({ timeout: 15000 });

async function rate(page, dir, { reasons = [0], idea = '', viaButton = true } = {}) {
  const before = await topId(page);
  if (viaButton) await page.click(`[data-testid=${dir}]`);
  await page.locator('#sheet.open').waitFor();
  for (const i of reasons) await page.locator('#sheet .chip').nth(i).click();
  if (idea) await page.fill('#idea-input', idea);
  await page.click('[data-testid=submit]');
  await page.locator('#sheet').waitFor({ state: 'hidden' });
  return before;
}

async function dragCard(page, dx) {
  const box = await page.locator('.card.is-top').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y + i * 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

async function touchDrag(context, page, dx) {
  const cdp = await context.newCDPSession(page);
  const box = await page.locator('.card.is-top').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.4;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 10, y: y + i }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// The page can't scroll sideways, and every visible view/sheet either fits or clips its overflow
// (a flung card parked off-screen is clipped, not scrollable).
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
    && document.body.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll('.view:not([hidden]), #sheet:not([hidden])')].every((el) => el.scrollWidth <= el.clientWidth + 1
      || getComputedStyle(el).overflowX === 'clip'));
}

describe('Swipe Room rater app', { concurrency: 1 }, () => {
  before(async () => {
    await H.emulatorsUp();
    await H.seedInvite();
    await H.seedInvite('E2E-OLD', false);
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await H.stopServer();
  });

  test('onboarding: invite from URL, rater doc created with exactly the allowed fields', async () => {
    const { context, page, errors } = await newPage();
    await page.goto(await H.appUrl(`&invite=${H.INVITE}`));
    await page.locator('#welcome').waitFor();
    assert.equal(await page.inputValue('#invite'), H.INVITE);
    assert.ok(!page.url().includes('invite='), 'invite param removed from URL');
    await page.screenshot({ path: `${SHOTS}welcome-390.png` });
    // nickname validation
    await page.fill('#nick', 'A');
    await page.click('#welcome-go');
    await page.locator('#welcome-error').waitFor();
    assert.match(await page.textContent('#welcome-error'), /between 2 and 24/);
    await page.fill('#nick', 'Ana');
    await page.click('#welcome-go');
    await page.locator('.card.is-top').waitFor();
    const uid = await H.uidOf(page);
    const rater = await H.waitFor(() => H.getDoc(`raters/${uid}`), { what: 'rater doc' });
    assert.deepEqual(Object.keys(rater).sort(), ['createdAt', 'inviteCode', 'lastSeenAt', 'nickname']);
    assert.equal(rater.nickname, 'Ana');
    assert.equal(rater.inviteCode, H.INVITE);
    assert.equal(await page.textContent('#me-name'), 'Ana');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('onboarding: inactive invite is refused with a friendly message', async () => {
    const { context, page, errors } = await newPage();
    await page.goto(await H.appUrl());
    await page.fill('#nick', 'Nope');
    await page.fill('#invite', 'E2E-OLD');
    await page.click('#welcome-go');
    await page.locator('#welcome-error').waitFor();
    assert.match(await page.textContent('#welcome-error'), /isn.t active/);
    assert.ok(await page.locator('#welcome').isVisible());
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('play: muted autoplay, first tap unmutes, next tap pauses; progress bar moves', async () => {
    const { context, page, errors } = await newPage();
    await H.onboard(page, { nick: 'Player' });
    const vid = page.locator('.card.is-top video');
    await page.waitForFunction(() => document.querySelector('.card.is-top video').currentTime > 0.3);
    assert.equal(await vid.evaluate((v) => v.muted), true);
    assert.equal(await vid.getAttribute('playsinline'), '');
    assert.equal(await vid.getAttribute('webkit-playsinline'), '');
    assert.equal(await vid.getAttribute('preload'), 'metadata');
    assert.ok(await vid.getAttribute('poster'));
    await page.locator('.card.is-top').click({ position: { x: 150, y: 300 } });
    assert.equal(await vid.evaluate((v) => v.muted), false);
    assert.equal(await vid.evaluate((v) => v.paused), false);
    await page.waitForTimeout(400);
    await page.locator('.card.is-top').click({ position: { x: 150, y: 300 } });
    assert.equal(await vid.evaluate((v) => v.paused), true);
    await page.locator('.card.is-top.paused').waitFor({ timeout: 2000 });
    const bar = await page.locator('.card.is-top .card-progress i').evaluate((i) => i.style.transform);
    assert.match(bar, /scaleX\(0\.[1-9]/);
    // next card only preloads metadata
    assert.equal(await page.locator('.card.is-next video').getAttribute('preload'), 'metadata');
    assert.equal(await page.locator('.card').count(), 2);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('swipe right via drag: physics, GOOD stamp, reasons, doc fields, series order', async () => {
    const { context, page, errors } = await newPage();
    const uid = await H.onboard(page, { nick: 'Dragger' });
    assert.equal(await topId(page), 't1');
    assert.equal(await page.locator('.card.is-next').getAttribute('data-video-id'), 't3', 'series ep1 before ep2');
    await page.waitForFunction(() => document.querySelector('.card.is-top video').currentTime > 1);
    // Small drag springs back.
    await dragCard(page, 40);
    await page.waitForTimeout(700);
    assert.ok(!(await page.locator('#sheet.open').count()), 'small drag does not commit');
    // Mid-drag stamp opacity follows distance.
    const box = await page.locator('.card.is-top').boundingBox();
    await page.mouse.move(box.x + 150, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 300, { steps: 4 });
    const midOpacity = Number(await page.locator('.card.is-top .stamp-good').evaluate((e) => e.style.opacity));
    assert.ok(midOpacity > 0.2 && midOpacity < 1, `stamp opacity partial (${midOpacity})`);
    assert.match(await page.locator('.card.is-top').evaluate((e) => e.style.transform), /rotate\(\d/);
    await page.screenshot({ path: `${SHOTS}drag-good-390.png` });
    await page.mouse.move(box.x + 400, box.y + 300, { steps: 6 });
    await page.mouse.up();
    await page.locator('#sheet.open').waitFor();
    assert.equal(await page.getAttribute('#sheet', 'data-tone'), 'good');
    assert.equal(await page.locator('.card.is-top video').evaluate((v) => v.paused), true, 'video paused under sheet');
    await page.waitForTimeout(400);
    await page.locator('#sheet .chip[data-reason=hook]').click();
    await page.locator('#sheet .chip[data-reason=learned]').click();
    await page.screenshot({ path: `${SHOTS}sheet-good-390.png` });
    await page.click('[data-testid=submit]');
    await synced(page);
    const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`), { what: 'rating doc' });
    assert.equal(r.uid, uid);
    assert.equal(r.videoId, 't1');
    assert.equal(r.verdict, 'good');
    assert.deepEqual(r.reasons, ['hook', 'learned']);
    assert.equal(r.other, '');
    assert.ok(r.watchedSec >= 1, `watchedSec ${r.watchedSec}`);
    assert.ok(Math.abs(r.durationSec - 7) < 0.3, `durationSec ${r.durationSec}`);
    assert.ok(r.watchedPct > 0 && r.watchedPct < 0.8);
    assert.equal(r.swipedEarly, true);
    assert.equal(r.dropOffSec, null);
    assert.equal(r.idea, '');
    assert.equal(r.ideaVia, null);
    assert.ok(r.createdAt.ts && r.updatedAt.ts);
    assert.deepEqual(Object.keys(r.client).sort(), ['ua', 'vh', 'vw']);
    assert.equal(r.client.vw, 390);
    assert.equal(await topId(page), 't3');
    assert.equal(await progress(page), '1 of 5 rated');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('swipe left via button; reasons required; Other with text; idea text saved; drop-off recorded', async () => {
    const { context, page, errors } = await newPage();
    const uid = await H.onboard(page, { nick: 'Lefty' });
    await page.waitForFunction(() => document.querySelector('.card.is-top video').currentTime > 1.2);
    await page.click('.card.is-top [data-testid=dropoff]');
    await page.locator('#toast.show').waitFor();
    assert.match(await page.textContent('#toast'), /scroll away at 0:0/);
    const drop = await page.evaluate(() => window.__swipe.top.dropOffSec);
    assert.ok(drop >= 1.2);
    await page.click('[data-testid=bad]');
    await page.locator('#sheet.open').waitFor();
    assert.equal(await page.getAttribute('#sheet', 'data-tone'), 'bad');
    assert.equal(await page.locator('#sheet .chip').count(), 6);
    assert.equal(await page.locator('#sheet .chip').first().textContent(), '1Slow or boring start');
    // reasons required (aria-disabled buttons still take taps and explain why)
    await page.waitForTimeout(400);
    await page.click('[data-testid=submit]', { force: true });
    await page.locator('#sheet .form-error').waitFor();
    assert.ok(await page.locator('#sheet.open').isVisible(), 'sheet stays open');
    await page.click('[data-testid=skip-idea]', { force: true });
    assert.ok(await page.locator('#sheet.open').isVisible(), 'skip idea also needs a reason');
    assert.equal(await H.getDoc(`ratings/${uid}__t1`), null, 'nothing saved without a reason');
    // Other with text satisfies it
    await page.locator('#sheet .chip[data-reason=other]').click();
    await page.fill('[data-testid=other]', 'Music too loud');
    await page.fill('#idea-input', 'Start with the punchline');
    await page.click('[data-testid=submit]');
    await synced(page);
    const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`), { what: 'rating doc' });
    assert.equal(r.verdict, 'bad');
    assert.deepEqual(r.reasons, []);
    assert.equal(r.other, 'Music too loud');
    assert.equal(r.idea, 'Start with the punchline');
    assert.equal(r.ideaVia, 'text');
    assert.equal(r.dropOffSec, drop);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('sheet back returns the card; skip idea drops typed idea', async () => {
    const { context, page, errors } = await newPage();
    const uid = await H.onboard(page, { nick: 'Backer' });
    await page.click('[data-testid=good]');
    await page.locator('#sheet.open').waitFor();
    await page.click('[data-testid=sheet-back]');
    await page.locator('#sheet').waitFor({ state: 'hidden' });
    await page.waitForTimeout(600);
    assert.equal(await topId(page), 't1');
    assert.equal(await page.locator('.card.is-top').evaluate((e) => e.style.transform), '');
    assert.equal(await page.locator('.card.is-top video').evaluate((v) => v.paused), false, 'resumes');
    await page.click('[data-testid=good]');
    await page.locator('#sheet.open').waitFor();
    await page.locator('#sheet .chip').nth(4).click();
    await page.fill('#idea-input', 'will be skipped');
    await page.click('[data-testid=skip-idea]');
    await synced(page);
    const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`));
    assert.deepEqual(r.reasons, ['share']);
    assert.equal(r.idea, '');
    assert.equal(r.ideaVia, null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('voice idea: live interim text, ideaVia mixed; denial shows a friendly note', async () => {
    const { context, page, errors } = await newPage();
    await context.addInitScript(() => {
      class FakeRec {
        constructor() { window.__rec = this; }
        start() {
          setTimeout(() => {
            if (window.__deny) { this.onerror?.({ error: 'not-allowed' }); this.onend?.(); return; }
            const res = (t, f) => Object.assign([{ transcript: t }], { isFinal: f });
            this.onresult?.({ resultIndex: 0, results: [res('more plot', false)] });
            setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res('more plot twists', true)] }), 150);
          }, 50);
        }
        stop() { setTimeout(() => this.onend?.(), 10); }
        abort() { this.onend?.(); }
      }
      window.webkitSpeechRecognition = FakeRec;
      window.SpeechRecognition = FakeRec;
    });
    const uid = await H.onboard(page, { nick: 'Talker' });
    await page.click('[data-testid=good]');
    await page.locator('#sheet .chip').first().click();
    await page.fill('#idea-input', 'Shorter intro.');
    await page.click('[data-testid=mic]');
    await page.waitForFunction(() => document.querySelector('#idea-input').value.includes('more plot'));
    assert.equal(await page.getAttribute('[data-testid=mic]', 'aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelector('#idea-input').value === 'Shorter intro. more plot twists');
    await page.screenshot({ path: `${SHOTS}sheet-voice-390.png` });
    await page.click('[data-testid=mic]');
    await page.click('[data-testid=submit]');
    await synced(page);
    const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`));
    assert.equal(r.idea, 'Shorter intro. more plot twists');
    assert.equal(r.ideaVia, 'mixed');
    // permission denied
    await page.evaluate(() => { window.__deny = true; });
    await page.click('[data-testid=good]');
    await page.click('[data-testid=mic]');
    await page.locator('.field-note.warn').waitFor();
    assert.match(await page.textContent('.field-note.warn'), /blocked/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('mic is hidden when speech recognition is unsupported', async () => {
    const { context, page, errors } = await newPage();
    await context.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
    await H.onboard(page, { nick: 'NoMic' });
    await page.click('[data-testid=bad]');
    await page.locator('#sheet.open').waitFor();
    assert.equal(await page.locator('[data-testid=mic]').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('undo deletes the doc and returns the card; skip moves to the end without a doc', async () => {
    const { context, page, errors } = await newPage();
    const uid = await H.onboard(page, { nick: 'Undoer' });
    assert.equal(await page.locator('[data-testid=undo]').isDisabled(), true);
    await rate(page, 'good');
    await synced(page);
    await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`));
    assert.equal(await progress(page), '1 of 5 rated');
    await page.click('[data-testid=undo]');
    await page.waitForTimeout(100);
    assert.equal(await topId(page), 't1');
    assert.equal(await page.locator('.card.is-next').getAttribute('data-video-id'), 't3');
    assert.equal(await progress(page), '0 of 5 rated');
    await synced(page);
    await H.waitFor(async () => (await H.getDoc(`ratings/${uid}__t1`)) === null, { what: 'doc deleted' });
    // Skip: t1 goes to end
    await page.click('[data-testid=skip]');
    await page.waitForFunction(() => document.querySelector('.card.is-top')?.dataset.videoId === 't3');
    assert.deepEqual(await page.evaluate(() => window.__swipe.queue), ['t3', 't2', 't4', 't5', 't1']);
    // Skipping series ep1 moves ep2 with it, in order
    await page.click('[data-testid=skip]');
    await page.waitForFunction(() => document.querySelector('.card.is-top')?.dataset.videoId === 't4');
    assert.deepEqual(await page.evaluate(() => window.__swipe.queue), ['t4', 't5', 't1', 't3', 't2']);
    assert.equal(await progress(page), '0 of 5 rated');
    assert.equal((await H.listDocs('ratings')).filter((d) => d.uid === uid).length, 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('offline swipes sync when back online; survive a reload; celebration when done', async () => {
    const { context, page, errors } = await newPage({}, {
      ignore: [/ERR_INTERNET_DISCONNECTED/, /net::ERR_/, /Failed to load resource/],
    });
    const uid = await H.onboard(page, { nick: 'Offline' });
    await synced(page);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await rate(page, 'good', { idea: 'offline idea' });
    await rate(page, 'bad', { reasons: [1, 2] });
    await page.locator('#sync[data-state=offline]').waitFor();
    assert.match(await page.textContent('#sync'), /Offline · 2/);
    await page.screenshot({ path: `${SHOTS}offline-390.png` });
    await page.waitForTimeout(800);
    assert.equal(await H.getDoc(`ratings/${uid}__t1`), null, 'not on server yet');
    await context.setOffline(false);
    await synced(page);
    const r1 = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`), { what: 'offline rating t1 synced' });
    const r2 = await H.waitFor(() => H.getDoc(`ratings/${uid}__t3`), { what: 'offline rating t3 synced' });
    assert.equal(r1.idea, 'offline idea');
    assert.deepEqual(r2.reasons, ['confusing', 'cheap']);
    // reload: no onboarding, progress kept, rated videos gone
    await page.reload();
    await page.locator('.card.is-top').waitFor();
    assert.ok(!(await page.locator('#welcome').isVisible()));
    assert.equal(await progress(page), '2 of 5 rated');
    assert.equal(await topId(page), 't2');
    // finish the queue
    for (let i = 0; i < 3; i++) await rate(page, i % 2 ? 'bad' : 'good');
    await page.locator('#done').waitFor();
    assert.equal(await page.textContent('[data-testid=done-title]'), 'All 5 rated. Legend.');
    assert.equal(await progress(page), '5 of 5 rated');
    await synced(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}done-390.png` });
    // undo from the done screen brings the card back
    await page.click('[data-testid=undo]');
    await page.locator('.card.is-top').waitFor();
    assert.ok(await page.locator('#done').isHidden());
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('general idea from the menu writes to feedback/', async () => {
    const { context, page, errors } = await newPage();
    const uid = await H.onboard(page, { nick: 'Ideas' });
    await page.click('#menu-btn');
    await page.locator('#menu').waitFor();
    await page.screenshot({ path: `${SHOTS}menu-390.png` });
    await page.click('#menu-idea');
    await page.locator('#sheet.open').waitFor();
    await page.click('[data-testid=feedback-send]');
    await page.locator('#sheet .form-error').waitFor();
    await page.fill('#feedback-input', 'Do a series on credit cards');
    await page.click('[data-testid=feedback-send]');
    await synced(page);
    const fb = await H.waitFor(async () => (await H.listDocs('feedback')).find((d) => d.uid === uid), { what: 'feedback doc' });
    assert.equal(fb.text, 'Do a series on credit cards');
    assert.equal(fb.via, 'text');
    assert.ok(fb.createdAt.ts);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('broken video: retries once with cache-buster then offers Open video', async () => {
    const { context, page, errors } = await newPage({}, { ignore: [/Failed to load resource/, /404/] });
    const hits = [];
    await context.route(/\/tests\/fixtures\/v\/t1\.mp4/, (route) => { hits.push(route.request().url()); route.fulfill({ status: 404, body: 'nope' }); });
    await H.onboard(page, { nick: 'Broken' });
    await page.locator('.card.is-top .card-error').waitFor();
    assert.ok(hits.some((u) => /[?&]cb=\d+/.test(u)), 'retried with cache-buster');
    const href = await page.locator('.card.is-top .card-error a').getAttribute('href');
    assert.match(href, /\/tests\/fixtures\/v\/t1\.mp4$/);
    // still rateable
    await rate(page, 'bad');
    assert.equal(await topId(page), 't3');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('desktop keyboard: arrows, digits, Enter, Escape, space, S, U', async () => {
    const { context, page, errors } = await newPage({ viewport: { width: 1440, height: 900 } });
    const uid = await H.onboard(page, { nick: 'Keys' });
    await page.waitForTimeout(600);
    assert.ok(await page.locator('.kbd-hints').isVisible());
    await page.screenshot({ path: `${SHOTS}desktop-1440.png` });
    const box = await page.locator('.card.is-top').boundingBox();
    assert.ok(Math.abs(box.width / box.height - 9 / 16) < 0.01, 'card is 9:16');
    await page.keyboard.press(' ');
    assert.equal(await page.locator('.card.is-top video').evaluate((v) => v.muted), false, 'space unmutes first');
    await page.keyboard.press(' ');
    assert.equal(await page.locator('.card.is-top video').evaluate((v) => v.paused), true);
    await page.keyboard.press('ArrowLeft');
    await page.locator('#sheet.open').waitFor();
    assert.equal(await page.getAttribute('#sheet', 'data-tone'), 'bad');
    await page.keyboard.press('Escape');
    await page.locator('#sheet').waitFor({ state: 'hidden' });
    assert.equal(await topId(page), 't1');
    await page.keyboard.press('ArrowRight');
    await page.locator('#sheet.open').waitFor();
    await page.keyboard.press('2');
    await page.keyboard.press('5');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}desktop-sheet-1440.png` });
    await page.keyboard.press('Enter');
    await page.locator('#sheet').waitFor({ state: 'hidden' });
    await synced(page);
    const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`));
    assert.deepEqual(r.reasons, ['story', 'share']);
    assert.equal(await topId(page), 't3');
    await page.keyboard.press('s');
    await page.waitForFunction(() => document.querySelector('.card.is-top')?.dataset.videoId === 't4');
    await page.keyboard.press('u');
    await page.waitForFunction(() => document.querySelector('.card.is-top')?.dataset.videoId === 't1');
    await synced(page);
    await H.waitFor(async () => (await H.getDoc(`ratings/${uid}__t1`)) === null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  for (const name of ['iPhone 13', 'Pixel 7']) {
    test(`${name} emulation: touch swipe, tap to play, layout fits`, async () => {
      const { defaultBrowserType, ...device } = devices[name];
      const { context, page, errors } = await newPage({ ...device, deviceScaleFactor: 1 });
      const uid = await H.onboard(page, { nick: name.split(' ')[0] });
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      assert.ok(await noHorizontalScroll(page));
      const vp = page.viewportSize();
      const card = await page.locator('.card.is-top').boundingBox();
      const ctl = await page.locator('.controls').boundingBox();
      const head = await page.locator('.topbar').boundingBox();
      const drop = await page.locator('.card.is-top [data-testid=dropoff]').boundingBox();
      const bar = await page.locator('.card.is-top .card-progress').boundingBox();
      assert.ok(drop.y + drop.height <= ctl.y + 1, 'scroll-away button clear of the controls');
      assert.ok(ctl.y + ctl.height <= vp.height + 1, 'controls on screen');
      assert.ok(card.width >= vp.width * 0.85, 'card near full-bleed');
      assert.ok(card.y >= head.y + head.height - 1, 'header never covers the video');
      await page.tap('.card.is-top', { position: { x: 120, y: 200 } });
      assert.equal(await page.locator('.card.is-top video').evaluate((v) => v.muted), false);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${SHOTS}${slug}-feed.png` });
      await touchDrag(context, page, -(vp.width * 0.6));
      await page.locator('#sheet.open').waitFor();
      assert.equal(await page.getAttribute('#sheet', 'data-tone'), 'bad');
      await page.waitForTimeout(400);
      await page.locator('#sheet .chip').nth(3).tap();
      await page.screenshot({ path: `${SHOTS}${slug}-sheet.png` });
      assert.ok(await noHorizontalScroll(page));
      await page.locator('[data-testid=submit]').tap();
      await synced(page);
      const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__t1`));
      assert.equal(r.verdict, 'bad');
      assert.deepEqual(r.reasons, ['audio']);
      assert.equal(r.client.vw, vp.width);
      assert.ok(r.client.ua.length <= 300);
      // touch swipe right
      await page.waitForTimeout(400);
      await touchDrag(context, page, vp.width * 0.6);
      await page.locator('#sheet.open').waitFor();
      assert.equal(await page.getAttribute('#sheet', 'data-tone'), 'good');
      assert.deepEqual(errors, []);
      await context.close();
    });
  }

  test('320px wide: no horizontal scroll on welcome, feed and sheet', async () => {
    const { context, page, errors } = await newPage({ viewport: { width: 320, height: 568 } });
    await page.goto(await H.appUrl(`&invite=${H.INVITE}`));
    await page.locator('#welcome').waitFor();
    assert.ok(await noHorizontalScroll(page), 'welcome');
    await page.screenshot({ path: `${SHOTS}welcome-320.png` });
    await page.fill('#nick', 'Tiny');
    await page.click('#welcome-go');
    await page.locator('.card.is-top').waitFor();
    await page.waitForTimeout(600);
    assert.ok(await noHorizontalScroll(page), 'feed');
    await page.screenshot({ path: `${SHOTS}feed-320.png` });
    await page.click('[data-testid=good]');
    await page.locator('#sheet.open').waitFor();
    await page.waitForTimeout(400);
    assert.ok(await noHorizontalScroll(page), 'sheet');
    await page.screenshot({ path: `${SHOTS}sheet-320.png` });
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('reduced motion: swipes still work without rotation', async () => {
    const { context, page, errors } = await newPage({ reducedMotion: 'reduce' });
    await H.onboard(page, { nick: 'Calm' });
    const box = await page.locator('.card.is-top').boundingBox();
    await page.mouse.move(box.x + 150, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 300, { steps: 4 });
    assert.match(await page.locator('.card.is-top').evaluate((e) => e.style.transform), /rotate\(0deg\)/);
    await page.mouse.move(box.x + 400, box.y + 300, { steps: 4 });
    await page.mouse.up();
    await page.locator('#sheet.open').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('join form: rejects nicknames with < > and malformed invite codes before signing in', async () => {
    const { context, page, errors } = await newPage();
    await page.goto(await H.appUrl());
    await page.fill('#nick', '<b>Bob');
    await page.fill('#invite', H.INVITE);
    await page.click('#welcome-go');
    await page.locator('#welcome-error').waitFor();
    assert.match(await page.textContent('#welcome-error'), /< or >/);
    await page.fill('#nick', 'Bob');
    await page.fill('#invite', 'bad code!');
    await page.click('#welcome-go');
    assert.match(await page.textContent('#welcome-error'), /4 to 40 letters/);
    assert.equal(await H.uidOf(page), null);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('real app/videos.json (when present): first card plays, count matches, rating saves', async (t) => {
    const fs = await import('node:fs');
    const file = new URL('../../app/videos.json', import.meta.url);
    if (!fs.existsSync(file)) { t.skip('app/videos.json not built yet'); return; }
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { defaultBrowserType, ...device } = devices['iPhone 13'];
    const { context, page, errors } = await newPage({ ...device, deviceScaleFactor: 1 });
    const url = (await H.appUrl(`&invite=${H.INVITE}`)).replace('/tests/fixtures/videos.json', '/app/videos.json');
    await page.goto(url);
    await page.fill('#nick', 'RealDeal');
    await page.click('#welcome-go');
    await page.locator('.card.is-top').waitFor();
    const uid = await H.uidOf(page);
    assert.equal(await progress(page), `0 of ${manifest.videos.length} rated`);
    await page.tap('.card.is-top', { position: { x: 120, y: 200 } });
    await page.waitForFunction(() => document.querySelector('.card.is-top video').currentTime > 2, null, { timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}real-iphone-13-feed.png` });
    const id = await topId(page);
    await rate(page, 'good', { reasons: [0, 1] });
    await synced(page);
    const r = await H.waitFor(() => H.getDoc(`ratings/${uid}__${id}`));
    const dur = manifest.videos.find((v) => v.id === id).dur;
    assert.ok(Math.abs(r.durationSec - dur) < 1.5, `durationSec ${r.durationSec} vs manifest ${dur}`);
    assert.equal(await progress(page), `1 of ${manifest.videos.length} rated`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('WebKit (if installed)', async (t) => {
    let wk;
    try { wk = await webkit.launch(); } catch {
      t.skip('Playwright WebKit is not installed in this environment');
      return;
    }
    await wk.close();
  });
});
