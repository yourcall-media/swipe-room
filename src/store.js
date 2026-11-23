// Data layer used by the app. Production: Firestore + Auth (below).
// The demo build swaps this module for src/store-demo.js (see build.mjs), so no
// Firebase code ends up in the demo bundle. Both expose the same interface.
import {
  doc, getDoc, getDocFromCache, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  onSnapshot, serverTimestamp, waitForPendingWrites,
} from 'firebase/firestore';
import { db, authReady as fbAuthReady, ensureSignedIn as fbSignIn } from './firebase.js';

export const DEMO = false;

/** Resolves with { uid } of the persisted user, or null. */
export async function authReady() {
  const u = await fbAuthReady();
  return u ? { uid: u.uid } : null;
}
export async function ensureSignedIn() {
  const u = await fbSignIn();
  return { uid: u.uid };
}

/** Rater doc data or null (falls back to the offline cache). */
export async function getRater(uid) {
  const ref = doc(db, 'raters', uid);
  const snap = await getDoc(ref).catch(() => getDocFromCache(ref).catch(() => null));
  return snap?.exists() ? snap.data() : null;
}

/** Invite doc data or null. */
export async function getInvite(code) {
  const snap = await getDoc(doc(db, 'invites', code)).catch(() => null);
  return snap?.exists() ? snap.data() : null;
}

export function createRater(uid, { nickname, inviteCode }) {
  return setDoc(doc(db, 'raters', uid), {
    nickname, inviteCode, createdAt: serverTimestamp(), lastSeenAt: serverTimestamp(),
  });
}

export function touchRater(uid) {
  return updateDoc(doc(db, 'raters', uid), { lastSeenAt: serverTimestamp() });
}

export function watchRater(uid, cb) {
  return onSnapshot(doc(db, 'raters', uid), (snap) => { if (snap.exists()) cb(snap.data()); }, () => {});
}

/** cb(list of { videoId, pending }) on every change, local writes included. */
export function watchRatings(uid, cb, onError) {
  const q = query(collection(db, 'ratings'), where('uid', '==', uid));
  return onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ videoId: d.data().videoId, pending: d.metadata.hasPendingWrites }));
    cb(list);
  }, onError);
}

export const pendingWrites = () => waitForPendingWrites(db);

/** Resolves when the server accepted it (stays pending while offline). */
export function saveRating(uid, videoId, rating) {
  return setDoc(doc(db, 'ratings', `${uid}__${videoId}`), {
    ...rating, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export function deleteRating(uid, videoId) {
  return deleteDoc(doc(db, 'ratings', `${uid}__${videoId}`));
}

export function addFeedback(uid, { text, via }) {
  return addDoc(collection(db, 'feedback'), { uid, text, via, createdAt: serverTimestamp() });
}
