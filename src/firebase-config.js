// Firebase web config for the "Education" project (public by design; security lives in firestore.rules).
export const firebaseConfig = {
  apiKey: 'AIzaSyDIdIzU9hDuL7gHTWbNwp5svqgD8V93BEE',
  authDomain: 'education-f0af0.firebaseapp.com',
  projectId: 'education-f0af0',
  storageBucket: 'education-f0af0.firebasestorage.app',
  messagingSenderId: '79807278464',
  appId: '1:79807278464:web:d489cc8b45405ee7736565',
};

const host = typeof location !== 'undefined' ? location.hostname : '';
export const USE_EMULATOR = host === 'localhost' || host === '127.0.0.1';
export const EMULATOR_HOST = host === 'localhost' ? 'localhost' : '127.0.0.1';
// Local emulators run under the demo project id the test suites expect.
if (USE_EMULATOR) firebaseConfig.projectId = 'demo-swipe-room';
export const EMULATOR_PORTS = { auth: 9099, firestore: 8080 };

// Local-only: `?emu=<firestorePort>:<authPort>` (remembered) lets the e2e suite use its own emulators.
if (USE_EMULATOR) {
  try {
    const q = new URLSearchParams(location.search).get('emu');
    if (q) localStorage.setItem('swipe.emu', q);
    const m = /^(\d{2,5}):(\d{2,5})$/.exec(q || localStorage.getItem('swipe.emu') || '');
    if (m) { EMULATOR_PORTS.firestore = Number(m[1]); EMULATOR_PORTS.auth = Number(m[2]); }
  } catch { /* storage blocked */ }
}
