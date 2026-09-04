/**
 * M0a / A6b — driver. One fixed configuration (Part 1 + Part 2 both pinned
 * to specific fixtures and a 1 MB window per the plan), so there is nothing
 * to loop over — just one Electron process.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Usage: node run-a6b.js
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures');
const OUT = resolve(HERE, 'out');

const fixture500 = join(FIXTURES, 'cars-500mb.xml');
const fixtureMin = join(FIXTURES, 'cars-100mb.min.json');

for (const p of [fixture500, fixtureMin]) {
  if (!existsSync(p)) {
    console.error(`Missing fixture: ${p}`);
    process.exit(1);
  }
}

mkdirSync(OUT, { recursive: true });
const electron = require('electron');

// This environment (VS Code extension host) exports ELECTRON_RUN_AS_NODE=1,
// which makes the electron binary behave as plain Node. Must be cleared.
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
delete env.ELECTRON_RUN_AS_NODE;

const outPath = join(OUT, 'a6b.json');
// Reads a 500 MB + a 100 MB buffer and runs two full measurement batteries
// (20 incremental crossings, 300+ keystrokes, 200 scroll frames, twice) —
// generous but bounded cap.
const capMs = 900000;

console.log(`Part 1: cars-500mb.xml, Part 2: cars-100mb.min.json (+ cars-500mb.xml sanity), cap ${capMs / 1000}s`);
const t0 = Date.now();

await new Promise((done) => {
  const child = spawn(
    electron,
    [join(HERE, 'main-a6b.cjs'), fixture500, fixtureMin, outPath, String(capMs)],
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
  r = { ok: false, error: 'process died without reporting' };
}
r.wallSec = Number(wallSec);
writeFileSync(outPath, JSON.stringify(r, null, 2));

if (!r.ok) {
  console.log(`FAILED: ${r.error}`);
  if (r.crumbs) {
    console.log('crumbs:');
    for (const c of r.crumbs) console.log(' ', c.t, c.label, JSON.stringify(c.data));
  }
} else {
  const bc1 = r.part1.boundaryCrossing;
  console.log(
    `Part 1 [1MB/500mb] crossing p50/p95/max ${bc1.frameStats?.p50}/${bc1.frameStats?.p95}/${bc1.frameStats?.max}ms | ` +
      `drift top/caret ${bc1.maxAbsTopDrift}/${bc1.maxAbsCaretDrift}B | incremental ${bc1.incrementalCount.yes}/${bc1.crossings} | ` +
      `roundtrip.ok=${r.part1.offsetRoundTrip.ok}`,
  );
  for (const part of [r.part2Min, r.part2Sanity500]) {
    const bc = part.boundaryCrossing;
    const bcSummary = bc.skipped
      ? `crossing SKIPPED (${bc.reason})`
      : `crossing p50/p95/max ${bc.frameStats?.p50}/${bc.frameStats?.p95}/${bc.frameStats?.max}ms drift ${bc.maxAbsTopDrift}/${bc.maxAbsCaretDrift}B`;
    console.log(
      `Part 2 [${part.label}] hasScrollRange=${part.hasScrollRange} visualLines~${part.estimatedVisualLines} | ` +
        `type p95 1/50/99% ${part['keystroke_1%'].p95}/${part['keystroke_50%'].p95}/${part['keystroke_99%'].p95}ms | ` +
        `scroll p95 ${part.scrollWheel.p95}ms >32ms ${part.scrollWheel.pctOver32ms}% | ${bcSummary}`,
    );
  }
}

console.log(`\nWrote ${outPath}`);
