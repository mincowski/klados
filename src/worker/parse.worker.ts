/// <reference lib="webworker" />
/**
 * Runs in a Web Worker so the UI thread never blocks (CONCEPT.md §3.4).
 * `runParseJob` is the whole job as a plain function, deliberately decoupled
 * from `self`/`postMessage` — that's what lets it be unit-tested directly in
 * Vitest's Node environment. The `self.onmessage` wiring below it is the
 * only part that actually needs a Worker context, and is exercised only by
 * an Electron-hosted harness (B11's own carve-out: Vitest's default
 * environment has neither a real `Worker` nor `requestAnimationFrame`).
 */
import { bomLengthAt, detectEncoding } from '../core/encoding'
import { Interner } from '../core/interner'
import { buildNameIndex, type NameIndex } from '../core/nameIndex'
import {
  NodeStore,
  type NamespaceResolutionBuffers,
  type NodeStoreBuffers
} from '../core/nodeStore'
import { DEFAULT_MAX_DEPTH } from '../core/parseDefaults'
import {
  buildLineIndex,
  buildRowIndex,
  DEFAULT_MAX_ROW_BYTES,
  type LineIndex
} from '../core/rowIndex'
import type { Diagnostic, FormatOptions, ParseOptions } from '../core/types'
import { Severity } from '../core/types'
import { getFormatModule, selectFormat, supportedExtensionsList } from '../formats/registry'

const HEAD_BYTES = 4096

export interface ParseJobRequest {
  readonly type: 'parse'
  readonly requestId: number
  readonly bytes: ArrayBuffer
  readonly filename: string | null
  readonly maxDepth?: number
}

export interface CancelRequest {
  readonly type: 'cancel'
  readonly requestId: number
}

/**
 * M5-PLAN.md H4 — a Transform, run in the worker on this same seam. `format`
 * always receives the whole current buffer and always returns the whole
 * new one (`FormatModule.format`'s own contract, `core/types.ts`, not to be
 * modified) — "chunked" here means off the main thread and built through a
 * growable byte buffer rather than a JS string (`GrowableBytes`,
 * `formats/json/index.ts`'s `format`), not sliced into scheduler ticks the
 * way a splice's graft is (H2d): the contract has no resumable shape to
 * chunk into.
 */
export interface TransformJobRequest {
  readonly type: 'transform'
  readonly requestId: number
  readonly bytes: ArrayBuffer
  readonly formatId: string
  readonly options: FormatOptions
}

/**
 * M5-PLAN.md H12 — the production route H11's spike measured (D-047): the
 * worker fetches the document itself, over the token-scoped custom
 * protocol `main/documents.ts` registers, instead of receiving `bytes`
 * already transferred from the renderer's main thread. Everything past the
 * fetch is identical to `ParseJobRequest`'s own path — `runParseFromUrlJob`
 * fetches, then hands the result straight to `runParseJob`, which is why
 * this doesn't duplicate a single line of parse logic.
 */
export interface ParseFromUrlJobRequest {
  readonly type: 'parseFromUrl'
  readonly requestId: number
  readonly url: string
  readonly filename: string | null
  readonly maxDepth?: number
}

export type WorkerRequest =
  ParseJobRequest | CancelRequest | TransformJobRequest | ParseFromUrlJobRequest

export interface ProgressMessage {
  readonly type: 'progress'
  readonly requestId: number
  readonly bytesConsumed: number
}

