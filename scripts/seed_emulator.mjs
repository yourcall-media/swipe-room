#!/usr/bin/env node
// Seeds the local Firebase emulators with demo data for Swipe Room.
//
//   node scripts/seed_emulator.mjs [--no-reset] [--admin-uid <uid>]
//
// Env: FIRESTORE_EMULATOR_HOST (default 127.0.0.1:8080), FIREBASE_AUTH_EMULATOR_HOST (default 127.0.0.1:9099),
//      SEED_PROJECT (default: projectId from src/firebase-config.js).
// Creates: invites, 8 raters with varied trust, ~150 ratings over 20 videos (with ideas),
// feedback, an admin (auth user "owner@yourcall.test" with a Google identity + admins doc),
// and one open review batch with 10 items.
// Refuses to run unless the emulator hosts point at localhost.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.METADATA_SERVER_DETECTION ||= 'none'; // no GCE metadata probing against emulators
const require = createRequire(path.join(root, 'tests', 'rules', 'package.json'));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
for (const h of [process.env.FIRESTORE_EMULATOR_HOST, process.env.FIREBASE_AUTH_EMULATOR_HOST]) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h)) {
    console.error(`Refusing to seed: ${h} is not a local emulator`);
    process.exit(1);
  }
}

const { firebaseConfig } = await import(pathToFileURL(path.join(root, 'src', 'firebase-config.js')).href);
const projectId = process.env.SEED_PROJECT || 'demo-swipe-room';
const ADMIN_UID = opt('--admin-uid', 'owner-demo');
const ADMIN_EMAIL = 'owner@yourcall.test';

// ---------- deterministic PRNG ----------
let seed = 20261123;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sample = (a, n) => [...a].sort(() => rnd() - 0.5).slice(0, n);

// ---------- videos ----------
const manifest = JSON.parse(fs.readFileSync('/mnt/project-files/rating-app/source/manifest.json', 'utf8'));
const VIDEO_IDS = [
  'earnings-01-home-depot', 'earnings-03-disney', 'earnings-06-cisco', 'earnings-08-amazon',
  'news-01-anthropic-ipo', 'news-05-nike-two-more-years', 'preview-04-crowdstrike-preview',
  'recap-06-week-nov16-20', 'recap-08-nvidia-14-days', 'h2h-02-coke-vs-pepsi', 'h2h-05-boeing-vs-airbus',
  'ceo-02-steve-jobs', 'mystery-01-wirecard', 'mystery-03-tulip-mania', 'myth-04-october-curse',
  'whatif-05-tesla-ipo', 'money-02-costco-membership', 'explain-01-compound-interest',
  'explain-27-index-funds', 'dynasty-1-from-shares-to-zero-tax',
];
const byId = Object.fromEntries(manifest.videos.map((v) => [v.id, v]));
const videos = VIDEO_IDS.filter((id) => byId[id]).map((id) => byId[id]);
if (videos.length < VIDEO_IDS.length) console.warn('Some seed video ids are missing from the manifest');

const GOOD = ['hook', 'story', 'learned', 'visuals', 'share'];
const BAD = ['slow', 'confusing', 'cheap', 'audio', 'long'];

const RATERS = [
  { uid: 'rater-maya', nickname: 'Maya', trust: 92, badge: 'gold' },
  { uid: 'rater-jonas', nickname: 'Jonas K', trust: 81, badge: 'gold' },
  { uid: 'rater-priya', nickname: 'Priya', trust: 68, badge: 'silver' },
  { uid: 'rater-leo', nickname: 'Leo', trust: 55, badge: 'silver' },
  { uid: 'rater-sam', nickname: 'Sam the Saver', trust: 50, badge: 'bronze' },
  { uid: 'rater-ines', nickname: 'Inês', trust: 44, badge: 'bronze' },
  { uid: 'rater-tom', nickname: 'Tom', trust: 31, badge: 'bronze' },
  { uid: 'rater-zed', nickname: 'zed', trust: 18, badge: 'bronze' },
];

