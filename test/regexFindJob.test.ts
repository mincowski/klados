/**
 * R239 (`docs/plans/R239-regex-find.md` §2): `runRegexFindJob`'s own logic,
 * against a scripted worker, so each path is deterministic. The real worker is
 * exercised by `regexFindJob.test.tsx` (browser project) and by the built-app
 * test in `mainElectron.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import {
  decodedTextMatches,
  decodedWindowsFor,
  findAll,
  type TextFindOptions
} from '../src/core/textFind'
import {
  liveRegexFindWorkers,
  runRegexFindJob,
  type RegexFindWorker
} from '../src/renderer/session/regexFindJob'
import type { RegexFindRequest, RegexFindResponse } from '../src/worker/regexFind.worker'

const OPTIONS: TextFindOptions = { caseSensitive: true, regex: true }

/** A worker that loads for `loadMs` once the job listens, then says `ready`,
 * as a real one does once its module has loaded. Like a real one, it holds a
 * message posted while loading until it has loaded. It answers each window on
 * a later task, except for the windows `stuckFrom` and later, which it never
 * answers. */
class ScriptedWorker implements RegexFindWorker {
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly received: RegexFindRequest[] = []
  terminated = false
  private listener: ((event: MessageEvent<RegexFindResponse>) => void) | null = null
  private loaded = false
  private readonly held: RegexFindRequest[] = []

  constructor(
    private readonly stuckFrom = Infinity,
    private readonly loadMs = 0
  ) {}

  get onmessage(): ((event: MessageEvent<RegexFindResponse>) => void) | null {
    return this.listener
  }

  set onmessage(listener: ((event: MessageEvent<RegexFindResponse>) => void) | null) {
    const first = this.listener === null && listener !== null
    this.listener = listener
    if (!first) return
    setTimeout(() => {
      if (this.terminated) return
      this.loaded = true
      for (const message of this.held.splice(0)) this.answer(message)
      this.listener?.({ data: { ready: true } } as unknown as MessageEvent<RegexFindResponse>)
    }, this.loadMs)
  }

  postMessage(message: RegexFindRequest): void {
    this.received.push(message)
    if (this.loaded) this.answer(message)
    else this.held.push(message)
  }

  private answer(message: RegexFindRequest): void {
    if (message.id >= this.stuckFrom) return
    setTimeout(() => {
      if (this.terminated) return
      const data = {
        id: message.id,
        matches: decodedTextMatches(message.text, message.needle, message.options)
      }
      this.onmessage?.({ data } as unknown as MessageEvent<RegexFindResponse>)
    }, 0)
  }

  terminate(): void {
    this.terminated = true
  }
}

/** Three windows' worth of rows, each holding `n1`, `n2`, … */
function threeWindows(): { bytes: Uint8Array; rowIndex: Int32Array; text: string } {
  const text = Array.from({ length: 30_000 }, (_, i) => `n${i}\n`).join('')
  const bytes = new TextEncoder().encode(text)
  return { bytes, rowIndex: buildRowIndex(bytes, DEFAULT_MAX_ROW_BYTES, [0x0a]), text }
}

