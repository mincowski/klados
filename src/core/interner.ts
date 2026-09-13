/**
 * Interns byte ranges (element/attribute/key names) into small integer ids.
 * Comparison on hash collision is done on raw bytes, never on decoded text —
 * decoding is reserved for `text()`, called lazily and cached.
 */
import { encodeText } from './textEncode'

const INITIAL_CAPACITY = 1024

export function fnv1a32(bytes: Uint8Array, start: number, end: number): number {
  let hash = 0x811c9dc5
  for (let i = start; i < end; i++) {
    hash ^= bytes[i]!
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export class Interner {
  private nameBytes: Uint8Array
  private nameLength = 0
  private starts: Int32Array
  private ends: Int32Array
  private count = 0
  private readonly byHash = new Map<number, number[]>()
  private readonly textCache: (string | undefined)[] = []
  private readonly decoder = new TextDecoder('utf-8')
  /** R203's NFC fallback index: `NFC(name) -> id`, built lazily and only
   * when a lookup has already missed with a non-ASCII query. `null` until
   * then, which is the common case — an all-ASCII document never builds it,
   * and neither does a document nobody queries. */
  private nfcIndex: Map<string, number> | null = null
  /** What `nfcIndex` was built from. It is rebuilt when either changes: the
   * name count grows (a splice interns new names into the same table) or a
   * lookup arrives with a different encoding. */
  private nfcIndexCount = -1
  private nfcIndexEncoding = ''
  /**
   * R209 removed a second parameter, `namespaces`, which gated a
   * prefix/local split at intern time (R134). An interned name is now the
   * name as written, for every format — a colon in it is an ordinary byte,
   * which is what it always was for JSON and TOML and is now also what it is
   * for XML.
   */
  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.nameBytes = new Uint8Array(initialCapacity * 8)
    this.starts = new Int32Array(initialCapacity)
    this.ends = new Int32Array(initialCapacity)
  }

  get size(): number {
    return this.count
  }

  /** M5-PLAN.md H9 — tightly-packed size in bytes: the name-byte pool plus
   * the `starts`/`ends` `Int32Array`s at `count` elements, not their
   * possibly-doubled allocated capacity. Mirrors `NodeStore`'s own
   * `packedMemoryBytes` (same reasoning, same shape) — CONCEPT.md §8's
   * budget table calls this "negligible," but the status bar sums it in
   * anyway rather than special-casing it as zero. */
  get packedMemoryBytes(): number {
    return this.nameLength + this.count * 4 /* Int32 */ * 2 /* starts + ends */
  }

  /** Trimmed copies of the backing arrays, suitable for a worker transfer. */
  exportBuffers(): { nameBytes: Uint8Array; starts: Int32Array; ends: Int32Array } {
    return {
      nameBytes: this.nameBytes.slice(0, this.nameLength),
      starts: this.starts.slice(0, this.count),
      ends: this.ends.slice(0, this.count)
    }
  }

  /** Rebuilds a fully functional Interner (including the hash index, so
   * `intern()` still works) from buffers produced by `exportBuffers`.
   *
   * R209 removed a fourth parameter here too. It had to match what the
   * original interner was constructed with, and the prefix/local split was
   * recomputed on this side by re-scanning the name bytes — a correctness
   * obligation on the caller that no longer exists, because there is no
   * derived state left to reconstruct. */
  static fromBuffers(nameBytes: Uint8Array, starts: Int32Array, ends: Int32Array): Interner {
    const interner = new Interner(Math.max(1, starts.length))
    interner.nameBytes = nameBytes
    interner.nameLength = nameBytes.length
    interner.starts = Int32Array.from(starts)
    interner.ends = Int32Array.from(ends)
    interner.count = starts.length
    for (let id = 0; id < interner.count; id++) {
      const hash = fnv1a32(interner.nameBytes, interner.starts[id]!, interner.ends[id]!)
      const bucket = interner.byHash.get(hash)
      if (bucket !== undefined) bucket.push(id)
      else interner.byHash.set(hash, [id])
    }
    return interner
  }

  intern(source: Uint8Array, start: number, end: number): number {
    const hash = fnv1a32(source, start, end)
    const length = end - start
    const candidates = this.byHash.get(hash)
    if (candidates !== undefined) {
      for (const id of candidates) {
        if (this.bytesEqual(id, source, start, length)) return id
      }
    }
    return this.add(hash, source, start, end, candidates)
  }

  /**
   * The read-only half of `intern()` — looks up an existing id for `text`
   * without ever adding a new one. M4-PLAN.md G7's path parser needs
   * exactly this: a query step's name resolves to `nameId` at parse time,
   * and a name that doesn't exist in the document must intern to *nothing*
   * (the query is then answerable as empty without touching the store),
   * never silently create a new interned name no node will ever have.
   *
   * R53 (`R53-interner-encoding.md`): stored names are the
   * *document's own bytes* (invariant 7 — never transcoded to UTF-8), so
   * `text` must be encoded the same way before comparison, not assumed
   * UTF-8. Returns `'unrepresentable'` — a third state, distinct from
   * `null` — when `encoding` genuinely cannot represent a character in
   * `text` (e.g. `日本語` against `windows-1252`): that is not "absent from
   * the document," it is an unanswerable query, and a caller must be able
   * to tell the two apart rather than silently reporting "no results" for
   * both.
   */
  lookup(text: string, encoding = 'utf-8'): number | null | 'unrepresentable' {
    const bytes = encodeText(text, encoding)
    if (bytes === null) return 'unrepresentable'
    const hash = fnv1a32(bytes, 0, bytes.length)
    const candidates = this.byHash.get(hash)
    if (candidates !== undefined) {
      for (const id of candidates) {
        if (this.bytesEqual(id, bytes, 0, bytes.length)) return id
      }
    }
    return this.lookupNormalized(text, encoding)
  }

  /**
   * R203 — the canonical-equivalence fallback, consulted only after an exact
   * byte lookup has missed.
   *
   * Stored names are the **document's own bytes** (invariant 7, R53), so a
   * name written `café` decomposed is a different byte sequence from the same
   * name composed, and the exact lookup cannot see past that. This builds a
   * second index keyed by each name's NFC form and answers from it.
   *
   * **Bounded by name count, not document size.** A 2 M-row, 10-column CSV
   * interns ten names (R145 acceptance 6); a large XML document interns
   * hundreds. The index is tens to low thousands of entries, built once and
   * reused until the table grows.
   *
   * **Skipped entirely for an ASCII query**, which is the free and the
   * correct answer at once: `NFC` of an ASCII string is itself, and no
   * non-ASCII string normalizes to pure ASCII under NFC (that is NFK*'s
   * compatibility mappings, which D-082 rejected). So any name whose NFC form
   * equals an ASCII query already *was* that query, and the exact lookup
   * above would have found it. The fallback could only cost time.
   *
   * **First id wins** on a collision — two distinct stored names that share
   * an NFC form. Document order, which is the only stable answer available
   * and matches how the exact path behaves when a hash bucket has several
   * candidates.
   */
  private lookupNormalized(text: string, encoding: string): number | null {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 0x7f) {
        const index = this.normalizedIndex(encoding)
        return index?.get(text.normalize('NFC')) ?? null
      }
    }
    return null
  }

  private normalizedIndex(encoding: string): Map<string, number> | null {
    if (
      this.nfcIndex !== null &&
      this.nfcIndexCount === this.count &&
      this.nfcIndexEncoding === encoding
    ) {
      return this.nfcIndex
    }
    let decoder: TextDecoder
    try {
      // `text(id)` always decodes UTF-8 — correct for display, and correct
      // here too whenever the document is UTF-8. For any other encoding the
      // names must be read back the way they were written, so this decodes
      // them itself rather than reusing that cache.
      decoder = encoding === 'utf-8' ? this.decoder : new TextDecoder(encoding)
    } catch {
      // An encoding label `TextDecoder` will not construct. The worker
      // already falls back to utf-8 before parsing when that happens
      // (`klados.encoding.unrecognized`), so this is unreachable in
      // practice; no fallback is better than a wrong one.
      return null
    }
    const index = new Map<string, number>()
    for (let id = 0; id < this.count; id++) {
      const name = decoder.decode(this.nameBytes.subarray(this.starts[id]!, this.ends[id]!))
      const normalized = name.normalize('NFC')
      if (!index.has(normalized)) index.set(normalized, id)
    }
    this.nfcIndex = index
    this.nfcIndexCount = this.count
    this.nfcIndexEncoding = encoding
    return index
  }

  text(id: number): string {
    const cached = this.textCache[id]
    if (cached !== undefined) return cached
    const decoded = this.decoder.decode(this.nameBytes.subarray(this.starts[id]!, this.ends[id]!))
    this.textCache[id] = decoded
    return decoded
  }

  private bytesEqual(id: number, source: Uint8Array, start: number, length: number): boolean {
    const nameStart = this.starts[id]!
    if (this.ends[id]! - nameStart !== length) return false
    for (let i = 0; i < length; i++) {
      if (this.nameBytes[nameStart + i] !== source[start + i]) return false
    }
    return true
  }

  private add(
    hash: number,
    source: Uint8Array,
    start: number,
    end: number,
    candidates: number[] | undefined
  ): number {
    const length = end - start
    this.ensureNameCapacity(this.nameLength + length)
    const nameStart = this.nameLength
    this.nameBytes.set(source.subarray(start, end), nameStart)
    this.nameLength += length

    const id = this.count
    this.ensureIdCapacity(id + 1)
    this.starts[id] = nameStart
    this.ends[id] = this.nameLength
    this.count++
    if (candidates !== undefined) {
      candidates.push(id)
    } else {
      this.byHash.set(hash, [id])
    }
    return id
  }

  private ensureNameCapacity(needed: number): void {
    if (needed <= this.nameBytes.length) return
    let capacity = this.nameBytes.length
    while (capacity < needed) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.nameBytes.subarray(0, this.nameLength))
    this.nameBytes = grown
  }

  private ensureIdCapacity(needed: number): void {
    if (needed <= this.starts.length) return
    let capacity = this.starts.length
    while (capacity < needed) capacity *= 2
    const grownStarts = new Int32Array(capacity)
    grownStarts.set(this.starts)
    this.starts = grownStarts
    const grownEnds = new Int32Array(capacity)
    grownEnds.set(this.ends)
    this.ends = grownEnds
  }
}
