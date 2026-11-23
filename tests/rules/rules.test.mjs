// Firestore security rules tests for Swipe Room.
// Run: cd tests/rules && npm test   (starts the Firestore emulator via firebase emulators:exec)
import { test, describe, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where,
  serverTimestamp, Timestamp, deleteField, writeBatch, setLogLevel,
} from 'firebase/firestore';

setLogLevel('silent'); // denied writes are expected; keep output readable

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.join(here, '..', '..', 'firestore.rules'), 'utf8');
const PROJECT = 'demo-swipe-room';

let env;
const RATER = 'raterA';
const OTHER = 'raterB';
const STRANGER = 'noRaterDoc';
const ADMIN = 'ownerUid';
const VID = 'earnings-01-home-depot';

const asRater = () => env.authenticatedContext(RATER, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const asOther = () => env.authenticatedContext(OTHER, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const asStranger = () => env.authenticatedContext(STRANGER, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const asAdmin = () => env.authenticatedContext(ADMIN, { firebase: { sign_in_provider: 'google.com' } }).firestore();
const asAnon = () => env.unauthenticatedContext().firestore();

const longStr = (n) => 'x'.repeat(n);

function rating(over = {}) {
  return {
    uid: RATER,
    videoId: VID,
    verdict: 'good',
    reasons: ['hook', 'learned'],
    other: '',
    watchedSec: 31.5,
    durationSec: 52,
    watchedPct: 0.61,
    dropOffSec: null,
    swipedEarly: false,
    idea: 'Show the margin chart earlier',
    ideaVia: 'text',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    client: { ua: 'Mozilla/5.0 test', vw: 390, vh: 844 },
    ...over,
  };
}
const ratingRef = (db, uid = RATER, vid = VID) => doc(db, 'ratings', `${uid}__${vid}`);

function joinDoc(over = {}) {
  return {
    nickname: 'Sam',
    inviteCode: 'GOOD-CODE',
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    ...over,
  };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: RULES }, // host/port from FIRESTORE_EMULATOR_HOST (set by emulators:exec)
  });
});
after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();
    await setDoc(doc(db, 'admins', ADMIN), {});
    await setDoc(doc(db, 'invites', 'GOOD-CODE'), { active: true, label: 'Friends', createdAt: now });
    await setDoc(doc(db, 'invites', 'OLD-CODE'), { active: false, label: 'Expired', createdAt: now });
    await setDoc(doc(db, 'raters', RATER), {
      nickname: 'Alice', inviteCode: 'GOOD-CODE', createdAt: now, lastSeenAt: now,
      trust: 50, badge: 'bronze', ratedCount: 0,
    });
    await setDoc(doc(db, 'raters', OTHER), {
      nickname: 'Bob', inviteCode: 'GOOD-CODE', createdAt: now, lastSeenAt: now,
      trust: 70, badge: 'silver', ratedCount: 3,
    });
    await setDoc(doc(db, 'ratings', `${OTHER}__${VID}`), {
      ...rating({ uid: OTHER }), createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, 'feedback', 'fbOther'), { uid: OTHER, text: 'More recaps', via: 'text', createdAt: now });
    await setDoc(doc(db, 'batches', 'b1'), { createdAt: now, status: 'open', items: [] });
    await setDoc(doc(db, 'approved', 'i1'), { id: 'i1', title: 'x' });
    await setDoc(doc(db, 'secrets', 's1'), { v: 1 });
  });
});

