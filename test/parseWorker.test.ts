import { afterEach, describe, expect, it, vi } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import {
  runParseFromUrlJob,
  runParseJob,
  runTransformJob,
  transferablesFor,
  type ParseJobRequest,
  type TransformJobRequest
} from '../src/worker/parse.worker'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

// TextEncoder#encode never actually returns a SharedArrayBuffer-backed view,
// but Uint8Array#buffer is typed ArrayBufferLike to allow for one.
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer as ArrayBuffer
}

/**
 * `runParseJob` is the whole worker job as a plain function (see
 * parse.worker.ts's own doc comment on why): it can be exercised directly
 * here, in Vitest's default Node environment. What genuinely cannot be
 * verified without a real Worker + requestAnimationFrame in an Electron
 * renderer — main-thread responsiveness during a 200 MB parse — is recorded
 * as unverified in M0-RESULTS.md rather than faked here.
 */
describe('runParseJob', () => {
  it('parses a JSON buffer and reports the same shape as a direct parse', () => {
    const text = '{"a":1,"b":[1,2,3]}'
    const bytes = utf8(text)
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 1,
      bytes: bufferOf(bytes),
      filename: 'x.json'
    }

    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)

    expect(response.formatId).toBe('json')
    expect(response.complete).toBe(true)

    const direct = new NodeStore(bytes, new Interner())
    const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
    jsonFormatModule.parse(bytes, direct, options)
    expect(response.storeBuffers.nodeCount).toBe(direct.nodeCount)
  })

  it('parses an XML buffer via extension-based format selection', () => {
    const bytes = utf8('<a><b/></a>')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 2,
      bytes: bufferOf(bytes),
      filename: 'x.xml'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.formatId).toBe('xml')
  })

  it('returns an error message when no format matches', () => {
    const bytes = utf8('just plain text')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 3,
      bytes: bufferOf(bytes),
      filename: 'x.txt'
    }
    const response = runParseJob(request, () => {})
    expect(response.type).toBe('error')
  })

  it('transfers the source buffer back — bytes are not left empty', () => {
    const bytes = utf8('{"a":1}')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 4,
      bytes: bufferOf(bytes),
      filename: 'x.json'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.bytes.byteLength).toBe(bytes.byteLength)
  })

  it('reports progress at ~1 MB intervals for a large document', () => {
    const bigArray = '[' + Array.from({ length: 200_000 }, (_, i) => i).join(',') + ']'
    const bytes = utf8(bigArray)
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024)

    const progressCalls: number[] = []
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 5,
      bytes: bufferOf(bytes),
      filename: 'x.json'
    }
    const response = runParseJob(request, (bytesConsumed) => progressCalls.push(bytesConsumed))

    expect(response.type).toBe('done')
    expect(progressCalls.length).toBeGreaterThan(0)
    // Monotonically increasing — each call reflects further progress, not a replay.
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i]!).toBeGreaterThan(progressCalls[i - 1]!)
    }
  })

  it('the exported node store can be rehydrated into a working NodeStore', () => {
    const bytes = utf8('{"a":{"b":2}}')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 6,
      bytes: bufferOf(bytes),
      filename: 'x.json'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)

    const interner = Interner.fromBuffers(
      response.internerBuffers.nameBytes,
      response.internerBuffers.starts,
      response.internerBuffers.ends
    )
    const store = NodeStore.fromBuffers(
      new Uint8Array(response.bytes),
      interner,
      response.storeBuffers
    )
    expect(store.nodeCount).toBe(response.storeBuffers.nodeCount)
    const object = store.firstChildOf(0)
    const propA = store.firstChildOf(object)
    expect(store.nameOf(propA)).toBe('a')
  })

  // D0.1: previously only `bytes` and `rowIndex.buffer` were transferred,
  // and structured clone copied the fifteen `storeBuffers` arrays and three
  // `internerBuffers` arrays — 257.3 MB on a 200 MB fixture.
  it('D0.1 — every store and interner array is included in the transfer list', () => {
    const bytes = utf8('{"a":{"b":2,"c":[1,2,3]}}')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 7,
      bytes: bufferOf(bytes),
      filename: 'x.json'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)

    const transferables = transferablesFor(response)

    const expectedBuffers = new Set<ArrayBufferLike>([
      response.bytes,
      response.rowIndex.buffer,
      response.lineIndex.checkpoints.buffer,
      response.nameIndex.starts.buffer,
      response.nameIndex.nodes.buffer
    ])
    for (const value of Object.values(response.storeBuffers)) {
      if (ArrayBuffer.isView(value)) expectedBuffers.add(value.buffer)
    }
    for (const value of Object.values(response.internerBuffers)) {
      if (ArrayBuffer.isView(value)) expectedBuffers.add(value.buffer)
    }

    // Every array-backed field contributed a distinct buffer (each is a
    // `.slice()` product per D0.1, so none should be aliased), and nothing
    // extra or missing made it into the transfer list.
    expect(expectedBuffers.size).toBeGreaterThan(2)
    expect(new Set(transferables)).toEqual(expectedBuffers)
    expect(transferables.length).toBe(expectedBuffers.size)
  })

  // D0.2 — a declared encoding TextDecoder can't construct must not reach
  // the main thread, or SourceBuffer's constructor throws after the
  // promise has settled and the app hangs forever.
  it('D0.2 — an unrecognized declared encoding falls back to utf-8 with a Warning diagnostic', () => {
    const bytes = utf8('<?xml version="1.0" encoding="NONSENSE"?><a/>')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 8,
      bytes: bufferOf(bytes),
      filename: 'x.xml'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)

    expect(response.encoding).toBe('utf-8')
    expect(response.complete).toBe(true)
    const warning = response.diagnostics.find((d) => d.code === 'klados.encoding.unrecognized')
    expect(warning).toBeDefined()
    expect(warning!.severity).toBe(0) // Severity.Warning
    // `new TextDecoder(response.encoding)` must now succeed unconditionally —
    // this is exactly the construction that used to throw on the main thread.
    expect(() => new TextDecoder(response.encoding)).not.toThrow()
  })

  it('D0.2 — a recognized declared encoding is untouched and carries no warning', () => {
    const bytes = utf8('<?xml version="1.0" encoding="ISO-8859-1"?><a/>')
    const request: ParseJobRequest = {
      type: 'parse',
      requestId: 9,
      bytes: bufferOf(bytes),
      filename: 'x.xml'
    }
    const response = runParseJob(request, () => {})
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.encoding).toBe('ISO-8859-1')
    expect(
      response.diagnostics.find((d) => d.code === 'klados.encoding.unrecognized')
    ).toBeUndefined()
  })
})

