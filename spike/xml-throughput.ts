/**
 * M0a / A3 — XML parser throughput probe.
 *
 * THROWAWAY SPIKE CODE.
 *
 * A deliberately minimal XML scanner: finds element and attribute boundaries and
 * writes offsets into pre-allocated Int32Arrays. No interning, no validation, no
 * error handling, no tree beyond a depth counter and an open-element stack.
 * It is not correct on edge cases. It exists to be representative of the inner
 * loop so we can answer one question: does a byte-scanning TypeScript parser
 * reach ~100-300 MB/s (M0-PLAN A3 / CONCEPT.md §10)?
 *
 * Run:
 *   node spike/xml-throughput.ts
 *   node spike/xml-throughput.ts cars-100mb.xml
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures');
const MB = 1024 * 1024;

// byte constants
const LT = 0x3c;      // <
const GT = 0x3e;      // >
const SLASH = 0x2f;   // /
const EXCL = 0x21;    // !
const QUES = 0x3f;    // ?
const EQ = 0x3d;      // =
const QUOT = 0x22;    // "
const APOS = 0x27;    // '
const DASH = 0x2d;    // -
const LBRACKET = 0x5b;// [
const RBRACKET = 0x5d;// ]

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
}

/** Name chars, approximated: anything that is not space, >, /, = or a quote. */
function isNameByte(b: number): boolean {
  return !isSpace(b) && b !== GT && b !== SLASH && b !== EQ && b !== QUOT && b !== APOS;
}

interface ScanResult {
  nodes: number;
  elements: number;
  attributes: number;
  textNodes: number;
  wsTextNodes: number;
  maxDepth: number;
  arrayBytes: number;
  overflowed: boolean;
}

function scan(buf: Uint8Array): ScanResult {
  const len = buf.length;

  // Capacity estimates. NOTE: pretty-printed XML produces roughly one Text node
  // per tag (the inter-tag whitespace), so total nodes runs far ahead of element
  // count — ~9-11 bytes of source per node, not the ~50 assumed in CONCEPT.md
  // §3.2. Sized at /8 so the timed pass never hits the cap; an overflow would
  // both corrupt the counts and make the loop artificially fast by skipping the
  // stores.
  const nodeCap = Math.ceil(len / 8) + 16;
  const attrCap = Math.ceil(len / 64) + 16;

  const spanStart = new Int32Array(nodeCap);
  const spanEnd = new Int32Array(nodeCap);
  const nameStart = new Int32Array(nodeCap);
  const nameEnd = new Int32Array(nodeCap);
  const depthOf = new Int32Array(nodeCap);

  const attrOwner = new Int32Array(attrCap);
  const attrNameStart = new Int32Array(attrCap);
  const attrNameEnd = new Int32Array(attrCap);
  const attrValStart = new Int32Array(attrCap);
  const attrValEnd = new Int32Array(attrCap);

  const stack = new Int32Array(4096);

  let n = 0;          // total node count
  let a = 0;          // attribute count
  let sp = 0;         // stack pointer
  let depth = 0;
  let maxDepth = 0;
  let textNodes = 0;
  let wsTextNodes = 0;
  let elements = 0;

  let i = 0;
  while (i < len) {
    // ---- text run up to the next '<' -------------------------------------
    if (buf[i] !== LT) {
      const textStart = i;
      let ws = true;
      while (i < len && buf[i] !== LT) {
        if (ws && !isSpace(buf[i]!)) ws = false;
        i++;
      }
      // M0-PLAN B9 requires a Text node either way, with a flag marking
      // whitespace-only. Counted separately here because that decision is what
      // drives the total node count.
      textNodes++;
      if (ws) wsTextNodes++;
      if (n < nodeCap) {
        spanStart[n] = textStart;
        spanEnd[n] = i;
        nameStart[n] = textStart;
        nameEnd[n] = textStart;
        depthOf[n] = depth;
        n++;
      }
      continue;
    }

    const tagStart = i;
    const c1 = buf[i + 1];

    // ---- end tag ----------------------------------------------------------
    if (c1 === SLASH) {
      while (i < len && buf[i] !== GT) i++;
      i++;
      if (sp > 0) {
        sp--;
        const owner = stack[sp]!;
        spanEnd[owner] = i;
        depth--;
      }
      continue;
    }

    // ---- <! ... : comment, CDATA, doctype ---------------------------------
    if (c1 === EXCL) {
      if (buf[i + 2] === DASH && buf[i + 3] === DASH) {
        // comment: scan to -->
        i += 4;
        while (i + 2 < len && !(buf[i] === DASH && buf[i + 1] === DASH && buf[i + 2] === GT)) i++;
        i += 3;
      } else if (buf[i + 2] === LBRACKET) {
        // CDATA: scan to ]]>
        i += 9;
        while (i + 2 < len && !(buf[i] === RBRACKET && buf[i + 1] === RBRACKET && buf[i + 2] === GT)) i++;
        i += 3;
      } else {
        // doctype and friends: scan to '>' (no internal subset handling — spike)
        while (i < len && buf[i] !== GT) i++;
        i++;
      }
      if (n < nodeCap) {
        spanStart[n] = tagStart;
        spanEnd[n] = i;
        nameStart[n] = tagStart;
        nameEnd[n] = tagStart;
        depthOf[n] = depth;
        n++;
      }
      continue;
    }

    // ---- processing instruction / prolog ----------------------------------
    if (c1 === QUES) {
      i += 2;
      while (i + 1 < len && !(buf[i] === QUES && buf[i + 1] === GT)) i++;
      i += 2;
      if (n < nodeCap) {
        spanStart[n] = tagStart;
        spanEnd[n] = i;
        nameStart[n] = tagStart;
        nameEnd[n] = tagStart;
        depthOf[n] = depth;
        n++;
      }
      continue;
    }

    // ---- start tag --------------------------------------------------------
    i++;
    const nStart = i;
    while (i < len && isNameByte(buf[i]!)) i++;
    const nEnd = i;

    const self = n;
    elements++;
    if (n < nodeCap) {
      spanStart[n] = tagStart;
      spanEnd[n] = -1;
      nameStart[n] = nStart;
      nameEnd[n] = nEnd;
      depthOf[n] = depth;
      n++;
    }

    // ---- attributes -------------------------------------------------------
    let selfClosing = false;
    for (;;) {
      while (i < len && isSpace(buf[i]!)) i++;
      if (i >= len) break;

      const b = buf[i]!;
      if (b === GT) {
        i++;
        break;
      }
      if (b === SLASH) {
        selfClosing = true;
        i++;
        continue;
      }

      const anStart = i;
      while (i < len && isNameByte(buf[i]!)) i++;
      const anEnd = i;
      if (anEnd === anStart) {
        // not a name and not a delimiter — resync
        i++;
        continue;
      }

      while (i < len && isSpace(buf[i]!)) i++;
      if (buf[i] !== EQ) {
        // valueless attribute (not legal XML, but do not stall)
        if (a < attrCap) {
          attrOwner[a] = self;
          attrNameStart[a] = anStart;
          attrNameEnd[a] = anEnd;
          attrValStart[a] = anEnd;
          attrValEnd[a] = anEnd;
          a++;
        }
        continue;
      }
      i++; // '='
      while (i < len && isSpace(buf[i]!)) i++;

      const quote = buf[i]!;
      let avStart: number;
      let avEnd: number;
      if (quote === QUOT || quote === APOS) {
        i++;
        avStart = i;
        while (i < len && buf[i] !== quote) i++;
        avEnd = i;
        i++; // closing quote
      } else {
        avStart = i;
        while (i < len && !isSpace(buf[i]!) && buf[i] !== GT) i++;
        avEnd = i;
      }

      if (a < attrCap) {
        attrOwner[a] = self;
        attrNameStart[a] = anStart;
        attrNameEnd[a] = anEnd;
        attrValStart[a] = avStart;
        attrValEnd[a] = avEnd;
        a++;
      }
    }

    if (selfClosing) {
      spanEnd[self] = i;
    } else {
      if (sp < stack.length) stack[sp++] = self;
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    }
  }

  const arrayBytes =
    (spanStart.length + spanEnd.length + nameStart.length + nameEnd.length + depthOf.length) * 4 +
    (attrOwner.length + attrNameStart.length + attrNameEnd.length + attrValStart.length + attrValEnd.length) * 4;

  // Touch the arrays so nothing above can be optimised away.
  let sink = 0;
  for (let k = 0; k < n; k += 4096) sink += spanStart[k]! + nameEnd[k]!;
  for (let k = 0; k < a; k += 4096) sink += attrValStart[k]!;
  if (sink === -1) console.log('unreachable');

  return {
    nodes: n,
    elements,
    attributes: a,
    textNodes,
    wsTextNodes,
    maxDepth,
    arrayBytes,
    overflowed: n >= nodeCap || a >= attrCap,
  };
}

