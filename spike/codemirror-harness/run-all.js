/**
 * M0a / A2 — driver. Runs each fixture in its own Electron process.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Usage: node run-all.js [fixtureName…]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures');
const OUT = resolve(HERE, 'out');

const ALL = [
  'cars-10mb.xml',
  'cars-50mb.xml',
  'cars-100mb.xml',
  'cars-200mb.xml',
  'cars-500mb.xml',
  'cars-100mb.json',
  'cars-100mb.min.json',
];

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = args.length ? args : ALL;

mkdirSync(OUT, { recursive: true });
const electron = require('electron'); // path to the electron binary

const results = [];

for (const name of selected) {
  const fixturePath = join(FIXTURES, name);
  if (!existsSync(fixturePath)) {
    console.log(`SKIP ${name} — not generated`);
    continue;
  }

  const sizeMB = statSync(fixturePath).size / 1024 / 1024;
  // The plan caps a hang at 60 s. Large fixtures legitimately need longer for
  // the full battery (100 keystrokes x3 + 200 scroll frames), so the cap scales
  // while still bounding a genuine hang.
  const capMs = Math.max(120000, Math.round(sizeMB * 1500));
  const outPath = join(OUT, name + '.json');

  console.log(`\n=== ${name} (${sizeMB.toFixed(0)} MB, cap ${(capMs / 1000).toFixed(0)}s)`);
  const t0 = Date.now();

  // This environment (VS Code extension host) exports ELECTRON_RUN_AS_NODE=1,
  // which makes the electron binary behave as plain Node — `app` comes back
  // undefined and no window is ever created. Must be cleared explicitly.
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
  delete env.ELECTRON_RUN_AS_NODE;

  await new Promise((done) => {
    const child = spawn(
      electron,
      [join(HERE, 'main.cjs'), fixturePath, name, outPath, String(capMs)],
      { stdio: 'inherit', env },
    );
    const kill = setTimeout(() => child.kill('SIGKILL'), capMs + 30000);
    child.on('exit', (code) => {
      clearTimeout(kill);
      done(code);
    });
  });

  const wallSec = ((Date.now() - t0) / 1000).toFixed(0);
  let r;
  if (existsSync(outPath)) {
    r = JSON.parse(readFileSync(outPath, 'utf8'));
  } else {
    r = { fixture: name, ok: false, error: 'process died without reporting' };
  }
  r.wallSec = Number(wallSec);
  results.push(r);

  if (r.ok) {
    console.log(
      `    load ${r.loadMs} ms | mem +${r.memoryDeltaMB} MB | ` +
        `type p95 1%/50%/99% = ${r['keystroke_1%'].p95}/${r['keystroke_50%'].p95}/${r['keystroke_99%'].p95} ms | ` +
        `scroll >32ms ${r.scroll.pctOver32ms}% | replace ${r.fullReplaceMs} ms`,
    );
  } else {
    console.log(`    FAILED: ${r.error}`);
  }
}

writeFileSync(join(OUT, 'all.json'), JSON.stringify(results, null, 2));
console.log(`\nWrote ${join(OUT, 'all.json')}`);
