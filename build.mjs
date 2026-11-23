// Build the rater app.
//   node build.mjs           -> app/dist/app.js (production, Firebase)
//   node build.mjs --watch   -> same, rebuilding on change
//   node build.mjs --demo    -> demo/ : self-contained demo (localStorage store, no Firebase,
//                               first DEMO_COUNT videos of app/videos.json, relative URLs only)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const demo = process.argv.includes('--demo');
const DEMO_COUNT = 8;

const base = {
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2020', 'safari15', 'chrome96', 'firefox96'],
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
};

/** Swap the Firestore data layer for the localStorage one. */
const demoStore = {
  name: 'demo-store',
  setup(build) {
    build.onResolve({ filter: /^\.\/store\.js$/ }, () => ({ path: path.join(root, 'src/store-demo.js') }));
    build.onResolve({ filter: /^firebase(\/|$)|^\.\/firebase\.js$/ }, (a) => ({ errors: [{ text: `Firebase import in demo build: ${a.path}` }] }));
  },
};

async function buildDemo() {
  const out = path.join(root, 'demo');
  fs.rmSync(out, { recursive: true, force: true });
  for (const d of ['dist', 'css', 'v', 'p']) fs.mkdirSync(path.join(out, d), { recursive: true });

  await esbuild.build({ ...base, plugins: [demoStore], outfile: path.join(out, 'dist/demo.js'), sourcemap: false });
  const bundle = fs.readFileSync(path.join(out, 'dist/demo.js'), 'utf8');
  if (/firestore|googleapis\.com\/identitytoolkit|firebaseapp/i.test(bundle)) throw new Error('Firebase code leaked into the demo bundle');

  fs.copyFileSync(path.join(root, 'app/css/app.css'), path.join(out, 'css/app.css'));
  fs.writeFileSync(path.join(out, 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#C8FF2E"/><path d="M9.5 9.5l6.5 8 6.5-8M16 17.5V24" fill="none" stroke="#0A0E17" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');

  let html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  html = html
    .replace('src="dist/app.js"', 'src="dist/demo.js"')
    .replace(/<link rel="icon" href="data:[^"]*">/, '<link rel="icon" href="icon.svg" type="image/svg+xml">')
    .replace('<title>Swipe Room · Your Call</title>', '<title>Swipe Room · Your Call (demo)</title>');
  if (!html.includes('dist/demo.js') || html.includes('data:image')) throw new Error('demo html rewrite failed');
  fs.writeFileSync(path.join(out, 'index.html'), html);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app/videos.json'), 'utf8'));
  const videos = manifest.videos.slice(0, DEMO_COUNT);
  for (const v of videos) {
    fs.copyFileSync(path.join(root, 'app', v.v), path.join(out, v.v));
    if (v.p) fs.copyFileSync(path.join(root, 'app', v.p), path.join(out, v.p));
  }
  const usedCats = new Set(videos.map((v) => v.cat));
  fs.writeFileSync(path.join(out, 'videos.json'), JSON.stringify({
    ...manifest, version: `${manifest.version}-demo`, cats: (manifest.cats || []).filter(([k]) => usedCats.has(k)), videos,
  }, null, 2));

  let bytes = 0;
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } };
  walk(out);
  console.log(`demo/ built: ${videos.length} videos, ${(bytes / 1048576).toFixed(1)} MB`);
}

if (demo) {
  await buildDemo();
} else if (watch) {
  const ctx = await esbuild.context({ ...base, sourcemap: true, outfile: path.join(root, 'app/dist/app.js') });
  await ctx.watch();
} else {
  await esbuild.build({ ...base, sourcemap: true, outfile: path.join(root, 'app/dist/app.js') });
}
