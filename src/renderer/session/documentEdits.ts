/**
 * The mutation primitive M3-PLAN.md F1 asks for (CONCEPT.md §5.6, D-011).
 * Every edit — a keystroke, eventually a Transform, eventually a structural
 * edit (§5.4) — becomes a `Patch` against the byte buffer; nothing above
 * this module ever regenerates text from the model (invariant 6, D-007).
 *
 * This is the simple version the plan explicitly asks for first: a full
 * `Uint8Array` splice per patch, not a rope or gap buffer. F10 measures
 * whether that survives at 200 MB and this module is where the structure
 * changes if it doesn't — nothing above `createEdit`/`applyPatch` should
 * need to know which one it is.
 *
 * `encodeForRoundTrip` delegates to `core/textEncode.ts`'s `encodeText`
 * (R125, `R125-legacy-encoding-edits.md`): built for `Interner.lookup`
 * (R53/D-074) by probing `TextDecoder` with all 256 byte values once and
 * inverting the map, it handles UTF-8, UTF-16 LE/BE and every invertible
 * single-byte code page (windows-1252, iso-8859-1/15, …) with the same
 * signature and the same `null`-means-"can't represent this" semantics
 * `encodeForRoundTrip` already had. §5.5's per-character lossy detection is
 * exactly what that probe-and-invert gives for free — a genuinely
 * multi-byte non-UTF encoding (shift_jis, gb18030, big5) still returns
 * `null` unconditionally, which `createEdit`/`applyReplaceAll` tell apart
 * from "this text has an unrepresentable character" via `canEncode`.
 */
import type { SourceBuffer } from '../../core/buffer'
import { canEncode, encodeText, findUnrepresentableCharacter } from '../../core/textEncode'

export interface Patch {
  readonly start: number
  readonly end: number
  readonly replacement: Uint8Array
}

export type EditRefusal =
  | { readonly kind: 'not-ready' }
  | { readonly kind: 'read-only' }
  /** §4.4/D-032: spans — and the BOM — are absolute in the buffer as read.
   * An edit starting before `bomLength` would splice into or through it. */
  | { readonly kind: 'bom' }
  /** The document's encoding itself can never be written — a genuinely
   * multi-byte non-UTF encoding (`shift_jis`, `gb18030`, `big5`, …). Not
   * used for a single-byte code page that merely lacks one character; see
   * `unrepresentable-character` for that (R125, §3). */
  | { readonly kind: 'unsupported-encoding'; readonly encoding: string }
  /** The encoding is fine; *this edit's text* has a character it can't
   * represent (e.g. `日` into `windows-1252`). Carries the offending
   * character so the message can name it, per D-009's "refused with an
   * explanation." */
  | {
      readonly kind: 'unrepresentable-character'
      readonly encoding: string
      readonly character: string
    }

export interface EditRequest {
  readonly start: number
  readonly end: number
  /** Decoded text, as the editor holds it — encoding back to bytes is this
   * module's job, not the caller's (§5.5's "the editor works in decoded
   * text, the buffer holds bytes"). */
  readonly text: string
}

export interface EditSuccess {
  readonly ok: true
  readonly patch: Patch
  /** The document's new complete byte buffer — this module's own
   * `applyPatch` already spliced it. */
  readonly bytes: Uint8Array
}

export interface EditFailure {
  readonly ok: false
  readonly reason: EditRefusal
  /** Human-readable — "the reason reaching the UI" is F1's own acceptance
   * criterion, and there is no editing UI yet (F9) to build a message from
   * a bare `reason` tag. */
  readonly message: string
}

export type EditOutcome = EditSuccess | EditFailure

function refuse(reason: EditRefusal, message: string): EditFailure {
  return { ok: false, reason, message }
}

