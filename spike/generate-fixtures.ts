/**
 * M0a / A1 — Fixture generator.
 *
 * THROWAWAY SPIKE CODE. Not part of the product, not tested, not tidy.
 *
 * Writes synthetic documents into spike/fixtures/ (gitignored) for the
 * CodeMirror harness (A2), the parser throughput probe (A3) and later M0b tests.
 *
 * Run:
 *   node spike/generate-fixtures.ts                 # everything
 *   node spike/generate-fixtures.ts cars-10mb.xml   # named subset
 *   node spike/generate-fixtures.ts --list
 *
 * Notes:
 *  - Output is deliberately pure ASCII so byte length === string length and the
 *    size targeting is exact and cheap.
 *  - "MB" here means 1024*1024 bytes.
 *  - Written incrementally through a stream with backpressure; nothing larger
 *    than one ~4 MB chunk is ever held in memory.
 *  - Record shapes follow CONCEPT.md Appendix A, with deterministic variance
 *    (seeded PRNG) so a regenerated fixture is byte-identical.
 */

import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, 'fixtures');
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// chunked, backpressure-aware writer
// ---------------------------------------------------------------------------

// Small on purpose: a larger chunk is not measurably faster here, and the
// acceptance criterion for A1 is a peak-memory one.
const FLUSH_AT = 512 * 1024;

/**
 * Encodes into one reused Buffer rather than joining strings and allocating a
 * fresh Buffer per chunk. Output is ASCII, so 'latin1' is both exact and the
 * fastest path. The only allocation per flush is the copy handed to the stream,
 * which is required because the stream may retain it past the call.
 */
class ChunkWriter {
  bytes = 0;
  private readonly stream: NodeJS.WritableStream;
  private readonly buf: Buffer;
  private offset = 0;

  constructor(stream: NodeJS.WritableStream) {
    this.stream = stream;
    // Slack so a single record never has to be split across flushes.
    this.buf = Buffer.allocUnsafe(FLUSH_AT + 64 * 1024);
  }

  async write(s: string): Promise<void> {
    if (this.offset + s.length > this.buf.length) await this.flush();
    this.offset += this.buf.write(s, this.offset, 'latin1');
    this.bytes += s.length;
    if (this.offset >= FLUSH_AT) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.offset === 0) return;
    const out = Buffer.from(this.buf.subarray(0, this.offset));
    this.offset = 0;
    if (!this.stream.write(out)) await once(this.stream, 'drain');
  }

  /** For fixtures that need real multi-byte UTF-8 content (nonascii-10mb.xml)
   * — the reused `buf` above is a `latin1` write, which truncates any
   * codepoint above U+00FF to its low byte and corrupts the encoding.
   * Flushes the latin1 buffer first so byte order stays correct, then
   * writes the UTF-8 encoding directly, bypassing `buf` entirely. */
  async writeUtf8(s: string): Promise<void> {
    await this.flush();
    const out = Buffer.from(s, 'utf8');
    this.bytes += out.length;
    if (!this.stream.write(out)) await once(this.stream, 'drain');
  }

  async end(): Promise<void> {
    await this.flush();
    this.stream.end();
    await once(this.stream, 'close');
  }
}

let peakRss = 0;
let peakHeap = 0;
let peakExternal = 0;
function sampleMemory(): void {
  const m = process.memoryUsage();
  if (m.rss > peakRss) {
    peakRss = m.rss;
    peakHeap = m.heapUsed;
    peakExternal = m.external;
  }
}

// ---------------------------------------------------------------------------
// the record model — CONCEPT.md Appendix A
// ---------------------------------------------------------------------------