// ------------------------------------------------------------------ invites
describe('invites', () => {
  test('signed-in user can get one invite', async () => {
    await assertSucceeds(getDoc(doc(asStranger(), 'invites', 'GOOD-CODE')));
  });
  test('signed-in user can get a missing invite (returns not-exists)', async () => {
    const snap = await assertSucceeds(getDoc(doc(asStranger(), 'invites', 'NOPE-CODE')));
    if (snap.exists()) throw new Error('should not exist');
  });
  test('unauthenticated cannot get invite', async () => {
    await assertFails(getDoc(doc(asAnon(), 'invites', 'GOOD-CODE')));
  });
  test('rater cannot list invites', async () => {
    await assertFails(getDocs(collection(asRater(), 'invites')));
  });
  test('rater cannot list invites with a filter', async () => {
    await assertFails(getDocs(query(collection(asRater(), 'invites'), where('active', '==', true))));
  });
  test('admin can list invites', async () => {
    await assertSucceeds(getDocs(collection(asAdmin(), 'invites')));
  });
  test('rater cannot create, update or delete invites', async () => {
    const db = asRater();
    await assertFails(setDoc(doc(db, 'invites', 'MINE-CODE'), { active: true, label: 'x', createdAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, 'invites', 'OLD-CODE'), { active: true }));
    await assertFails(deleteDoc(doc(db, 'invites', 'GOOD-CODE')));
  });
  test('admin can create, deactivate and delete invites', async () => {
    const db = asAdmin();
    await assertSucceeds(setDoc(doc(db, 'invites', 'NEW-CODE-1'), { active: true, label: 'Group 2', createdAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db, 'invites', 'NEW-CODE-1'), { active: false }));
    await assertSucceeds(deleteDoc(doc(db, 'invites', 'NEW-CODE-1')));
  });
  test('admin invite: bad code, extra field, wrong types, long label are rejected', async () => {
    const db = asAdmin();
    const ok = { active: true, label: 'L', createdAt: serverTimestamp() };
    await assertFails(setDoc(doc(db, 'invites', 'a b'), ok));
    await assertFails(setDoc(doc(db, 'invites', 'abc'), ok));
    await assertFails(setDoc(doc(db, 'invites', 'CODE-XY'), { ...ok, extra: 1 }));
    await assertFails(setDoc(doc(db, 'invites', 'CODE-XY'), { ...ok, active: 'yes' }));
    await assertFails(setDoc(doc(db, 'invites', 'CODE-XY'), { ...ok, label: longStr(81) }));
    await assertFails(setDoc(doc(db, 'invites', 'CODE-XY'), { active: true, label: 'L' }));
  });
});