export interface ParseDoneMessage {
  readonly type: 'done'
  readonly requestId: number
  /** Transferred back — a transfer detaches the sender's copy, and the main
   * thread needs these bytes for the Raw View's window and for Save. */
  readonly bytes: ArrayBuffer
  readonly storeBuffers: NodeStoreBuffers
  readonly internerBuffers: { nameBytes: Uint8Array; starts: Int32Array; ends: Int32Array }
  readonly rowIndex: Int32Array
  /** Sparse rank structure over `rowIndex`, so line numbers are exact rather
   * than "row number, near enough" — see `rowIndex.ts`'s own note. */
  readonly lineIndex: LineIndex
  /** M4-PLAN.md G1: `nameId → node refs`, built once here (two passes over
   * the freshly-parsed store) rather than lazily by the first consumer —
   * this is the one place a store and its interner are both guaranteed to
   * be in their final, post-parse state. */
  readonly nameIndex: NameIndex
  readonly diagnostics: readonly Diagnostic[]
  readonly complete: boolean
  readonly bytesConsumed: number
  readonly formatId: string
  readonly encoding: string
  readonly bomLength: number
  /** `format.capabilities.hasNamespaces` — threaded through rather than
   * re-derived from `formatId` on the main thread (invariant 8: namespace
   * resolution is driven by the capability, never by testing a format id).
   * `Interner.fromBuffers` needs it to know whether to recompute the
   * prefix/local split (R134) after reconstruction. */
  readonly hasNamespaces: boolean
  /** `store.exportNamespaceState()` — without this, the main-thread store
   * `rehydrateParseResult` builds would have empty namespace state (a
   * freshly constructed store's default), and `resolvedNameIdOf` would
   * silently fall back to the raw `nameIdOf` for every query even on a
   * document that genuinely declares namespaces — found in review, not by
   * a failing test, since every namespace test up to that point constructed
   * its `NodeStore` directly rather than through this round trip. */
  readonly namespaceState: NamespaceResolutionBuffers
}

export interface ParseErrorMessage {
  readonly type: 'error'
  readonly requestId: number
  readonly message: string
}

export interface TransformDoneMessage {
  readonly type: 'transformDone'
  readonly requestId: number
  /** M5g-PLAN.md O1: `true` when `format()`'s output was byte-identical to
   * its input — the worker already holds both copies, so it checks here
   * rather than transferring the (possibly 100s of MB) result back only for
   * the renderer to discover it matches what it already has. `bytes` is
   * `null` in that case: there is nothing new to transfer. */
  readonly unchanged: boolean
  /** Transferred back — the whole new buffer, byte-length-exact (never an
   * oversized, still-growing `GrowableBytes` backing array; see
   * `runTransformJob`'s own guard, the same shape `main/documents.ts`'s
   * H2c fix uses for the same reason). `null` iff `unchanged`. */
  readonly bytes: ArrayBuffer | null
}

export interface TransformErrorMessage {
  readonly type: 'transformError'
  readonly requestId: number
  readonly message: string
}

export type WorkerResponse =
  | ProgressMessage
  | ParseDoneMessage
  | ParseErrorMessage
  | TransformDoneMessage
  | TransformErrorMessage

const abortControllers = new Map<number, AbortController>()

/**
 * The parse itself, transport-agnostic. `postProgress` is injected so the
 * real worker can call `postMessage` while tests can just collect calls.
 */