const MAKES = [
  'Golf', 'Model 3', 'Panda', 'Corsa', 'Civic', 'Astra', 'Focus', 'Clio',
  'Polo', 'Fiesta', 'Micra', 'Yaris', 'Ibiza', 'Fabia', 'Leon', 'Ceed',
];
const COLORS = ['red', 'blue', 'silver', 'black', 'white', 'green', 'grey'];
const ENGINE_TYPES = ['diesel', 'electric', 'petrol', 'hybrid'];
const OWNERS = [
  'Smith', 'Jones', 'Lee', 'Weber', 'Novak', 'Rossi', 'Dubois', 'Silva',
  'Nakamura', 'Andersen', 'Kowalski', 'Fernandez',
];
const PLANTS = ['Wolfsburg', 'Fremont', 'Pomigliano', 'Zaragoza', 'Swindon'];

interface Car {
  index: number;
  color: string | null;      // ~10% absent  — the "optional field" variance
  name: string;
  year: number;
  scalarEngine: boolean;     // ~10% scalar <engine>petrol</engine>
  engineType: string;
  engineKw: number;
  owners: string[];          // 1..3, so multiplicity is exercised
  sunroof: boolean;          // presence-only field
  vin: string;
  mileage: number;
  plant: string;
}

function makeCar(index: number, rnd: () => number): Car {
  const owners: string[] = [];
  const ownerCount = rnd() < 0.2 ? (rnd() < 0.3 ? 3 : 2) : 1;
  for (let i = 0; i < ownerCount; i++) {
    owners.push(OWNERS[Math.floor(rnd() * OWNERS.length)]!);
  }
  return {
    index,
    color: rnd() < 0.1 ? null : COLORS[Math.floor(rnd() * COLORS.length)]!,
    name: MAKES[Math.floor(rnd() * MAKES.length)]!,
    year: 1998 + Math.floor(rnd() * 28),
    scalarEngine: rnd() < 0.1,
    engineType: ENGINE_TYPES[Math.floor(rnd() * ENGINE_TYPES.length)]!,
    engineKw: 55 + Math.floor(rnd() * 300),
    owners,
    sunroof: rnd() < 0.35,
    vin: 'WVW' + String(100000000 + Math.floor(rnd() * 899999999)),
    mileage: Math.floor(rnd() * 320000),
    plant: PLANTS[Math.floor(rnd() * PLANTS.length)]!,
  };
}