// ------------------------------------------------------------------ raters
describe('raters', () => {
  test('new user joins with a valid active invite', async () => {
    await assertSucceeds(setDoc(doc(asStranger(), 'raters', STRANGER), joinDoc()));
  });
  test('join is denied for an inactive invite', async () => {
    await assertFails(setDoc(doc(asStranger(), 'raters', STRANGER), joinDoc({ inviteCode: 'OLD-CODE' })));
  });
  test('join is denied for a non-existent invite', async () => {
    await assertFails(setDoc(doc(asStranger(), 'raters', STRANGER), joinDoc({ inviteCode: 'MADE-UP' })));
  });
  test('join is denied for a malformed invite code', async () => {
    await assertFails(setDoc(doc(asStranger(), 'raters', STRANGER), joinDoc({ inviteCode: '../admins' })));
    await assertFails(setDoc(doc(asStranger(), 'raters', STRANGER), joinDoc({ inviteCode: 42 })));
  });
  test('join is denied for a spoofed uid (someone else\'s doc)', async () => {
    await assertFails(setDoc(doc(asStranger(), 'raters', 'victimUid'), joinDoc()));
  });
  test('join is denied when unauthenticated', async () => {
    await assertFails(setDoc(doc(asAnon(), 'raters', STRANGER), joinDoc()));
  });
  test('join is denied with extra fields (trust, badge, ratedCount, junk)', async () => {
    const db = asStranger();
    await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ trust: 100 })));
    await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ badge: 'gold' })));
    await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ ratedCount: 999 })));
    await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ isAdmin: true })));
  });
  test('join is denied with missing fields', async () => {
    const { lastSeenAt, ...rest } = joinDoc();
    await assertFails(setDoc(doc(asStranger(), 'raters', STRANGER), rest));
  });
  test('join is denied with bad nickname (short, long, blank, html, non-string)', async () => {
    const db = asStranger();
    for (const nickname of ['A', longStr(25), '   ', ' a ', '<b>hi</b>', 'tab\tname', 12345]) {
      await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ nickname })));
    }
  });
  test('join accepts unicode nickname of 24 chars', async () => {
    await assertSucceeds(setDoc(doc(asStranger(), 'raters', STRANGER), joinDoc({ nickname: 'Zoë 💸 ' + 'x'.repeat(17) })));
  });
  test('join is denied with client-chosen timestamps', async () => {
    const db = asStranger();
    await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ createdAt: Timestamp.fromMillis(0) })));
    await assertFails(setDoc(doc(db, 'raters', STRANGER), joinDoc({ lastSeenAt: Timestamp.fromMillis(0) })));
  });
  test('rater reads own doc', async () => {
    await assertSucceeds(getDoc(doc(asRater(), 'raters', RATER)));
  });
  test('rater cannot read another rater or list raters', async () => {
    await assertFails(getDoc(doc(asRater(), 'raters', OTHER)));
    await assertFails(getDocs(collection(asRater(), 'raters')));
  });
  test('rater updates own nickname and lastSeenAt', async () => {
    await assertSucceeds(updateDoc(doc(asRater(), 'raters', RATER), { nickname: 'Alicia', lastSeenAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(asRater(), 'raters', RATER), { lastSeenAt: serverTimestamp() }));
  });
  test('rater cannot write own trust / badge / ratedCount / inviteCode', async () => {
    const db = asRater();
    const ref = doc(db, 'raters', RATER);
    await assertFails(updateDoc(ref, { trust: 100, lastSeenAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { badge: 'gold', lastSeenAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { ratedCount: 999, lastSeenAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { inviteCode: 'OTHER', lastSeenAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { trust: deleteField(), lastSeenAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { lastSeenAt: Timestamp.fromMillis(0) }));
    await assertFails(updateDoc(ref, { nickname: 'x', lastSeenAt: serverTimestamp() }));
  });
  test('rater cannot update another rater', async () => {
    await assertFails(updateDoc(doc(asRater(), 'raters', OTHER), { nickname: 'Hacked', lastSeenAt: serverTimestamp() }));
  });
  test('rater cannot delete own doc', async () => {
    await assertFails(deleteDoc(doc(asRater(), 'raters', RATER)));
  });
  test('admin reads and lists raters', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'raters', OTHER)));
    await assertSucceeds(getDocs(collection(asAdmin(), 'raters')));
  });
  test('admin updates trust/badge/ratedCount within bounds', async () => {
    await assertSucceeds(updateDoc(doc(asAdmin(), 'raters', OTHER), { trust: 90, badge: 'gold', ratedCount: 10 }));
  });
  test('admin cannot set invalid trust/badge or other fields', async () => {
    const ref = doc(asAdmin(), 'raters', OTHER);
    await assertFails(updateDoc(ref, { trust: 101 }));
    await assertFails(updateDoc(ref, { trust: -1 }));
    await assertFails(updateDoc(ref, { trust: '50' }));
    await assertFails(updateDoc(ref, { badge: 'platinum' }));
    await assertFails(updateDoc(ref, { inviteCode: 'X' }));
  });
});