export function runParseJob(
  request: ParseJobRequest,
  postProgress: (bytesConsumed: number) => void
): ParseDoneMessage | ParseErrorMessage {
  const bytes = new Uint8Array(request.bytes)
  const head = bytes.subarray(0, Math.min(HEAD_BYTES, bytes.length))
  const format = selectFormat(head, request.filename)
  if (format === null) {
    return {
      type: 'error',
      requestId: request.requestId,
      message:
        `Could not detect a format for ${request.filename ?? '(no filename)'}. ` +
        `Supported extensions: ${supportedExtensionsList()}.`
    }
  }

  const controller = new AbortController()
  abortControllers.set(request.requestId, controller)

  const interner = new Interner(undefined, format.capabilities.hasNamespaces)
  // The store receives the parser's calls directly (C4) — the old
  // wrap-every-method-in-an-arrow-function sink cost 21% of parse time on
  // the hottest call site in the program. `progress` is now a constructor
  // hook that also relays to the main thread.
  const store = new NodeStore(bytes, interner, undefined, (bytesConsumed) => {
    postProgress(bytesConsumed)
  })

  // BOM wins over a format's declared encoding (core/encoding.ts); spans
  // stay absolute in the original buffer, so nothing here strips it (C1).
  const declared = format.detectEncoding(head)
  const detected = detectEncoding(head, declared)
  const bomLength = bomLengthAt(head)

  // The label comes from the document's own prolog — untrusted input. A
  // label `TextDecoder` cannot construct (e.g. a typo'd `encoding="..."`)
  // would otherwise reach `SourceBuffer`'s constructor on the main thread
  // and throw there, after the response promise has already settled,
  // hanging the app forever (D0.2). Validate here, where the diagnostic
  // channel already exists, and fall back to utf-8 with a Warning rather
  // than refusing outright — unlike unsupported UTF-16 below, an
  // unrecognized label on otherwise ASCII-compatible bytes usually parses
  // fine anyway.
  let encoding = detected
  try {
    new TextDecoder(encoding)
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    store.diagnostic({
      severity: Severity.Warning,
      code: 'klados.encoding.unrecognized',
      offset: 0,
      length: head.length,
      message: `Unrecognized encoding '${encoding}' — falling back to utf-8`
    })
    encoding = 'utf-8'
  }

  if (encoding.startsWith('utf-16')) {
    // Both parsers are byte-oriented and assume an ASCII-compatible
    // encoding; on UTF-16 input they'd produce a plausible-looking tree
    // from nonsense. Refuse instead of mis-parsing (C1).
    store.diagnostic({
      severity: Severity.Fatal,
      code: 'klados.encoding.unsupported',
      offset: 0,
      length: bytes.length,
      message: `Unsupported encoding '${encoding}' — Klados's parsers are byte-oriented and require an ASCII-compatible encoding`
    })
    abortControllers.delete(request.requestId)
    return {
      type: 'done',
      requestId: request.requestId,
      bytes: bytes.buffer,
      storeBuffers: store.exportBuffers(),
      internerBuffers: interner.exportBuffers(),
      rowIndex: new Int32Array([0]),
      lineIndex: { checkpoints: new Int32Array(1), stride: 1, lineCount: 1 },
      nameIndex: buildNameIndex(store, interner.size),
      diagnostics: store.diagnostics,
      complete: false,
      bytesConsumed: 0,
      formatId: format.capabilities.id,
      encoding,
      bomLength,
      hasNamespaces: format.capabilities.hasNamespaces,
      namespaceState: store.exportNamespaceState()
    }
  }

  const options: ParseOptions = {
    maxDepth: request.maxDepth ?? DEFAULT_MAX_DEPTH,
    encoding,
    signal: controller.signal
  }

  const result = format.parse(bytes, store, options)
  abortControllers.delete(request.requestId)

  const rowIndex = buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, format.capabilities.rowBreakBytes)
  const lineIndex = buildLineIndex(bytes, rowIndex)

  return {
    type: 'done',
    requestId: request.requestId,
    bytes: bytes.buffer,
    storeBuffers: store.exportBuffers(),
    internerBuffers: interner.exportBuffers(),
    rowIndex,
    lineIndex,
    nameIndex: buildNameIndex(store, interner.size),
    diagnostics: store.diagnostics,
    complete: result.complete,
    bytesConsumed: result.bytesConsumed,
    formatId: format.capabilities.id,
    encoding,
    bomLength,
    hasNamespaces: format.capabilities.hasNamespaces,
    namespaceState: store.exportNamespaceState()
  }
}

/**
 * M5-PLAN.md H4. `format.format`'s contract (`core/types.ts`) takes the
 * whole buffer and returns the whole new one — this is the entire chunked
 * write path's "chunking": off the main thread, and built through
 * `GrowableBytes` rather than a JS string inside the formatter itself, not
 * sliced into ticks the way H2d's graft is (there is nothing resumable in
 * `format`'s signature to slice).
 */
