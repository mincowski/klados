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

const COLON = 0x3a // ':'

export class Interner {
  private nameBytes: Uint8Array
  private nameLength = 0
  private starts: Int32Array
  private ends: Int32Array
  private count = 0
  private readonly byHash = new Map<number, number[]>()
  private readonly textCache: (string | undefined)[] = []
  private readonly decoder = new TextDecoder('utf-8')
  /** Byte offset of the first `:` within each name (absolute, into
   * `nameBytes`, the same convention as `starts`/`ends`), or `-1` when the
   * name has no prefix — populated only when `namespaces` is `true`
   * (R134). `null` for the whole array when disabled, so a JSON/TOML
   * document pays not even the array allocation, let alone the per-name
   * scan. */
  private colonAt: Int32Array | null

  /**
   * `namespaces` gates the prefix/local split (R134 §"the colon scan must
   * be capability-gated") — pass `FormatCapabilities.hasNamespaces`, never
   * a format id (invariant 8). `Interner` is shared by every format
   * (`core/`), and a colon is an ordinary character in a JSON key: an
   * unconditional split would read `"12:30"` as prefix `12`, local `30` —
   * latent wrongness for formats that can never have namespaces, plus a
   * scan on every distinct name for no reason.
   */
  constructor(
    initialCapacity = INITIAL_CAPACITY,
    private readonly namespaces = false
  ) {
    this.nameBytes = new Uint8Array(initialCapacity * 8)
    this.starts = new Int32Array(initialCapacity)
    this.ends = new Int32Array(initialCapacity)
    this.colonAt = namespaces ? new Int32Array(initialCapacity) : null
  }

  /** Whether this interner splits names into prefix/local at intern time —
   * `NodeStore` reads this (rather than taking a second, redundant
   * capability flag) to decide whether to do any namespace-resolution work
   * at all (R134). */
  get splitsNamespaces(): boolean {
    return this.namespaces
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
   * `namespaces` must match what the original interner was constructed
   * with (`ParseDoneMessage.hasNamespaces`, threaded through rather than
   * re-derived from a format id) — when `true`, the prefix/local split is
   * recomputed here by re-scanning the (already reconstructed) name bytes
   * once per distinct name, the same "per distinct name, never per node"
   * cost §3 promises, rather than trying to serialize `colonAt` across the
   * worker boundary as a sixteenth buffer. */
  static fromBuffers(
    nameBytes: Uint8Array,
    starts: Int32Array,
    ends: Int32Array,
    namespaces = false
  ): Interner {
    const interner = new Interner(Math.max(1, starts.length), namespaces)
    interner.nameBytes = nameBytes
    interner.nameLength = nameBytes.length
    interner.starts = Int32Array.from(starts)
    interner.ends = Int32Array.from(ends)
    interner.count = starts.length
    if (namespaces) {
      interner.colonAt = new Int32Array(interner.count)
      for (let id = 0; id < interner.count; id++) {
        interner.colonAt[id] = interner.findColon(interner.starts[id]!, interner.ends[id]!)
      }
    }
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
    if (candidates === undefined) return null
    for (const id of candidates) {
      if (this.bytesEqual(id, bytes, 0, bytes.length)) return id
    }
    return null
  }

  text(id: number): string {
    const cached = this.textCache[id]
    if (cached !== undefined) return cached
    const decoded = this.decoder.decode(this.nameBytes.subarray(this.starts[id]!, this.ends[id]!))
    this.textCache[id] = decoded
    return decoded
  }

  /**
   * The prefix of an interned name, decoded — `null` when the name has no
   * `:` or when this interner doesn't split names at all (`namespaces` is
   * `false`; R134 §"the colon scan must be capability-gated"). `"inv"` for
   * `inv:price`; `null` for `price`, and `null` for a JSON key like
   * `"12:30"` when this interner was never told the format has namespaces.
   */
  prefixOf(id: number): string | null {
    const colon = this.colonAt?.[id] ?? -1
    if (colon === -1) return null
    return this.decoder.decode(this.nameBytes.subarray(this.starts[id]!, colon))
  }

  /** The local part of an interned name — everything after the first `:`,
   * or the whole name when there is none (or splitting is disabled). Never
   * cached separately from `text()`'s own cache; called only per distinct
   * name during namespace resolution (R134 §3), not per node. */
  localNameOf(id: number): string {
    const colon = this.colonAt?.[id] ?? -1
    if (colon === -1) return this.text(id)
    return this.decoder.decode(this.nameBytes.subarray(colon + 1, this.ends[id]!))
  }

  /** Byte offset of the first `:` in `nameBytes[start, end)`, or `-1`. A
   * colon at `start` itself (an empty prefix, `:foo`) is treated as "no
   * prefix" — not a namespace-worthy split, and not worth a diagnostic
   * either, since this scan happens at intern time with no query context
   * to report one against. */
  private findColon(start: number, end: number): number {
    for (let i = start; i < end; i++) {
      if (this.nameBytes[i] === COLON) return i > start ? i : -1
    }
    return -1
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
    // R134: the colon scan, once per distinct name (this is `add`, reached
    // only on a genuine miss in `intern`/never on a repeat), never per
    // node — and never at all when `namespaces` is false.
    if (this.colonAt !== null) {
      this.colonAt[id] = this.findColon(nameStart, this.nameLength)
    }

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
    if (this.colonAt !== null) {
      const grownColonAt = new Int32Array(capacity)
      grownColonAt.set(this.colonAt)
      this.colonAt = grownColonAt
    }
  }
}
