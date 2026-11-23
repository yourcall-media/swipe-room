import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  connectAuthEmulator, onAuthStateChanged, signInAnonymously,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  connectFirestoreEmulator, setLogLevel,
} from 'firebase/firestore';
import { firebaseConfig, USE_EMULATOR, EMULATOR_HOST, EMULATOR_PORTS } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);

export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
});

let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch {
  // IndexedDB unavailable (e.g. some private modes): fall back to memory cache.
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
}
export { db };

// Offline is expected on phones; keep the console clean of SDK chatter.
setLogLevel('silent');

if (USE_EMULATOR) {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore);
}

/** Resolves with the current user once auth state is known (null when signed out). */
export function authReady() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });
}

export async function ensureSignedIn() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}
