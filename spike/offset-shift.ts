/**
 * M0a / A4 — Offset shift probe.
 *
 * THROWAWAY SPIKE CODE.
 *
 * Times adding a constant to every element of four Int32Arrays of 10,000,000
 * elements — what a naive post-edit offset fixup costs at 500 MB scale.
 *
 * Decides whether the pending-delta list in CONCEPT.md §5.2 is mandatory or
 * merely an optimisation (M0-PLAN A4 / A5).
 *
 * Run: node spike/offset-shift.ts
 */

const RUNS = 20;

function measure(n: number, label: string): number {
  const a = new Int32Array(n);
  const b = new Int32Array(n);
  const c = new Int32Array(n);
  const d = new Int32Array(n);

  // Fill with plausible ascending offsets so the arrays are really resident and
  // the pages are faulted in before timing starts.
  for (let i = 0; i < n; i++) {
    a[i] = i * 5;
    b[i] = i * 5 + 2;
    c[i] = i * 7;
    d[i] = i * 7 + 3;
  }

  const shiftAll = (delta: number): void => {
    for (let i = 0; i < n; i++) a[i] += delta;
    for (let i = 0; i < n; i++) b[i] += delta;
    for (let i = 0; i < n; i++) c[i] += delta;
    for (let i = 0; i < n; i++) d[i] += delta;
  };

  // Warm up the JIT.
  shiftAll(1);
  shiftAll(-1);

  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const delta = r % 2 === 0 ? 1 : -1;
    const t0 = process.hrtime.bigint();
    shiftAll(delta);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  times.sort((x, y) => x - y);
  const p = (q: number): number =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))]!;

  const bytes = 4 * n * 4;
  console.log(`\n${label}`);
  console.log(`  4 x Int32Array(${n.toLocaleString()}) = ${(bytes / 1024 / 1024).toFixed(0)} MB touched per pass`);
  console.log(`  min ${times[0]!.toFixed(1)} ms   p50 ${p(0.5).toFixed(1)} ms   p95 ${p(0.95).toFixed(1)} ms   max ${times[times.length - 1]!.toFixed(1)} ms`);
  console.log(`  effective ${(bytes / 1024 / 1024 / (p(0.5) / 1000)).toFixed(0)} MB/s`);

  // Defeat dead-code elimination.
  if (a[0]! + b[0]! + c[0]! + d[0]! === -12345) console.log('unreachable');
  return p(0.5);
}

// The size M0-PLAN A4 specifies.
const specified = measure(10_000_000, 'A4 as specified — 10,000,000 nodes');

// The size A3 actually measured for cars-500mb.xml. The plan's 10 M assumed
// ~50 bytes of source per node (CONCEPT.md §3.2); the fixtures run 10.7,
// because pretty-printed XML emits a Text node between every pair of tags.
// Only the four offset arrays shift — parent/firstChild/nextSibling/prevSibling
// hold node indices, not byte offsets, so they are unaffected by an edit.
const measured = measure(48_890_978, 'A4 at measured 500 MB scale — 48,890,978 nodes');

console.log(
  `\nAt the node density actually measured, a naive full shift costs ` +
    `${(measured / specified).toFixed(1)}x the specified probe.`,
);