/** M5g-PLAN.md O1: a `BigUint64Array` compare, 8 bytes per iteration
 * instead of 1 — ~5× faster than a byte loop on the corpus this was
 * measured against — with a byte-wise tail for the `length % 8` remainder.
 * Both inputs are whole, byte-length-exact buffers (never a `subarray`
 * whose `byteOffset` could misalign the 8-byte view), so no alignment
 * guard is needed beyond that. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  const wordLength = a.length - (a.length % 8)
  const wordsA = new BigUint64Array(a.buffer, a.byteOffset, wordLength / 8)
  const wordsB = new BigUint64Array(b.buffer, b.byteOffset, wordLength / 8)
  for (let i = 0; i < wordsA.length; i++) {
    if (wordsA[i] !== wordsB[i]) return false
  }
  for (let i = wordLength; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function runTransformJob(
  request: TransformJobRequest
): TransformDoneMessage | TransformErrorMessage {
  const format = getFormatModule(request.formatId)
  if (format === undefined || format.format === undefined) {
    return {
      type: 'transformError',
      requestId: request.requestId,
      message: `Formatting is not supported for '${request.formatId}'`
    }
  }
  const bytes = new Uint8Array(request.bytes)
  // M5h-PLAN.md R18, §2c: a defensive boundary, right even once the known
  // XML overflow (§1) is gone — a formatter bug should surface as an
  // ordinary `transformError`, not escape as an uncaught `RangeError` that
  // `worker.onerror` turns into `transformClient.ts`'s generic rejection
  // (no requestId, no real message, nothing `applyTransform` can act on).
  let output: Uint8Array
  try {
    output = format.format(bytes, request.options)
  } catch (error) {
    return {
      type: 'transformError',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error)
    }
  }

  // M5g-PLAN.md O1: `format()` on an already-canonical document returns
  // its input back byte-identical — the reported sluggishness with "no
  // visible change" was exactly this case. Detected here, not after the
  // transfer, so a no-op skips shipping the (possibly 100s of MB) result
  // back to the renderer entirely.
  if (bytesEqual(bytes, output)) {
    return { type: 'transformDone', requestId: request.requestId, unchanged: true, bytes: null }
  }

  // `GrowableBytes.toArray()` returns a `subarray` (no copy) when the
  // backing array is already close to the right size — a view whose own
  // `.buffer` can still be larger than the view itself. Transferring that
  // buffer wholesale would hand the renderer trailing garbage bytes past
  // `output.byteLength`, the exact hazard H2c's `document:read` fix guards
  // against for the same reason; guard it here too rather than assume
  // `format`'s output is always already exact.
  const exact = (
    output.byteOffset === 0 && output.byteLength === output.buffer.byteLength
      ? output.buffer
      : output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
  ) as ArrayBuffer
  return { type: 'transformDone', requestId: request.requestId, unchanged: false, bytes: exact }
}

/**
 * M5-PLAN.md H12. Fetches the document over the token-scoped custom
 * protocol, then delegates to `runParseJob` exactly as `ParseJobRequest`'s
 * own path would — no parse logic duplicated. A fetch failure (a token
 * that's already been consumed, expired, or whose file vanished between
 * mint and fetch) surfaces as an ordinary `ParseErrorMessage`, the same
 * shape `runParseJob`'s own unrecognized-format case already produces —
 * `parseClient.ts`'s caller doesn't need to know this path can fail one
 * step earlier than the other.
 */
export async function runParseFromUrlJob(
  request: ParseFromUrlJobRequest,
  postProgress: (bytesConsumed: number) => void
): Promise<ParseDoneMessage | ParseErrorMessage> {
  let bytes: ArrayBuffer
  try {
    const response = await fetch(request.url)
    if (!response.ok) {
      return {
        type: 'error',
        requestId: request.requestId,
        message: `Could not read the document (HTTP ${response.status})`
      }
    }
    bytes = await response.arrayBuffer()
  } catch (err) {
    return {
      type: 'error',
      requestId: request.requestId,
      message: err instanceof Error ? err.message : String(err)
    }
  }
  return runParseJob(
    {
      type: 'parse',
      requestId: request.requestId,
      bytes,
      filename: request.filename,
      maxDepth: request.maxDepth
    },
    postProgress
  )
}

