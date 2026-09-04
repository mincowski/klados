/**
 * M0a / A6 — driver. Runs each fixture (all three window sizes) in its own
 * Electron process.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Usage: node run-all-windowed.js [fixtureName…]
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

const ALL = ['cars-200mb.xml', 'cars-500mb.xml', 'cars-100mb.min.json'];

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = args.length ? args : ALL;

mkdirSync(OUT, { recursive: true });
const electron = require('electron');

// This environment (VS Code extension host) exports ELECTRON_RUN_AS_NODE=1,
// which makes the electron binary behave as plain Node. Must be cleared.
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];

for (const name of selected) {
  const fixturePath = join(FIXTURES, name);
  if (!existsSync(fixturePath)) {
    console.log(`SKIP ${name} — not generated`);
    continue;
  }

  const sizeMB = statSync(fixturePath).size / 1024 / 1024;
  // Three window sizes, each running the full battery (round-trip, open,
  // 300 keystrokes, 200 scroll frames, 100 reslices, 20 boundary crossings),
  // so this needs considerably more headroom than the A2 cap.
  const capMs = Math.max(180000, Math.round(sizeMB * 2500));
  const outPath = join(OUT, 'windowed-' + name + '.json');

  console.log(`\n=== ${name} (${sizeMB.toFixed(0)} MB, cap ${(capMs / 1000).toFixed(0)}s)`);
  const t0 = Date.now();

  await new Promise((done) => {
    const child = spawn(
      electron,
      [join(HERE, 'main-windowed.cjs'), fixturePath, name, outPath, String(capMs)],
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
    for (const [label, w] of Object.entries(r.windows || {})) {
      if (!w.ok) {
        console.log(`    [${label}] FAILED: ${w.error}`);
        continue;
      }
      const bc = w.boundaryCrossing;
      const bcSummary = bc.skipped
        ? `crossing SKIPPED (${bc.reason})`
        : `crossing p95 ${bc.frameStats?.p95}ms max ${bc.frameStats?.max}ms | drift top/caret ${bc.maxAbsTopDrift}/${bc.maxAbsCaretDrift}B`;
      console.log(
        `    [${label}] open ${w.openMs}ms mem +${w.rssDeltaMB}MB | ` +
          `type p95 1/50/99% = ${w['keystroke_1%'].p95}/${w['keystroke_50%'].p95}/${w['keystroke_99%'].p95}ms | ` +
          `scroll>32ms ${w.scrollWheel.pctOver32ms}% | reslice p50/p95 ${w.reslice.p50}/${w.reslice.p95}ms | ${bcSummary}`,
      );
    }
  } else {
    console.log(`    FAILED: ${r.error}`);
  }
}

writeFileSync(join(OUT, 'windowed-all.json'), JSON.stringify(results, null, 2));
console.log(`\nWrote ${join(OUT, 'windowed-all.json')}`);