const IDEAS = [
  'Put the share price move on screen in the first second.',
  'The voice is great but music is too loud under it.',
  'Show a simple chart of revenue vs expectations, it was hard to picture.',
  'End with a question so people comment.',
  'Too many numbers in the middle, pick the two that matter.',
  'Would love a part 2 on this.',
  'Captions are a bit small on my phone.',
  'The hook is strong, keep that style.',
  'Explain the jargon word the first time it appears.',
  'Cut the intro logo, it slows the start.',
  'Compare with last year so I know if it is good or bad.',
  'Faster pacing in the second half.',
];
const OTHER_TXT = ['Thumbnail text unreadable', 'Felt like an ad', 'Loved the ending twist', 'Font changed mid video'];

const now = Date.now();
const ts = (msAgo) => Timestamp.fromMillis(now - msAgo);
const H = 3600e3, D = 24 * H;

async function resetEmulators() {
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST, authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const r1 = await fetch(`http://${fsHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  const r2 = await fetch(`http://${authHost}/emulator/v1/projects/${projectId}/accounts`, { method: 'DELETE' });
  if (!r1.ok || !r2.ok) throw new Error(`Emulator reset failed (${r1.status}/${r2.status}). Are emulators running?`);
}

async function main() {
  const app = initializeApp({ projectId }, 'seed');
  const db = getFirestore(app);
  const auth = getAuth(app);

  if (!flag('--no-reset')) await resetEmulators();

  // ---------- admin (Google identity, so the emulator's fake Google sign-in lists it) ----------
  await auth.importUsers([{
    uid: ADMIN_UID, email: ADMIN_EMAIL, emailVerified: true, displayName: 'Channel Owner',
    providerData: [{ uid: 'emu-owner-yourcall-test', providerId: 'google.com', email: ADMIN_EMAIL, displayName: 'Channel Owner' }],
  }]);
  await db.doc(`admins/${ADMIN_UID}`).set({});

  // ---------- invites ----------
  await db.doc('invites/YOURCALL-FRIENDS').set({ active: true, label: 'Friends & family', createdAt: ts(9 * D) });
  await db.doc('invites/FINTWIT-BETA').set({ active: true, label: 'FinTwit beta group', createdAt: ts(5 * D) });
  await db.doc('invites/PILOT-OCT').set({ active: false, label: 'October pilot (closed)', createdAt: ts(40 * D) });

  // ---------- ratings ----------
  const quality = Object.fromEntries(videos.map((v) => [v.id, 0.2 + rnd() * 0.7]));
  const ratings = [];
  const counts = Object.fromEntries(RATERS.map((r) => [r.uid, 0]));
  for (const r of RATERS) {
    const mine = sample(videos, 18 + Math.floor(rnd() * 3)); // 18-20 videos each => ~150 ratings
    for (const v of mine) {
      // higher-trust raters agree more with the "true" quality; low trust are noisy
      const noise = (1 - r.trust / 100) * 0.5;
      const good = rnd() < quality[v.id] + (rnd() - 0.5) * noise;
      const dur = v.dur;
      const swipedEarly = !good && rnd() < 0.35;
      const finished = !swipedEarly && rnd() < (good ? 0.7 : 0.35);
      const frac = swipedEarly ? 0.08 + rnd() * 0.4 : finished ? 1 : 0.45 + rnd() * 0.5;
      const watchedSec = Math.round(dur * frac * 10) / 10;
      const keys = good ? GOOD : BAD;
      const reasons = sample(keys, 1 + Math.floor(rnd() * 2.4));
      const withOther = rnd() < 0.08;
      if (withOther) reasons.push('other');
      const hasIdea = rnd() < 0.22;
      const created = ts(Math.floor(rnd() * 6 * D));
      ratings.push({
        id: `${r.uid}__${v.id}`,
        data: {
          uid: r.uid, videoId: v.id, verdict: good ? 'good' : 'bad', reasons,
          other: withOther ? pick(OTHER_TXT) : '',
          watchedSec, durationSec: dur, watchedPct: Math.min(1, Math.round((watchedSec / dur) * 100) / 100),
          dropOffSec: finished ? null : watchedSec,
          swipedEarly,
          idea: hasIdea ? pick(IDEAS) : '',
          ideaVia: hasIdea ? pick(['voice', 'text', 'text', 'mixed']) : null,
          createdAt: created, updatedAt: created,
          client: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) seed', vw: 390, vh: 844 },
        },
      });
      counts[r.uid]++;
    }
  }
  for (let i = 0; i < ratings.length; i += 400) {
    const b = db.batch();
    for (const r of ratings.slice(i, i + 400)) b.set(db.doc(`ratings/${r.id}`), r.data);
    await b.commit();
  }

  // ---------- raters ----------
  const lastSeen = [0.2 * H, 3 * H, 20 * H, 1.5 * D, 2 * D, 4 * D, 6 * D, 11 * D];
  for (const [i, r] of RATERS.entries()) {
    await db.doc(`raters/${r.uid}`).set({
      nickname: r.nickname, inviteCode: i < 5 ? 'YOURCALL-FRIENDS' : 'FINTWIT-BETA',
      createdAt: ts(8 * D - i * H), lastSeenAt: ts(lastSeen[i]),
      trust: r.trust, badge: r.badge, ratedCount: counts[r.uid],
    });
  }

  // ---------- feedback (general ideas) ----------
  const FEEDBACK = [
    ['rater-maya', 'A weekly "what to watch next week" episode would be my favourite format.', 'voice'],
    ['rater-jonas', 'Please do a series on how ETFs actually work under the hood.', 'text'],
    ['rater-priya', 'The red/green colours are hard for my colour-blind friend, add arrows too.', 'text'],
    ['rater-leo', 'Shorter titles on the first frame.', 'mixed'],
    ['rater-sam', 'More stories about normal people investing, not only billionaires.', 'voice'],
    ['rater-zed', 'make them all 15 seconds', 'text'],
  ];
  for (const [i, [uid, text, via]] of FEEDBACK.entries()) {
    await db.collection('feedback').add({ uid, text, via, createdAt: ts((i + 1) * 7 * H) });
  }

  // ---------- open review batch ----------
  const sug = (...uids) => uids.map((u) => { const r = RATERS.find((x) => x.uid === u); return { uid: u, nickname: r.nickname, trust: r.trust }; });
  const items = [
    { id: 'itm-hook-price-first', title: 'Show the price move in the first second', summary: 'Several raters swiped away before the move was revealed. Open on the % move and ticker, then explain.', videoIds: ['earnings-01-home-depot', 'earnings-06-cisco', 'news-05-nike-two-more-years'], suggesters: sug('rater-maya', 'rater-jonas', 'rater-leo'), quotes: ['Put the share price move on screen in the first second.', 'I didn\'t know if it went up or down until 20s in.'], impact: 5, effort: 2, score: 8.6, conflicts: null },
    { id: 'itm-music-duck', title: 'Lower background music under voice', summary: 'Music competes with narration on phone speakers. Duck music 6 dB while voice is active.', videoIds: ['recap-06-week-nov16-20', 'h2h-02-coke-vs-pepsi'], suggesters: sug('rater-priya', 'rater-sam'), quotes: ['The voice is great but music is too loud under it.'], impact: 4, effort: 1, score: 7.9, conflicts: null },
    { id: 'itm-revenue-chart', title: 'Add a simple beat/miss chart for earnings', summary: 'Raters want one visual of revenue vs. expectations instead of reading numbers.', videoIds: ['earnings-03-disney', 'earnings-08-amazon'], suggesters: sug('rater-jonas', 'rater-ines'), quotes: ['Show a simple chart of revenue vs expectations, it was hard to picture.'], impact: 4, effort: 3, score: 6.4, conflicts: null },
    { id: 'itm-cut-logo', title: 'Drop the intro logo sting', summary: 'The 1.2s logo before the hook correlates with early swipes on 4 videos.', videoIds: ['mystery-01-wirecard', 'myth-04-october-curse', 'whatif-05-tesla-ipo', 'ceo-02-steve-jobs'], suggesters: sug('rater-maya', 'rater-tom'), quotes: ['Cut the intro logo, it slows the start.'], impact: 4, effort: 1, score: 7.2, conflicts: 'Brand team asked to keep the logo for recognition (Oct 30 note).' },
    { id: 'itm-captions-size', title: 'Bigger captions on mobile', summary: 'Captions read small on 6.1" phones. Increase to 64 px and add a stronger shadow.', videoIds: ['explain-01-compound-interest', 'explain-27-index-funds'], suggesters: sug('rater-leo', 'rater-ines', 'rater-sam'), quotes: ['Captions are a bit small on my phone.'], impact: 3, effort: 1, score: 6.1, conflicts: null },
    { id: 'itm-jargon', title: 'Define jargon on first use', summary: 'Terms like "guidance" and "basis points" lose newer viewers. Add a 1-line on-screen definition.', videoIds: ['preview-04-crowdstrike-preview', 'recap-08-nvidia-14-days'], suggesters: sug('rater-priya'), quotes: ['Explain the jargon word the first time it appears.'], impact: 3, effort: 2, score: 5.2, conflicts: null },
    { id: 'itm-part2-dynasty', title: 'Make a part 2 for the Dynasty series', summary: 'Strong completion and multiple "would watch more" ideas.', videoIds: ['dynasty-1-from-shares-to-zero-tax'], suggesters: sug('rater-maya', 'rater-jonas', 'rater-priya', 'rater-sam'), quotes: ['Would love a part 2 on this.'], impact: 5, effort: 5, score: 5.0, conflicts: null },
    { id: 'itm-15s', title: 'Make every video 15 seconds', summary: 'One low-trust rater wants all videos at 15s. Completion data does not support this.', videoIds: ['h2h-05-boeing-vs-airbus'], suggesters: sug('rater-zed'), quotes: ['make them all 15 seconds'], impact: 2, effort: 4, score: 1.8, conflicts: 'Contradicts 4 raters who asked for more depth on the same video.' },
    { id: 'itm-colorblind', title: 'Arrows alongside red/green', summary: 'Add ▲/▼ glyphs next to coloured numbers for colour-blind viewers.', videoIds: ['earnings-06-cisco', 'news-01-anthropic-ipo', 'money-02-costco-membership'], suggesters: sug('rater-priya'), quotes: ['The red/green colours are hard for my colour-blind friend, add arrows too.'], impact: 3, effort: 1, score: 5.9, conflicts: null },
    { id: 'itm-end-question', title: 'End with a question to drive comments', summary: 'Close each video with a one-line question to the viewer.', videoIds: ['mystery-03-tulip-mania', 'whatif-05-tesla-ipo'], suggesters: sug('rater-leo', 'rater-tom'), quotes: ['End with a question so people comment.'], impact: 3, effort: 1, score: 5.5, conflicts: null },
  ].map((it) => ({ ...it, verdict: null, note: '' }));
  await db.doc('batches/2026-11-23').set({ createdAt: ts(2 * H), status: 'open', items });
  await db.doc('batches/2026-11-16').set({ createdAt: ts(7 * D), status: 'closed', items: [] });

  await deleteApp(app);
  console.log(`Seeded project ${projectId}: ${RATERS.length} raters, ${ratings.length} ratings over ${videos.length} videos, ` +
    `${FEEDBACK.length} feedback, 1 open batch (${items.length} items). Admin uid: ${ADMIN_UID} (${ADMIN_EMAIL}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