/** `parseFromUrl` is deliberately not handled here — it's async (a `fetch`),
 * and this function's callers treat it as synchronous. `self.onmessage`
 * below branches on that request type before ever calling this. */
function handleMessage(
  message: ParseJobRequest | CancelRequest | TransformJobRequest
): WorkerResponse | null {
  if (message.type === 'cancel') {
    abortControllers.get(message.requestId)?.abort()
    return null
  }
  if (message.type === 'transform') {
    return runTransformJob(message)
  }
  return runParseJob(message, (bytesConsumed) => {
    postMessage({
      type: 'progress',
      requestId: message.requestId,
      bytesConsumed
    } satisfies ProgressMessage)
  })
}

/**
 * Every array in `storeBuffers`/`internerBuffers` is a `.slice()` product
 * owning its own `ArrayBuffer` (see `NodeStore.exportBuffers` and
 * `Interner.exportBuffers`), so none are aliased or duplicated and all are
 * safe to transfer. Without this list, structured clone copies 257.3 MB on
 * every parse (D0.1).
 */
export function transferablesFor(response: ParseDoneMessage): Transferable[] {
  const transferables: Transferable[] = [
    response.bytes,
    response.rowIndex.buffer,
    response.lineIndex.checkpoints.buffer,
    response.nameIndex.starts.buffer,
    response.nameIndex.nodes.buffer
  ]
  for (const value of Object.values(response.storeBuffers)) {
    if (ArrayBuffer.isView(value)) transferables.push(value.buffer)
  }
  for (const value of Object.values(response.internerBuffers)) {
    if (ArrayBuffer.isView(value)) transferables.push(value.buffer)
  }
  return transferables
}

// `typeof self.postMessage === 'function'` alone does not actually
// distinguish a `WorkerGlobalScope` from a `Window` — `self === window` in
// every renderer, and `window.postMessage` is a real function there too
// (cross-frame messaging). A stray *value* import of this module from the
// renderer (this file is meant to be `import type`-only outside a worker,
// per `parseClient.ts`'s own convention) would otherwise silently hijack
// `window.onmessage` — a real bug this exact guard failed to catch until
// D-036's `documentSession.ts` wiring briefly did exactly that (fixed by
// moving the one plain constant it needed to `core/parseDefaults.ts`
// instead). `WorkerGlobalScope` is the actual discriminator: it exists
// only inside a genuine worker context.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
    // M5-PLAN.md H12: the one genuinely async request type — routed before
    // `handleMessage` (which every other request type still goes through
    // synchronously) rather than making that function async for everyone.
    if (event.data.type === 'parseFromUrl') {
      const request = event.data
      void runParseFromUrlJob(request, (bytesConsumed) => {
        postMessage({
          type: 'progress',
          requestId: request.requestId,
          bytesConsumed
        } satisfies ProgressMessage)
      }).then(
        (response) => {
          const transferables = response.type === 'done' ? transferablesFor(response) : []
          postMessage(response, transferables)
        },
        (err: unknown) => {
          postMessage({
            type: 'error',
            requestId: request.requestId,
            message: err instanceof Error ? err.message : String(err)
          } satisfies ParseErrorMessage)
        }
      )
      return
    }

    try {
      const response = handleMessage(event.data)
      if (response === null) return
      const transferables =
        response.type === 'done'
          ? transferablesFor(response)
          : response.type === 'transformDone' && response.bytes !== null
            ? [response.bytes]
            : []
      postMessage(response, transferables)
    } catch (err) {
      // D0.2: any throw in this handler must still reach the main thread as
      // an error message rather than leaving `parseClient`'s promise
      // unsettled — the specific way this happened (an unrecognized
      // encoding label) is fixed at the source in `runParseJob`, but this is
      // the backstop for the whole class of bug.
      postMessage({
        type: 'error',
        requestId: event.data.requestId,
        message: err instanceof Error ? err.message : String(err)
      } satisfies ParseErrorMessage)
    }
  }
}