function fmtBytes(n: number): string {
  return n >= MB ? (n / MB).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
}

function run(name: string): void {
  const path = join(FIXTURES, name);
  const t0 = Date.now();
  const buf = readFileSync(path);
  const readMs = Date.now() - t0;

  const before = process.memoryUsage();

  // One warm-up on a slice, so the timed pass runs against JIT-compiled code
  // rather than measuring compilation. Representative of the real parser, which
  // will be warm long before it reaches the interesting part of a large file.
  scan(buf.subarray(0, Math.min(buf.length, 8 * MB)));

  const runs = buf.length > 200 * MB ? 1 : 3;
  let best = Infinity;
  let result: ScanResult | null = null;
  for (let r = 0; r < runs; r++) {
    const s = process.hrtime.bigint();
    result = scan(buf);
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    if (ms < best) best = ms;
  }

  const after = process.memoryUsage();
  const res = result!;
  const mb = buf.length / MB;

  console.log(`\n${name}  (${mb.toFixed(0)} MB, read in ${readMs} ms)`);
  console.log(`  throughput      ${(mb / (best / 1000)).toFixed(0)} MB/s   (${best.toFixed(0)} ms, best of ${runs})`);
  console.log(`  nodes           ${res.nodes.toLocaleString()} total = ${res.elements.toLocaleString()} elements + ${res.textNodes.toLocaleString()} text/other`);
  console.log(`  ws-only text    ${res.wsTextNodes.toLocaleString()}  (${((100 * res.wsTextNodes) / res.nodes).toFixed(1)}% of all nodes)`);
  console.log(`  attributes      ${res.attributes.toLocaleString()}`);
  console.log(`  max depth       ${res.maxDepth}`);
  console.log(`  arrays          ${fmtBytes(res.arrayBytes)} allocated (capacity), ${fmtBytes(res.nodes * 20 + res.attributes * 20)} used`);
  console.log(`  bytes/node      ${(buf.length / res.nodes).toFixed(1)}  (per element: ${(buf.length / res.elements).toFixed(1)})`);
  if (res.overflowed) console.log('  ** CAPACITY OVERFLOW — counts and timing are invalid **');
  console.log(`  rss delta       ${fmtBytes(after.rss - before.rss)}   (rss now ${fmtBytes(after.rss)})`);
}

const args = process.argv.slice(2).filter((s) => !s.startsWith('-'));
const files = args.length > 0 ? args : ['cars-100mb.xml', 'cars-500mb.xml'];
for (const f of files) run(f);