function carId(index: number): string {
  return 'c-' + String(index).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// XML rendering
// ---------------------------------------------------------------------------

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<garage>\n' +
  '  <!-- Fleet inventory, generated fixture -->\n' +
  '  <cars>\n' +
  '    <elements>\n';

const XML_FOOTER = '    </elements>\n  </cars>\n</garage>\n';

function xmlCar(c: Car): string {
  const color = c.color === null ? '' : ` color="${c.color}"`;
  const engine = c.scalarEngine
    ? `        <engine>${c.engineType}</engine>\n`
    : '        <engine>\n' +
      `          <type>${c.engineType}</type>\n` +
      `          <kw>${c.engineKw}</kw>\n` +
      '        </engine>\n';
  let owners = '';
  for (const o of c.owners) owners += `        <owner>${o}</owner>\n`;
  return (
    `      <car id="${carId(c.index)}"${color}>\n` +
    `        <name>${c.name}</name>\n` +
    `        <year>${c.year}</year>\n` +
    engine +
    owners +
    (c.sunroof ? '        <sunroof/>\n' : '') +
    `        <vin>${c.vin}</vin>\n` +
    `        <mileage>${c.mileage}</mileage>\n` +
    `        <plant>${c.plant}</plant>\n` +
    '      </car>\n'
  );
}

// ---------------------------------------------------------------------------
// R129–R131 corpus B — the predicate budget fixture.
//
// Five attributes per record (the realistic shape; §7's own correction came
// from measuring against one attribute instead) with `vin` deliberately
// last, so `//car[@vin="…"]` is the attribute-5-of-5 case §2 measured at
// 239.2 ms. Plus a numeric <price> child for `//car[price>50000]`.
//
// Every field is a pure function of the record index, with no PRNG: the
// budget test recomputes the expected answer from the same formulas rather
// than counting what the query returned, so a wrong answer that is fast
// still fails.
// ---------------------------------------------------------------------------

function attrsCarPrice(i: number): number {
  return 1000 + ((i * 37) % 89000);
}

function attrsCar(i: number): string {
  const year = 1998 + (i % 28);
  const color = COLORS[i % COLORS.length]!;
  const plant = PLANTS[i % PLANTS.length]!;
  const vin = 'WVW' + String(100000000 + i);
  return (
    `  <car id="${carId(i)}" year="${year}" color="${color}" plant="${plant}" vin="${vin}">\n` +
    `    <name>${MAKES[i % MAKES.length]!}</name>\n` +
    `    <price>${attrsCarPrice(i)}</price>\n` +
    `    <mileage>${(i * 613) % 320000}</mileage>\n` +
    `    <engine>${ENGINE_TYPES[i % ENGINE_TYPES.length]!}</engine>\n` +
    `    <owner>${OWNERS[i % OWNERS.length]!}</owner>\n` +
    '  </car>\n'
  );
}

async function generateCarsAttrsXml(name: string, records: number): Promise<void> {
  const w = open(name);
  await w.write('<?xml version="1.0" encoding="UTF-8"?>\n<garage>\n');
  for (let i = 0; i < records; i++) {
    await w.write(attrsCar(i));
    if ((i & 0xfff) === 0) sampleMemory();
  }
  await w.write('</garage>\n');
  await w.end();
  sampleMemory();
}

// ---------------------------------------------------------------------------
// JSON rendering — CONCEPT.md Appendix A.3
// ---------------------------------------------------------------------------

const JSON_HEADER_PRETTY =
  '{\n  "garage": {\n    "cars": {\n      "items": [\n';
const JSON_FOOTER_PRETTY = '\n      ]\n    }\n  }\n}\n';

const JSON_HEADER_MIN = '{"garage":{"cars":{"items":[';
const JSON_FOOTER_MIN = ']}}}';

function jsonCarPretty(c: Car): string {
  const lines: string[] = [];
  lines.push(`          "id": "${carId(c.index)}"`);
  if (c.color !== null) lines.push(`          "color": "${c.color}"`);
  lines.push(`          "name": "${c.name}"`);
  lines.push(`          "year": ${c.year}`);
  lines.push(
    c.scalarEngine
      ? `          "engine": "${c.engineType}"`
      : `          "engine": { "type": "${c.engineType}", "kw": ${c.engineKw} }`,
  );
  lines.push(
    `          "owners": [${c.owners.map((o) => `"${o}"`).join(', ')}]`,
  );
  if (c.sunroof) lines.push('          "sunroof": true');
  lines.push(`          "vin": "${c.vin}"`);
  lines.push(`          "mileage": ${c.mileage}`);
  lines.push(`          "plant": "${c.plant}"`);
  return '        {\n' + lines.join(',\n') + '\n        }';
}

function jsonCarMin(c: Car): string {
  const parts: string[] = [];
  parts.push(`"id":"${carId(c.index)}"`);
  if (c.color !== null) parts.push(`"color":"${c.color}"`);
  parts.push(`"name":"${c.name}"`);
  parts.push(`"year":${c.year}`);
  parts.push(
    c.scalarEngine
      ? `"engine":"${c.engineType}"`
      : `"engine":{"type":"${c.engineType}","kw":${c.engineKw}}`,
  );
  parts.push(`"owners":[${c.owners.map((o) => `"${o}"`).join(',')}]`);
  if (c.sunroof) parts.push('"sunroof":true');
  parts.push(`"vin":"${c.vin}"`);
  parts.push(`"mileage":${c.mileage}`);
  parts.push(`"plant":"${c.plant}"`);
  return '{' + parts.join(',') + '}';
}

// ---------------------------------------------------------------------------
// generators
// ---------------------------------------------------------------------------

function open(name: string): ChunkWriter {
  return new ChunkWriter(
    createWriteStream(join(OUT_DIR, name), { highWaterMark: 1 * MB }),
  );
}

async function generateCarsXml(name: string, targetBytes: number): Promise<void> {
  const w = open(name);
  const rnd = mulberry32(0x5eed);
  await w.write(XML_HEADER);
  const limit = targetBytes - XML_FOOTER.length;
  let i = 0;
  while (w.bytes < limit) {
    await w.write(xmlCar(makeCar(i++, rnd)));
    if ((i & 0xfff) === 0) sampleMemory();
  }
  await w.write(XML_FOOTER);
  await w.end();
  sampleMemory();
}

async function generateCarsJson(
  name: string,
  targetBytes: number,
  minified: boolean,
): Promise<void> {
  const w = open(name);
  const rnd = mulberry32(0x5eed);
  const header = minified ? JSON_HEADER_MIN : JSON_HEADER_PRETTY;
  const footer = minified ? JSON_FOOTER_MIN : JSON_FOOTER_PRETTY;
  const sep = minified ? ',' : ',\n';
  await w.write(header);
  const limit = targetBytes - footer.length;
  let i = 0;
  while (w.bytes < limit) {
    const c = makeCar(i, rnd);
    const body = minified ? jsonCarMin(c) : jsonCarPretty(c);
    await w.write(i === 0 ? body : sep + body);
    i++;
    if ((i & 0xfff) === 0) sampleMemory();
  }
  await w.write(footer);
  await w.end();
  sampleMemory();
}

// ---------------------------------------------------------------------------
// M5g-PLAN.md §3.2 — fixtures exercising the formatter's non-happy paths.
// ---------------------------------------------------------------------------

const MIXED_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<doc>\n';
const MIXED_FOOTER = '</doc>\n';

function mixedParagraph(i: number): string {
  return (
    `  <p id="p-${i}">Text <b><a href="#${i}">with a link</a></b> and more text, ` +
    `then <i>italic ${i}</i> and a trailing word.</p>\n`
  );
}

/** Many `IsMixed` elements — the subtree-skip path (R11) and the copy-verbatim branch. */
async function generateMixedXml(name: string, targetBytes: number): Promise<void> {
  const w = open(name);
  await w.write(MIXED_HEADER);
  const limit = targetBytes - MIXED_FOOTER.length;
  let i = 0;
  while (w.bytes < limit) {
    await w.write(mixedParagraph(i++));
    if ((i & 0xfff) === 0) sampleMemory();
  }
  await w.write(MIXED_FOOTER);
  await w.end();
  sampleMemory();
}

const PRESERVE_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<doc>\n';
const PRESERVE_FOOTER = '</doc>\n';

function preserveBlock(i: number): string {
  // Nested elements inherit xml:space="preserve" from the outer <pre> — the
  // inner <line> declares nothing of its own, exercising inherited scope,
  // not just a directly-annotated element.
  return (
    `  <pre id="pre-${i}" xml:space="preserve">\n` +
    `    <line>  leading and   internal    spaces  kept  </line>\n` +
    `  </pre>\n`
  );
}

/** `xml:space="preserve"` scope, including inherited (not just direct) scope. */
async function generatePreserveXml(name: string, targetBytes: number): Promise<void> {
  const w = open(name);
  await w.write(PRESERVE_HEADER);
  const limit = targetBytes - PRESERVE_FOOTER.length;
  let i = 0;
  while (w.bytes < limit) {
    await w.write(preserveBlock(i++));
    if ((i & 0xfff) === 0) sampleMemory();
  }
  await w.write(PRESERVE_FOOTER);
  await w.end();
  sampleMemory();
}

const NONASCII_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<garage>\n  <cars>\n';
const NONASCII_FOOTER = '  </cars>\n</garage>\n';

// Multi-byte content in every field: accented Latin, CJK, and an emoji
// (a 4-byte UTF-8 / surrogate-pair codepoint) — the suite's only non-ASCII
// XML fixture (flagged since M5b).
const NONASCII_OWNERS = ['Müller', 'Dvořák', '田中', 'López', 'Škoda', '北京', 'Åström', '🚗号'];
const NONASCII_NAMES = ['Škoda Octavia', 'Citroën C4', 'Größer Wagen', '軽自動車', 'Peugeot 🇫🇷'];

function nonAsciiCar(index: number, rnd: () => number): string {
  const owner = NONASCII_OWNERS[Math.floor(rnd() * NONASCII_OWNERS.length)]!;
  const name = NONASCII_NAMES[Math.floor(rnd() * NONASCII_NAMES.length)]!;
  return (
    `    <car id="${carId(index)}">\n` +
    `      <name>${name}</name>\n` +
    `      <owner>${owner}</owner>\n` +
    `      <note>Zuständig: ${owner} — 備考あり — caractère spécial: é à ü ñ</note>\n` +
    `    </car>\n`
  );
}

async function generateNonAsciiXml(name: string, targetBytes: number): Promise<void> {
  const w = open(name);
  const rnd = mulberry32(0x5eed);
  await w.writeUtf8(NONASCII_HEADER);
  const limit = targetBytes - NONASCII_FOOTER.length;
  let i = 0;
  while (w.bytes < limit) {
    await w.writeUtf8(nonAsciiCar(i++, rnd));
    if ((i & 0xfff) === 0) sampleMemory();
  }
  await w.writeUtf8(NONASCII_FOOTER);
  await w.end();
  sampleMemory();
}

/** Deep nesting — indentation cost grows with depth (O3's target). Single
 * long chain of elements, each holding the next, capped well under
 * `DEFAULT_MAX_DEPTH` and repeated as siblings to reach `targetBytes`. */
async function generateDeepXml(name: string, targetBytes: number, chainDepth: number): Promise<void> {
  const w = open(name);
  await w.write('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n');
  let i = 0;
  const limit = targetBytes - '</root>\n'.length;
  while (w.bytes < limit) {
    let chain = `  <c${i}>\n`;
    for (let d = 0; d < chainDepth; d++) chain += '  '.repeat(d + 2) + `<lvl${d}>\n`;
    chain += '  '.repeat(chainDepth + 2) + `leaf ${i}\n`;
    for (let d = chainDepth - 1; d >= 0; d--) chain += '  '.repeat(d + 2) + `</lvl${d}>\n`;
    chain += `  </c${i}>\n`;
    await w.write(chain);
    i++;
    if ((i & 0xff) === 0) sampleMemory();
  }
  await w.write('</root>\n');
  await w.end();
  sampleMemory();
}

async function generateDeepJson(name: string, depth: number): Promise<void> {
  const w = open(name);
  // Nested arrays, innermost holding a scalar so the document is valid JSON.
  const CHUNK = 100000;
  for (let written = 0; written < depth; written += CHUNK) {
    await w.write('['.repeat(Math.min(CHUNK, depth - written)));
  }
  await w.write('0');
  for (let written = 0; written < depth; written += CHUNK) {
    await w.write(']'.repeat(Math.min(CHUNK, depth - written)));
  }
  await w.write('\n');
  await w.end();
  sampleMemory();
}

/** M5h-PLAN.md R18, §3: `generateDeepXml` above builds *many shallow*
 * `<c{i}>` chains (depth `chainDepth`, repeated to reach `targetBytes`) —
 * useful for row-index/throughput measurement, but it never reaches a
 * single deeply-*nested* element the way `generateDeepJson` does for JSON.
 * `deep-10mb.xml` (chainDepth 40) does not exercise the formatter's own
 * stack-overflow defect at all; this does, mirroring `generateDeepJson`'s
 * own shape one element deep instead of one array deep. */
async function generateDeepNestingXml(name: string, depth: number): Promise<void> {
  const w = open(name);
  await w.write('<?xml version="1.0" encoding="UTF-8"?>\n');
  const CHUNK = 100000;
  for (let written = 0; written < depth; written += CHUNK) {
    await w.write('<a>'.repeat(Math.min(CHUNK, depth - written)));
  }
  await w.write('leaf');
  for (let written = 0; written < depth; written += CHUNK) {
    await w.write('</a>'.repeat(Math.min(CHUNK, depth - written)));
  }
  await w.write('\n');
  await w.end();
  sampleMemory();
}

// ---------------------------------------------------------------------------
// manifest / driver
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  approx: string;
  run: () => Promise<void>;
}

