#!/usr/bin/env node
// Bundles the owner dashboard: src/admin/main.js -> app/dist/admin.js (Firebase SDK bundled from npm).
//   node scripts/build_admin.mjs [--watch] [--dev]
// Uses the esbuild/firebase installed in tests/rules/node_modules so it does not depend on the
// rater app's root package.json.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolDir = path.join(root, 'tests', 'rules');
const require = createRequire(path.join(toolDir, 'package.json'));
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

const options = {
  entryPoints: [path.join(root, 'src', 'admin', 'main.js')],
  outfile: path.join(root, 'app', 'dist', 'admin.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020', 'safari15'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  nodePaths: [path.join(toolDir, 'node_modules')],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const res = await esbuild.build({ ...options, metafile: true });
  const out = Object.entries(res.metafile.outputs)[0];
  console.log(`admin bundle: ${(out[1].bytes / 1024).toFixed(0)} KB`);
}
