// E2E tests for the self-contained demo build (demo/), served under a strict CSP.
// No emulators needed: the demo stores everything in localStorage.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as H from './helpers.mjs';
import { startServer } from './serve.mjs';

const { chromium, devices } = H.pw;
const SHOTS = new URL('../shots/', import.meta.url).pathname;
const DEMO_DIR = new URL('../../demo/', import.meta.url);
let browser;
let server;
let port;

const demoState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('swipe.demo.v1') || 'null'));
const progress = (page) => page.locator('[data-testid=progress]').textContent();
const topId = (page) => page.locator('.card.is-top').getAttribute('data-video-id');

async function newPage(opts = {}, ignore = []) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ...opts });
  await H.stubFonts(context);
  const page = await context.newPage();
  const errors = H.watchConsole(page, { ignore });
  const foreign = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) && u.protocol.startsWith('http')) foreign.push(r.url());
  });
  return { context, page, errors, foreign };
}

describe('Swipe Room demo build', { concurrency: 1 }, () => {
  before(async () => {
    assert.ok(fs.existsSync(new URL('index.html', DEMO_DIR)), 'run `npm run build:demo` first');
    server = await startServer(0);
    port = server.address().port;
    // Local Network Access checks would block the localhost -> 127.0.0.1 frame used to get a cross-origin iframe.
    browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });
  });
  after(async () => {
    await browser?.close();
    await new Promise((r) => server.close(r));
  });

  test('bundle and files: no Firebase, relative URLs only, 8 videos, under 30 MB', () => {
    const js = fs.readFileSync(new URL('dist/demo.js', DEMO_DIR), 'utf8');
    assert.doesNotMatch(js, /firestore|firebaseapp|identitytoolkit|gstatic/i);
    const html = fs.readFileSync(new URL('index.html', DEMO_DIR), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(!m[1].startsWith('/') && (!/^https?:/.test(m[1]) || /fonts\.(googleapis|gstatic)\.com/.test(m[1])), `relative URL: ${m[1]}`);
    }
    const manifest = JSON.parse(fs.readFileSync(new URL('videos.json', DEMO_DIR), 'utf8'));
    assert.equal(manifest.videos.length, 8);
    for (const v of manifest.videos) {
      assert.ok(fs.existsSync(new URL(v.v, DEMO_DIR)), v.v);
      assert.ok(fs.existsSync(new URL(v.p, DEMO_DIR)), v.p);
    }
    let bytes = 0;
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = new URL(f.name + (f.isDirectory() ? '/' : ''), d); if (f.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } };
    walk(DEMO_DIR);
    assert.ok(bytes < 30 * 1048576, `demo is ${(bytes / 1048576).toFixed(1)} MB`);
  });

  test('onboard, drag-swipe, reasons + idea saved to localStorage, reload keeps progress', async () => {
    const { defaultBrowserType, ...device } = devices['iPhone 13'];
    const { context, page, errors, foreign } = await newPage({ ...device, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/demo/`);
    await page.locator('#welcome').waitFor();
    assert.equal(await page.inputValue('#invite'), 'DEMO', 'invite prefilled in demo');
    assert.ok(await page.locator('#welcome .demo-note').isVisible());
    await page.fill('#nick', 'Owner');
    await page.click('#welcome-go');
    await page.locator('.card.is-top').waitFor();
    assert.ok(await page.locator('.demo-tag').isVisible());
    assert.equal(await progress(page), '0 of 8 rated');
    await page.tap('.card.is-top', { position: { x: 120, y: 200 } });
    await page.waitForFunction(() => document.querySelector('.card.is-top video').currentTime > 1.5, null, { timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}demo-iphone-13-feed.png` });
    const first = await topId(page);
    // touch drag right
    const cdp = await context.newCDPSession(page);
    const box = await page.locator('.card.is-top').boundingBox();
    const x = box.x + box.width / 2; const y = box.y + box.height * 0.4;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 25 * i, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#sheet.open').waitFor();
    assert.equal(await page.getAttribute('#sheet', 'data-tone'), 'good');
    await page.locator('#sheet .chip[data-reason=hook]').tap();
    await page.locator('#sheet .chip[data-reason=visuals]').tap();
    await page.fill('#idea-input', 'Show the final number first');
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}demo-iphone-13-sheet.png` });
    await page.locator('[data-testid=submit]').tap();
    await page.locator('#sheet').waitFor({ state: 'hidden' });
    assert.equal(await progress(page), '1 of 8 rated');
    assert.equal(await page.textContent('#sync-text'), 'Saved');
    const st = await demoState(page);
    const uid = st.user.uid;
    assert.equal(st.raters[uid].nickname, 'Owner');
    const r = st.ratings[`${uid}__${first}`];
    assert.equal(r.verdict, 'good');
    assert.deepEqual(r.reasons, ['hook', 'visuals']);
    assert.equal(r.idea, 'Show the final number first');
    assert.equal(r.ideaVia, 'text');
    assert.ok(r.watchedSec >= 1.5 && r.durationSec > 10 && r.swipedEarly === true);
    // reload: straight back to the feed, rated video gone
    await page.reload();
    await page.locator('.card.is-top').waitFor();
    assert.ok(await page.locator('#welcome').isHidden());
    assert.equal(await progress(page), '1 of 8 rated');
    assert.notEqual(await topId(page), first);
    assert.equal(await page.textContent('#me-name'), 'Owner');
    assert.deepEqual(foreign, [], 'no network outside the demo origin (fonts aside)');
    assert.deepEqual(errors, [], 'no console errors (incl. CSP violations)');
    await context.close();
  });

  test('inside a cross-origin iframe: mic hidden, button swipe, undo, always "Saved" even offline', async () => {
    // Video bytes can't load while the device is offline; that's expected, not an app error.
    const { context, page, errors } = await newPage({}, [/ERR_INTERNET_DISCONNECTED/]);
    // Parent on localhost, demo on 127.0.0.1: a cross-origin frame without allow="microphone".
    await page.route(/\/__frame$/, (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body style="margin:0;background:#000"><iframe src="http://127.0.0.1:${port}/demo/" style="border:0;width:390px;height:844px"></iframe></body>`,
    }));
    await page.goto(`http://localhost:${port}/__frame`);
    const f = page.frameLocator('iframe');
    await f.locator('#welcome').waitFor();
    await f.locator('#nick').fill('Framed');
    await f.locator('#welcome-go').click();
    await f.locator('.card.is-top').waitFor();
    await context.setOffline(true);
    await f.locator('[data-testid=bad]').click();
    await f.locator('#sheet.open').waitFor();
    assert.equal(await f.locator('[data-testid=mic]').count(), 0, 'mic hidden in iframe without mic permission');
    await f.locator('#sheet .chip[data-reason=slow]').click();
    await f.locator('[data-testid=submit]').click();
    await f.locator('#sheet').waitFor({ state: 'hidden' });
    assert.equal(await f.locator('#sync').getAttribute('data-state'), 'ok');
    assert.equal(await f.locator('#sync-text').textContent(), 'Saved');
    const frame = page.frames().find((fr) => fr.url().includes('/demo/'));
    let st = await frame.evaluate(() => JSON.parse(localStorage.getItem('swipe.demo.v1')));
    assert.equal(Object.keys(st.ratings).length, 1);
    assert.equal(Object.values(st.ratings)[0].verdict, 'bad');
    await f.locator('[data-testid=undo]').click();
    await f.locator('[data-testid=progress]').filter({ hasText: '0 of 8 rated' }).waitFor();
    st = await frame.evaluate(() => JSON.parse(localStorage.getItem('swipe.demo.v1')));
    assert.equal(Object.keys(st.ratings).length, 0, 'undo removed it');
    // general idea
    await f.locator('#menu-btn').click();
    await f.locator('#menu-idea').click();
    await f.locator('#feedback-input').fill('More myth-busting');
    await f.locator('[data-testid=feedback-send]').click();
    st = await frame.evaluate(() => JSON.parse(localStorage.getItem('swipe.demo.v1')));
    assert.equal(st.feedback[0].text, 'More myth-busting');
    await context.setOffline(false);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