const FIXTURES: Fixture[] = [
  { name: 'cars-10mb.xml', approx: '10 MB', run: () => generateCarsXml('cars-10mb.xml', 10 * MB) },
  { name: 'cars-50mb.xml', approx: '50 MB', run: () => generateCarsXml('cars-50mb.xml', 50 * MB) },
  { name: 'cars-100mb.xml', approx: '100 MB', run: () => generateCarsXml('cars-100mb.xml', 100 * MB) },
  { name: 'cars-200mb.xml', approx: '200 MB', run: () => generateCarsXml('cars-200mb.xml', 200 * MB) },
  { name: 'cars-500mb.xml', approx: '500 MB', run: () => generateCarsXml('cars-500mb.xml', 500 * MB) },
  { name: 'cars-attrs-400k.xml', approx: '~85 MB', run: () => generateCarsAttrsXml('cars-attrs-400k.xml', 400_000) },
  { name: 'cars-100mb.json', approx: '100 MB', run: () => generateCarsJson('cars-100mb.json', 100 * MB, false) },
  { name: 'cars-100mb.min.json', approx: '100 MB', run: () => generateCarsJson('cars-100mb.min.json', 100 * MB, true) },
  { name: 'deep-10k.json', approx: '20 KB', run: () => generateDeepJson('deep-10k.json', 10_000) },
  { name: 'deep-1m.json', approx: '2 MB', run: () => generateDeepJson('deep-1m.json', 1_000_000) },
  { name: 'mixed-10mb.xml', approx: '10 MB', run: () => generateMixedXml('mixed-10mb.xml', 10 * MB) },
  { name: 'preserve-10mb.xml', approx: '10 MB', run: () => generatePreserveXml('preserve-10mb.xml', 10 * MB) },
  { name: 'nonascii-10mb.xml', approx: '10 MB', run: () => generateNonAsciiXml('nonascii-10mb.xml', 10 * MB) },
  { name: 'deep-10mb.xml', approx: '10 MB', run: () => generateDeepXml('deep-10mb.xml', 10 * MB, 40) },
  { name: 'deep-nesting-20k.xml', approx: '~140 KB', run: () => generateDeepNestingXml('deep-nesting-20k.xml', 20_000) },
];