// ------------------------------------------------------------------ ratings
describe('ratings', () => {
  test('rater creates a full valid rating', async () => {
    await assertSucceeds(setDoc(ratingRef(asRater()), rating()));
  });
  test('rater creates a minimal valid rating', async () => {
    await assertSucceeds(setDoc(ratingRef(asRater()), {
      uid: RATER, videoId: VID, verdict: 'bad', reasons: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
  });
  test('bad rating with bad reasons + other', async () => {
    await assertSucceeds(setDoc(ratingRef(asRater()), rating({
      verdict: 'bad', reasons: ['slow', 'confusing', 'cheap', 'audio', 'long', 'other'], other: 'mic clipping', dropOffSec: 12.4, swipedEarly: true,
    })));
  });
  test('rater without rater doc cannot rate', async () => {
    await assertFails(setDoc(ratingRef(asStranger(), STRANGER), rating({ uid: STRANGER })));
  });
  test('unauthenticated cannot rate', async () => {
    await assertFails(setDoc(ratingRef(asAnon()), rating()));
  });
  test('spoofed uid field is rejected', async () => {
    await assertFails(setDoc(ratingRef(asRater(), RATER), rating({ uid: OTHER })));
  });
  test('writing into another uid\'s doc id is rejected', async () => {
    await assertFails(setDoc(ratingRef(asRater(), OTHER, 'news-01-anthropic-ipo'), rating({ uid: RATER, videoId: 'news-01-anthropic-ipo' })));
    await assertFails(setDoc(ratingRef(asRater(), OTHER, 'news-01-anthropic-ipo'), rating({ uid: OTHER, videoId: 'news-01-anthropic-ipo' })));
  });
  test('doc id must equal uid__videoId', async () => {
    const db = asRater();
    await assertFails(setDoc(doc(db, 'ratings', 'random-id'), rating()));
    await assertFails(setDoc(doc(db, 'ratings', `${RATER}__news-01-anthropic-ipo`), rating()));
    await assertFails(setDoc(doc(db, 'ratings', `${RATER}_${VID}`), rating()));
  });
  test('invalid video id is rejected', async () => {
    const db = asRater();
    await assertFails(setDoc(doc(db, 'ratings', `${RATER}__Bad_ID`), rating({ videoId: 'Bad_ID' })));
    await assertFails(setDoc(doc(db, 'ratings', `${RATER}__`), rating({ videoId: '' })));
  });
  test('extra fields are rejected', async () => {
    await assertFails(setDoc(ratingRef(asRater()), rating({ trust: 100 })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ score: 1 })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ client: { ua: 'x', vw: 1, vh: 1, ip: '1.2.3.4' } })));
  });
  test('missing required fields are rejected', async () => {
    for (const k of ['uid', 'videoId', 'verdict', 'reasons', 'createdAt', 'updatedAt']) {
      const r = rating(); delete r[k];
      await assertFails(setDoc(ratingRef(asRater()), r));
    }
  });
  test('verdict enum enforced', async () => {
    await assertFails(setDoc(ratingRef(asRater()), rating({ verdict: 'meh' })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ verdict: true })));
  });
  test('reason keys must match verdict side', async () => {
    await assertFails(setDoc(ratingRef(asRater()), rating({ verdict: 'good', reasons: ['slow'] })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ verdict: 'bad', reasons: ['hook'] })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ verdict: 'good', reasons: ['hook', 'nonsense'] })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ reasons: 'hook' })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ reasons: ['hook', 'hook'] })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ reasons: [1] })));
  });
  test('reasons list size <= 6', async () => {
    await assertSucceeds(setDoc(ratingRef(asRater()), rating({ reasons: ['hook', 'story', 'learned', 'visuals', 'share', 'other'] })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ reasons: ['hook', 'story', 'learned', 'visuals', 'share', 'other', 'hook'] })));
  });
  test('oversized text is rejected', async () => {
    await assertSucceeds(setDoc(ratingRef(asRater()), rating({ other: longStr(500), idea: longStr(2000) })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ other: longStr(501) })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ idea: longStr(2001) })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ client: { ua: longStr(301), vw: 1, vh: 1 } })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ other: 5 })));
  });
  test('numbers must be non-negative and bounded', async () => {
    const bad = [
      { watchedSec: -1 }, { watchedSec: 99999 }, { watchedSec: '10' },
      { durationSec: -5 }, { watchedPct: 1.2 }, { watchedPct: -0.1 },
      { dropOffSec: -3 }, { dropOffSec: 'soon' }, { swipedEarly: 'no' },
      { ideaVia: 'telepathy' }, { client: 'ua' }, { client: { vw: -1 } },
    ];
    for (const b of bad) await assertFails(setDoc(ratingRef(asRater()), rating(b)));
  });
  test('timestamps must equal request.time on create', async () => {
    await assertFails(setDoc(ratingRef(asRater()), rating({ createdAt: Timestamp.fromMillis(0) })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ updatedAt: Timestamp.fromMillis(0) })));
    await assertFails(setDoc(ratingRef(asRater()), rating({ createdAt: 'now' })));
  });
  test('rater updates own rating; createdAt kept or reset to now; updatedAt now', async () => {
    const db = asRater();
    await assertSucceeds(setDoc(ratingRef(db), rating()));
    await assertSucceeds(updateDoc(ratingRef(db), { verdict: 'bad', reasons: ['slow'], updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(ratingRef(db), rating({ verdict: 'good', reasons: ['share'] })));
    await assertFails(updateDoc(ratingRef(db), { verdict: 'good', reasons: ['slow'], updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ratingRef(db), { verdict: 'bad', reasons: ['slow'] }));
    await assertFails(updateDoc(ratingRef(db), { createdAt: Timestamp.fromMillis(0), updatedAt: serverTimestamp() }));
  });
  test('rater cannot update another rater\'s rating', async () => {
    await assertFails(updateDoc(ratingRef(asRater(), OTHER), { verdict: 'bad', reasons: [], updatedAt: serverTimestamp() }));
  });
  test('rater reads own rating (also before it exists) and lists own', async () => {
    const db = asRater();
    await assertSucceeds(getDoc(ratingRef(db, RATER, 'news-02-target-q3')));
    await assertSucceeds(setDoc(ratingRef(db), rating()));
    await assertSucceeds(getDoc(ratingRef(db)));
    await assertSucceeds(getDocs(query(collection(db, 'ratings'), where('uid', '==', RATER))));
  });
  test('non-admin cannot read others\' ratings', async () => {
    const db = asRater();
    await assertFails(getDoc(ratingRef(db, OTHER)));
    await assertFails(getDocs(collection(db, 'ratings')));
    await assertFails(getDocs(query(collection(db, 'ratings'), where('uid', '==', OTHER))));
    await assertFails(getDocs(query(collection(db, 'ratings'), where('videoId', '==', VID))));
  });
  test('unauthenticated cannot read ratings', async () => {
    await assertFails(getDoc(ratingRef(asAnon(), OTHER)));
  });
  test('rater deletes own rating (undo) but not others', async () => {
    const db = asRater();
    await assertSucceeds(setDoc(ratingRef(db), rating()));
    await assertSucceeds(deleteDoc(ratingRef(db)));
    await assertFails(deleteDoc(ratingRef(db, OTHER)));
  });
  test('admin reads all ratings and may delete, but cannot forge one', async () => {
    const db = asAdmin();
    await assertSucceeds(getDocs(collection(db, 'ratings')));
    await assertFails(setDoc(ratingRef(db, OTHER, 'news-02-target-q3'), rating({ uid: OTHER, videoId: 'news-02-target-q3' })));
    await assertSucceeds(deleteDoc(ratingRef(db, OTHER)));
  });
});

// ------------------------------------------------------------------ feedback
describe('feedback', () => {
  const fb = (over = {}) => ({ uid: RATER, text: 'Do a series on index funds', via: 'voice', createdAt: serverTimestamp(), ...over });
  test('rater creates own feedback', async () => {
    await assertSucceeds(addDoc(collection(asRater(), 'feedback'), fb()));
    await assertSucceeds(addDoc(collection(asRater(), 'feedback'), fb({ via: null })));
    const { via, ...noVia } = fb();
    await assertSucceeds(addDoc(collection(asRater(), 'feedback'), noVia));
  });
  test('feedback: spoofed uid, no rater doc, unauthenticated are denied', async () => {
    await assertFails(addDoc(collection(asRater(), 'feedback'), fb({ uid: OTHER })));
    await assertFails(addDoc(collection(asStranger(), 'feedback'), fb({ uid: STRANGER })));
    await assertFails(addDoc(collection(asAnon(), 'feedback'), fb()));
  });
  test('feedback: extra fields, oversized/empty text, bad via, fake time denied', async () => {
    const c = collection(asRater(), 'feedback');
    await assertFails(addDoc(c, fb({ extra: 1 })));
    await assertFails(addDoc(c, fb({ text: longStr(2001) })));
    await assertFails(addDoc(c, fb({ text: '   ' })));
    await assertFails(addDoc(c, fb({ via: 'fax' })));
    await assertFails(addDoc(c, fb({ createdAt: Timestamp.fromMillis(0) })));
  });
  test('feedback: read own only, no update, no rater delete', async () => {
    const db = asRater();
    const ref = await addDoc(collection(db, 'feedback'), fb());
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(getDocs(query(collection(db, 'feedback'), where('uid', '==', RATER))));
    await assertFails(getDoc(doc(db, 'feedback', 'fbOther')));
    await assertFails(getDocs(collection(db, 'feedback')));
    await assertFails(updateDoc(ref, { text: 'changed' }));
    await assertFails(deleteDoc(ref));
  });
  test('admin reads all feedback', async () => {
    await assertSucceeds(getDocs(collection(asAdmin(), 'feedback')));
  });
});

// ------------------------------------------------------------------ admins
describe('admins', () => {
  test('admin reads own admin doc; rater gets own (missing) admin doc', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'admins', ADMIN)));
    const s = await assertSucceeds(getDoc(doc(asRater(), 'admins', RATER)));
    if (s.exists()) throw new Error('rater is not admin');
  });
  test('nobody can read others\' admin docs or list admins', async () => {
    await assertFails(getDoc(doc(asRater(), 'admins', ADMIN)));
    await assertFails(getDocs(collection(asRater(), 'admins')));
    await assertFails(getDocs(collection(asAdmin(), 'admins')));
  });
  test('no client can write admins (self-promotion denied, admin too)', async () => {
    await assertFails(setDoc(doc(asRater(), 'admins', RATER), {}));
    await assertFails(setDoc(doc(asAdmin(), 'admins', RATER), {}));
    await assertFails(deleteDoc(doc(asAdmin(), 'admins', ADMIN)));
  });
});

