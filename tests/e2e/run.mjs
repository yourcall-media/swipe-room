// Build the app, then run the e2e suite against dedicated emulators (ports 28080 / 29099)
// loaded with the real /firestore.rules (copied into tests/e2e/.emu/ each run).
//   node tests/e2e/run.mjs            -> start emulators, run suite, stop
//   E2E_REUSE=1 node tests/e2e/run.mjs -> reuse emulators already running on those ports
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
execSync('node build.mjs', { stdio: 'inherit' });
execSync('node build.mjs --demo', { stdio: 'inherit' });

const emu = path.join(root, 'tests', 'e2e', '.emu');
fs.mkdirSync(emu, { recursive: true });
fs.copyFileSync(path.join(root, 'firestore.rules'), path.join(emu, 'firestore.rules'));
fs.writeFileSync(path.join(emu, 'firebase.json'), JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  emulators: {
    auth: { host: '127.0.0.1', port: 29099 },
    firestore: { host: '127.0.0.1', port: 28080 },
    hub: { host: '127.0.0.1', port: 24400 },
    logging: { host: '127.0.0.1', port: 24500 },
    ui: { enabled: false },
    singleProjectMode: true,
  },
}, null, 2));

const args = process.argv.slice(2).join(' ');
const testCmd = `node --test --test-concurrency=1 --test-reporter=spec ${args} tests/e2e/rater.test.mjs tests/e2e/demo.test.mjs`;
const cmd = process.env.E2E_REUSE
  ? testCmd
  : `npx firebase emulators:exec --config tests/e2e/.emu/firebase.json --project demo-swipe-room --only firestore,auth "${testCmd}"`;
const res = spawnSync(cmd, { stdio: 'inherit', shell: true });
process.exit(res.status ?? 1);