function fmtBytes(n: number): string {
  if (n >= MB) return (n / MB).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const f of FIXTURES) console.log(`${f.name.padEnd(22)} ${f.approx}`);
    return;
  }
  const wanted = args.filter((a) => !a.startsWith('-'));
  const selected =
    wanted.length === 0
      ? FIXTURES
      : FIXTURES.filter((f) => wanted.includes(f.name));

  if (selected.length === 0) {
    console.error('No fixture matched. Use --list to see names.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Writing to ${OUT_DIR}\n`);

  const overall = Date.now();
  for (const f of selected) {
    const t0 = Date.now();
    await f.run();
    const size = statSync(join(OUT_DIR, f.name)).size;
    const secs = (Date.now() - t0) / 1000;
    const rate = size / MB / Math.max(secs, 0.001);
    console.log(
      `${f.name.padEnd(22)} ${fmtBytes(size).padStart(10)}  ` +
        `${secs.toFixed(1)}s  ${rate.toFixed(0)} MB/s`,
    );
  }

  console.log(
    `\nDone in ${((Date.now() - overall) / 1000).toFixed(1)}s. ` +
      `Peak RSS ${fmtBytes(peakRss)} ` +
      `(heap ${fmtBytes(peakHeap)}, external ${fmtBytes(peakExternal)}).`,
  );
}

await main();