describe('runRegexFindJob', () => {
  it('returns exactly findAll, one window at a time, and terminates the worker', async () => {
    const { bytes, rowIndex } = threeWindows()
    const worker = new ScriptedWorker()
    const value = await runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n1\\d*7\\b', options: OPTIONS },
      { spawn: () => worker }
    ).result
    const reference = findAll(bytes, rowIndex, 'utf-8', 'n1\\d*7\\b', OPTIONS)
    expect(reference.starts.length).toBeGreaterThan(100)
    expect([...value.starts]).toEqual([...reference.starts])
    expect([...value.ends]).toEqual([...reference.ends])
    expect(value.timedOut).toBe(false)
    expect(worker.received.length).toBeGreaterThan(2)
    expect(worker.received.map((m) => m.id)).toEqual(worker.received.map((_, i) => i))
    expect(worker.terminated).toBe(true)
    expect(liveRegexFindWorkers()).toBe(0)
  })

  it('a worker slower to load than the deadline still searches every window', async () => {
    // The review of 1.3.0: loading counted against the first window's
    // deadline, and a harmless pattern stopped as "No matches (stopped)".
    const { bytes, rowIndex } = threeWindows()
    const worker = new ScriptedWorker(Infinity, 200)
    const value = await runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n\\d+', options: OPTIONS },
      { spawn: () => worker, deadlineMs: 50 }
    ).result
    const reference = findAll(bytes, rowIndex, 'utf-8', 'n\\d+', OPTIONS)
    expect(reference.starts.length).toBeGreaterThan(100)
    expect(value.timedOut).toBe(false)
    expect([...value.starts]).toEqual([...reference.starts])
  })

  it('nothing is posted before the worker says ready', async () => {
    const { bytes, rowIndex } = threeWindows()
    const worker = new ScriptedWorker(Infinity, 100)
    const job = runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n', options: OPTIONS },
      { spawn: () => worker }
    )
    await vi.waitFor(() => expect(liveRegexFindWorkers()).toBe(1))
    expect(worker.received).toHaveLength(0)
    await vi.waitFor(() => expect(worker.received.length).toBeGreaterThan(0))
    job.cancel()
    await job.result.catch(() => {})
  })

  it("on the deadline keeps the earlier windows' matches, marks them, and terminates", async () => {
    const { bytes, rowIndex } = threeWindows()
    // Window 1 is never answered, as if its `exec` never returned.
    const worker = new ScriptedWorker(1)
    const value = await runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n\\d+', options: OPTIONS },
      { spawn: () => worker, deadlineMs: 50 }
    ).result
    expect(value.timedOut).toBe(true)
    // Exactly what window 0 owns: every match before window 1's first row.
    const handoff = rowIndex[decodedWindowsFor(rowIndex)[1]!.startRow]!
    const owned = findAll(bytes, rowIndex, 'utf-8', 'n\\d+', OPTIONS).starts.filter(
      (start) => start < handoff
    )
    expect(owned.length).toBeGreaterThan(0)
    expect([...value.starts]).toEqual([...owned])
    expect(worker.terminated).toBe(true)
    expect(liveRegexFindWorkers()).toBe(0)
  })

  it('cancelling terminates the worker and rejects with AbortError', async () => {
    const { bytes, rowIndex } = threeWindows()
    const worker = new ScriptedWorker(0)
    const job = runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n', options: OPTIONS },
      { spawn: () => worker }
    )
    const rejected = job.result.catch((reason: unknown) => reason)
    await vi.waitFor(() => expect(worker.received.length).toBe(1))
    expect(liveRegexFindWorkers()).toBe(1)
    job.cancel()
    expect(worker.terminated).toBe(true)
    expect(liveRegexFindWorkers()).toBe(0)
    expect(((await rejected) as DOMException).name).toBe('AbortError')
  })

  it('cancelled before it starts, it never spawns a worker', async () => {
    const { bytes, rowIndex } = threeWindows()
    const spawn = vi.fn(() => new ScriptedWorker())
    const job = runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n', options: OPTIONS },
      { spawn }
    )
    const rejected = job.result.catch((reason: unknown) => reason)
    job.cancel()
    expect(((await rejected) as DOMException).name).toBe('AbortError')
    // The job's start was a task queued behind this one; let it run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a worker error rejects with that error, not AbortError, and terminates it', async () => {
    const { bytes, rowIndex } = threeWindows()
    const worker = new ScriptedWorker(0)
    const job = runRegexFindJob(
      { bytes, rowIndex, encoding: 'utf-8', needle: 'n', options: OPTIONS },
      { spawn: () => worker }
    )
    await vi.waitFor(() => expect(worker.received.length).toBe(1))
    worker.onerror?.({ message: 'boom' } as unknown as ErrorEvent)
    await expect(job.result).rejects.toThrow('Regex search worker failed: boom')
    expect(worker.terminated).toBe(true)
    expect(liveRegexFindWorkers()).toBe(0)
  })

  it('an empty document finishes without a worker', async () => {
    const spawn = vi.fn(() => new ScriptedWorker())
    const value = await runRegexFindJob(
      {
        bytes: new Uint8Array(0),
        rowIndex: new Int32Array(0),
        encoding: 'utf-8',
        needle: 'n',
        options: OPTIONS
      },
      { spawn }
    ).result
    expect(value.starts.length).toBe(0)
    expect(value.timedOut).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })
})