// ------------------------------------------------------------------ batches / approved
describe('batches and approved', () => {
  test('admin reads/writes batches and approved', async () => {
    const db = asAdmin();
    await assertSucceeds(getDoc(doc(db, 'batches', 'b1')));
    await assertSucceeds(getDocs(query(collection(db, 'batches'), where('status', '==', 'open'))));
    await assertSucceeds(updateDoc(doc(db, 'batches', 'b1'), { items: [{ id: 'i1', verdict: 'approve', note: '' }] }));
    await assertSucceeds(setDoc(doc(db, 'approved', 'i2'), { id: 'i2' }));
    const b = writeBatch(db);
    b.update(doc(db, 'batches', 'b1'), { status: 'closed' });
    b.delete(doc(db, 'approved', 'i1'));
    await assertSucceeds(b.commit());
  });
  test('rater cannot read or write batches/approved', async () => {
    const db = asRater();
    await assertFails(getDoc(doc(db, 'batches', 'b1')));
    await assertFails(getDocs(collection(db, 'batches')));
    await assertFails(updateDoc(doc(db, 'batches', 'b1'), { status: 'closed' }));
    await assertFails(getDoc(doc(db, 'approved', 'i1')));
    await assertFails(setDoc(doc(db, 'approved', 'evil'), { id: 'evil' }));
  });
  test('unauthenticated cannot read batches', async () => {
    await assertFails(getDoc(doc(asAnon(), 'batches', 'b1')));
  });
});

// ------------------------------------------------------------------ everything else
describe('unknown collections', () => {
  test('denied for raters and admins', async () => {
    await assertFails(getDoc(doc(asRater(), 'secrets', 's1')));
    await assertFails(setDoc(doc(asRater(), 'secrets', 's2'), { v: 1 }));
    await assertFails(getDoc(doc(asAdmin(), 'secrets', 's1')));
    await assertFails(setDoc(doc(asAdmin(), 'secrets', 's2'), { v: 1 }));
    await assertFails(setDoc(doc(asRater(), 'raters', RATER, 'sub', 'x'), { v: 1 }));
  });
});