// M5-PLAN.md H4 — the worker side of the chunked Transform write path.
describe('runTransformJob', () => {
  it('formats via the worker seam and returns a byte-length-exact ArrayBuffer', () => {
    const bytes = utf8('{"a":1,"b":2}')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'json',
      options: { indent: '  ', newline: '\n' }
    }
    const response = runTransformJob(request)
    if (response.type !== 'transformDone')
      throw new Error(`expected transformDone, got ${response.type}`)
    if (response.bytes === null) throw new Error('expected bytes, got unchanged')
    expect(response.bytes.byteLength).toBe(new Uint8Array(response.bytes).byteLength)
    expect(new TextDecoder().decode(response.bytes)).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
  })

  it('minifies when indent is empty', () => {
    const bytes = utf8('{ "a" : 1 }')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'json',
      options: { indent: '', newline: '\n' }
    }
    const response = runTransformJob(request)
    if (response.type !== 'transformDone')
      throw new Error(`expected transformDone, got ${response.type}`)
    if (response.bytes === null) throw new Error('expected bytes, got unchanged')
    expect(new TextDecoder().decode(response.bytes)).toBe('{"a":1}')
  })

  // M5e-PLAN.md R11 reopens D-045: XML now has a `format()`, so this no
  // longer belongs on the "no format() implementation" list — it belongs
  // on the "formats successfully" list, same shape as JSON's own case
  // above.
  it('formats an XML buffer through the same worker path as JSON', () => {
    const bytes = utf8('<root><a/></root>')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'xml',
      options: { indent: '  ', newline: '\n' }
    }
    const response = runTransformJob(request)
    if (response.type !== 'transformDone')
      throw new Error(`expected transformDone, got ${response.type}`)
    if (response.bytes === null) throw new Error('expected bytes, got unchanged')
    expect(new TextDecoder().decode(response.bytes)).toBe('<root>\n  <a/>\n</root>\n')
  })

  // M5g-PLAN.md O1: the worker itself detects a no-op format() and signals
  // it via `unchanged`/`bytes: null` rather than transferring the result
  // back for the renderer to discover it matches.
  it('signals unchanged, with no bytes, when format() is a no-op', () => {
    const bytes = utf8('<a>\n  <b/>\n</a>\n')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'xml',
      options: { indent: '  ', newline: '\n' }
    }
    const response = runTransformJob(request)
    if (response.type !== 'transformDone')
      throw new Error(`expected transformDone, got ${response.type}`)
    expect(response.unchanged).toBe(true)
    expect(response.bytes).toBeNull()
  })

  it('signals a real change (not unchanged) when formatting actually rewrites the document', () => {
    const bytes = utf8('<a><b/></a>')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'xml',
      options: { indent: '  ', newline: '\n' }
    }
    const response = runTransformJob(request)
    if (response.type !== 'transformDone')
      throw new Error(`expected transformDone, got ${response.type}`)
    expect(response.unchanged).toBe(false)
    expect(response.bytes).not.toBeNull()
  })

  // The no-op comparison uses a BigUint64Array word compare with a
  // byte-wise tail for `length % 8 !== 0` (M5g-PLAN.md O1) — exercised here
  // at every remainder 0..7 via an already-minimal `<a>{filler}</a>` (no
  // insignificant whitespace, so minify reproduces it byte-identical), so
  // the tail path is covered at each possible tail length, not just the
  // aligned case.
  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'detects an unchanged no-op at byte-length remainder mod 8 = %i',
    (remainder) => {
      // format() always appends a trailing newline (M5g-PLAN.md §1.3), so
      // the no-op input must already have one. '<a></a>\n' is 8 bytes; pad
      // the filler so total length hits the target remainder exactly.
      const fillerLength = (remainder - 8 + 8) % 8
      const already = `<a>${'x'.repeat(fillerLength)}</a>\n`
      expect(already.length % 8).toBe(remainder)

      const request: TransformJobRequest = {
        type: 'transform',
        requestId: 1,
        bytes: bufferOf(utf8(already)),
        formatId: 'xml',
        options: { indent: '', newline: '\n' }
      }
      const response = runTransformJob(request)
      if (response.type !== 'transformDone')
        throw new Error(`expected transformDone, got ${response.type}`)
      expect(response.unchanged).toBe(true)
      expect(response.bytes).toBeNull()
    }
  )

  it('errors cleanly for an unknown formatId', () => {
    const bytes = utf8('x')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'nonexistent',
      options: { indent: '  ', newline: '\n' }
    }
    const response = runTransformJob(request)
    expect(response.type).toBe('transformError')
  })

  // M5h-PLAN.md R18, §2c: a formatter bug must surface as an ordinary
  // `transformError` with a real message, not escape as an uncaught
  // exception that `self.onmessage`'s own try/catch never gets to see
  // because `runTransformJob` threw synchronously before returning.
  it('a format() that throws is caught and returned as transformError, not left to escape', () => {
    const bytes = utf8('<root><a/></root>')
    const request: TransformJobRequest = {
      type: 'transform',
      requestId: 1,
      bytes: bufferOf(bytes),
      formatId: 'xml',
      options: { indent: '  ', newline: '\n' }
    }
    const utf16Bytes = new Uint8Array([0xff, 0xfe, ...new Uint8Array(request.bytes)])
    const throwingRequest: TransformJobRequest = {
      ...request,
      bytes: bufferOf(utf16Bytes)
    }
    const response = runTransformJob(throwingRequest)
    expect(response.type).toBe('transformError')
    if (response.type === 'transformError') {
      expect(response.requestId).toBe(1)
      expect(response.message.length).toBeGreaterThan(0)
    }
  })
})