/**
 * The splice itself — three `subarray`s and one allocation, no attempt to
 * avoid copying the untouched regions. `patch.start`/`patch.end` index
 * `bytes` directly; the caller is responsible for them already being valid
 * (in range, on the boundaries the caller cares about) — this function
 * does not re-derive them.
 *
 * The dev-only check below exists because `subarray` itself won't catch a
 * bad range — negative indices count from the end, and out-of-range ones
 * clamp — so an inverted or out-of-bounds patch would otherwise splice
 * silently-wrong bytes instead of failing. `createEdit`'s own callers
 * don't construct `start`/`end` yet (no editing UI exists — F9), so
 * nothing can trigger this today; it's here for the first one that can.
 */
export function applyPatch(bytes: Uint8Array, patch: Patch): Uint8Array {
  if (
    import.meta.env?.DEV &&
    (patch.start < 0 || patch.end < patch.start || patch.end > bytes.length)
  ) {
    throw new Error(
      `applyPatch: invalid range [${patch.start}, ${patch.end}) over ${bytes.length} bytes`
    )
  }
  const before = bytes.subarray(0, patch.start)
  const after = bytes.subarray(patch.end)
  const result = new Uint8Array(before.length + patch.replacement.length + after.length)
  result.set(before, 0)
  result.set(patch.replacement, before.length)
  result.set(after, before.length + patch.replacement.length)
  return result
}

/**
 * R108 (`R108-replace-all-quadratic.md` §3): a batch of patches applied as
 * a **single** ascending pass, not one `applyPatch` call per patch. Calling
 * `applyPatch` in a loop is O(document × patches) — it allocates a whole
 * new `Uint8Array` of the entire document on every call, and a Replace All
 * with tens of thousands of matches was measured taking minutes because of
 * it (`docs/FINDINGS.md`). Every patch's offsets not overlapping and
 * already being in `bytes`' own coordinates is what makes a single pass
 * correct: the total output length is knowable up front (the input length
 * plus every patch's length delta), so the whole result can be allocated
 * once and filled by alternating untouched gap and replacement.
 *
 * **Precondition, checked under `import.meta.env?.DEV` and not otherwise**:
 * `patches` must be sorted ascending by `start` and non-overlapping, with
 * every `start`/`end` already valid against `bytes` as given — *not*
 * against some other buffer, and *not* sequentially valid the way undo's
 * own inverses are (`rebaseSequentialPatches` below exists for exactly
 * that case, converting a sequential list into this shape first). Feeding
 * a sequential list to this function unchecked doesn't reliably throw: a
 * replacement shorter than what it replaces can silently splice the wrong
 * bytes instead of raising a range error.
 */
export function applyPatchesAscending(bytes: Uint8Array, patches: readonly Patch[]): Uint8Array {
  if (import.meta.env?.DEV) {
    let previousEnd = 0
    for (const patch of patches) {
      if (patch.start < previousEnd || patch.end < patch.start || patch.end > bytes.length) {
        throw new Error(
          `applyPatchesAscending: invalid or out-of-order range [${patch.start}, ${patch.end}) over ${bytes.length} bytes`
        )
      }
      previousEnd = patch.end
    }
  }
  let outLength = bytes.length
  for (const patch of patches) outLength += patch.replacement.length - (patch.end - patch.start)

  const out = new Uint8Array(outLength)
  let read = 0
  let write = 0
  for (const patch of patches) {
    const gap = bytes.subarray(read, patch.start)
    out.set(gap, write)
    write += gap.length
    out.set(patch.replacement, write)
    write += patch.replacement.length
    read = patch.end
  }
  out.set(bytes.subarray(read), write)
  return out
}

/**
 * R109 (`R108-replace-all-quadratic.md` §4): converts a **sequentially**
 * valid ascending patch list — where patch *i*'s `start`/`end` are only
 * correct once patches `0…i-1` have already been applied to *that same*
 * list's own target buffer, exactly how undo's own inverses work — into
 * one that's valid all at once, against that same target buffer, which is
 * what `applyPatchesAscending` requires. Each patch is shifted left by the
 * running total of how much every earlier patch has already changed the
 * length by; a patch whose replacement is shorter than its original span
 * needs a *smaller* shift for everything after it, which is exactly why
 * this can't be skipped for a shrinking replace and only happen to work
 * for a growing one (or vice versa) — verified by round-tripping a real
 * replace-then-undo, not inferred: feeding a sequential list to
 * `applyPatchesAscending` unrebased threw on the first trial input, and a
 * different patch shape would have written silently wrong bytes instead.
 *
 * **Only sound for a list whose items were built as one batch against a
 * single baseline** (a Replace All's per-match inverses) — never for an
 * incrementally-recorded list (an ordinary typing burst's), where the same
 * byte range can be touched more than once. See `UndoEntry.independent`'s
 * own doc comment (`undoStack.ts`) for the failure this restriction avoids
 * (confirmed by a real, previously-failing test, not just reasoned about).
 */