// M5-PLAN.md H12 — the production route H11's spike (D-047) measured.
describe('runParseFromUrlJob', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches the URL and parses the result exactly like a ParseJobRequest', async () => {
    const bytes = utf8('{"a":1,"b":[1,2,3]}')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(bufferOf(bytes), { status: 200 })) as unknown as typeof fetch

    const response = await runParseFromUrlJob(
      { type: 'parseFromUrl', requestId: 1, url: 'klados-file://faketoken/', filename: 'x.json' },
      () => {}
    )
    if (response.type !== 'done') throw new Error(`expected done, got ${response.type}`)
    expect(response.formatId).toBe('json')
    expect(response.complete).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith('klados-file://faketoken/')
  })

  it('errors cleanly on a non-ok HTTP response (e.g. an already-consumed or expired token)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Not found', { status: 404 })) as unknown as typeof fetch

    const response = await runParseFromUrlJob(
      { type: 'parseFromUrl', requestId: 1, url: 'klados-file://gone/', filename: 'x.json' },
      () => {}
    )
    expect(response.type).toBe('error')
  })

  it('errors cleanly when fetch itself rejects', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network-ish failure')) as unknown as typeof fetch

    const response = await runParseFromUrlJob(
      { type: 'parseFromUrl', requestId: 1, url: 'klados-file://x/', filename: 'x.json' },
      () => {}
    )
    expect(response.type).toBe('error')
    if (response.type === 'error') expect(response.message).toContain('network-ish failure')
  })
})

describe('the self.onmessage registration guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  /** Regression for the bug D-036's review found: `self.postMessage` being
   * a function does not mean `self` is a `WorkerGlobalScope` — it's true
   * of `window` too (cross-frame messaging), so a stray *value* import of
   * this module from a renderer would silently hijack `window.onmessage`.
   * Simulates exactly that renderer-like global (a `self`/`postMessage`
   * pair with no `WorkerGlobalScope`) and confirms the module's own
   * top-level registration does not fire. */
  it('does not register onmessage when self is not a real WorkerGlobalScope', async () => {
    const fakeSelf = { postMessage: vi.fn() }
    vi.stubGlobal('self', fakeSelf)
    // No `WorkerGlobalScope` stubbed at all — the point of the test.
    vi.resetModules()

    await import('../src/worker/parse.worker')

    expect((fakeSelf as { onmessage?: unknown }).onmessage).toBeUndefined()
  })

  it('does register onmessage when self genuinely is a WorkerGlobalScope', async () => {
    class FakeWorkerGlobalScope {
      postMessage = vi.fn()
      onmessage: unknown
    }
    const fakeSelf = new FakeWorkerGlobalScope()
    vi.stubGlobal('WorkerGlobalScope', FakeWorkerGlobalScope)
    vi.stubGlobal('self', fakeSelf)
    vi.resetModules()

    await import('../src/worker/parse.worker')

    expect(fakeSelf.onmessage).toBeTypeOf('function')
  })
})