export function rebaseSequentialPatches(patches: readonly Patch[]): Patch[] {
  const out: Patch[] = []
  let shift = 0
  for (const patch of patches) {
    out.push({
      start: patch.start - shift,
      end: patch.end - shift,
      replacement: patch.replacement
    })
    shift += patch.replacement.length - (patch.end - patch.start)
  }
  return out
}

/**
 * `null` means "cannot round-trip this text into this encoding" — refuse
 * the edit, per §5.5/D-009. A thin pass-through to `core/textEncode.ts`'s
 * `encodeText` (R125): UTF-8 and UTF-16 (either byte order) are always
 * lossless, and every single-byte code page (windows-1252, iso-8859-1/15,
 * …) round-trips unless `text` itself contains a character it can't
 * represent. A genuinely multi-byte non-UTF encoding (shift_jis, …) still
 * returns `null` unconditionally — `canEncode`/`findUnrepresentableCharacter`
 * are how a caller tells the two `null` cases apart.
 */
export function encodeForRoundTrip(text: string, encoding: string): Uint8Array | null {
  return encodeText(text, encoding)
}

/**
 * The actual entry point: turns a decoded-text edit request into a `Patch`
 * plus the resulting bytes, or a refusal with a reason the caller can show.
 * Does not know about `OpenDocument`/session phase/`readOnly` — those are
 * `documentSession.ts`'s concern, one layer up, since a bare `SourceBuffer`
 * has no notion of any of them.
 */
export function createEdit(buffer: SourceBuffer, request: EditRequest): EditOutcome {
  if (request.start < buffer.bomLength) {
    return refuse({ kind: 'bom' }, "This edit would overwrite the file's byte-order mark.")
  }
  const replacement = encodeForRoundTrip(request.text, buffer.encoding)
  if (replacement === null) {
    if (!canEncode(buffer.encoding)) {
      return refuse(
        { kind: 'unsupported-encoding', encoding: buffer.encoding },
        `Klados can't write ${buffer.encoding} — it isn't a single-byte encoding.`
      )
    }
    const character = findUnrepresentableCharacter(request.text, buffer.encoding) ?? ''
    return refuse(
      { kind: 'unrepresentable-character', encoding: buffer.encoding, character },
      `${buffer.encoding} can't represent "${character}". The rest of the edit was not applied.`
    )
  }
  const patch: Patch = { start: request.start, end: request.end, replacement }
  return { ok: true, patch, bytes: applyPatch(buffer.bytes, patch) }
}

/**
 * R90 (`R86-find-as-query-surface.md` §6): the byte cost a Replace All's
 * own undo entry would add — every match's original span becomes an
 * inverse patch (`end - start` bytes each, the exact size `inversePatchOf`
 * would slice, no need to touch the buffer to know it), plus one forward
 * patch per match at `replacementByteLength` each. Exposed as a pure
 * function, not a `DocumentSession` method: the caller (`FindBar`) needs
 * this *before* asking whether to run at all — §11.2's "a confirmation
 * with a number in it, never a refusal," which means the number has to
 * exist before the confirmation does, not be discovered by attempting the
 * replace and finding out afterward.
 */
export function estimateReplaceAllUndoBytes(
  matches: readonly { readonly start: number; readonly end: number }[],
  replacementByteLength: number
): number {
  let originalBytes = 0
  for (const match of matches) originalBytes += match.end - match.start
  return originalBytes + matches.length * replacementByteLength
}
