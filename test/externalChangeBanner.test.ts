/**
 * R169 (`docs/plans/R169-external-change-reload.md`) — the external-change
 * banner while the reload it offered is actually running.
 *
 * **The reported symptom was that "Reload and Discard" looked like a dead
 * button.** A reload never leaves `phase: 'ready'` — it aborts the in-flight
 * work, awaits a read and a parse, and swaps the document in one `setState` at
 * the end — so nothing on screen moved between the click and the parse
 * completing. The banner was the most visible part of that: derived from
 * `externalChangeDetected`, which only clears when the reload commits, it sat
 * there unchanged and insisted nothing had happened.
 *
 * `derivedNotifications` is a pure function of the session state, which is why
 * this is asserted here rather than through a mounted component: the decision
 * being tested is *what the banner says*, and that is entirely this function's.
 * The session-side half — that `reloadPending` goes up before the first await
 * and that Keep Mine can revoke a reload — lives in `documentSession.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import type { DocumentSessionState, OpenDocument } from '../src/renderer/session/documentSession'
import { derivedNotifications } from '../src/renderer/notifications/derivedNotifications'
import { getCommand } from '../src/renderer/commands/registry'
import {
  getPushedNotifications,
  resetNotificationsForTests
} from '../src/renderer/notifications/notificationStore'
import { getContext } from '../src/renderer/commands/context'
import type { AppContext } from '../src/renderer/commands/registry'
import type { DocumentSession } from '../src/renderer/session/documentSession'
import '../src/renderer/notifications/commands'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function openDocumentFor(overrides: Partial<OpenDocument> = {}): OpenDocument {
  // Deliberately *not* minified and with nothing else pending, so the only
  // notification this fixture can produce is the one under test.
  const text = '{\n  "a": 1,\n  "b": 2\n}\n'
  const source = new TextEncoder().encode(text)
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  jsonFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    jsonFormatModule.capabilities.rowBreakBytes
  )
  return {
    filePath: 'C:/docs/data.json',
    fileName: 'data.json',
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex: buildLineIndex(source, rowIndex),
    nameIndex: buildNameIndex(store, interner.size),
    diagnostics: [],
    complete: true,
    formatId: 'json',
    encoding: 'utf-8',
    readOnly: false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: true,
    externalChangeDetected: false,
    reloadPending: false,
    pendingTransform: null,
    minifiedBannerDismissed: false,
    reparsePending: false,
    transformInProgress: false,
    lastTransformWasNoOp: false,
    undoBytes: 0,
    undoEntryCount: 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    externalRewrites: 0,
    ...overrides
  }
}

function bannerFor(overrides: Partial<OpenDocument>): {
  message: string
  actions: readonly string[]
} {
  const state: DocumentSessionState = {
    phase: 'ready',
    document: openDocumentFor(overrides),
    selection: { selectedNode: 0, caretOffset: 0 }
  }
  const found = derivedNotifications(state, 'doc-1', false).find(
    (n) => n.id === 'derived:externalChange'
  )
  if (found === undefined) throw new Error('the external-change banner was not produced')
  return { message: found.message, actions: (found.actions ?? []).map((a) => a.label) }
}

describe('R169 — the external-change banner reports a reload in progress', () => {
  it('offers both choices before the reload starts', () => {
    const banner = bannerFor({ externalChangeDetected: true })
    expect(banner.message).toContain('changed on disk')
    expect(banner.actions).toEqual(['Reload and Discard', 'Keep Mine'])
  })

  it('says the reload is happening while it is in flight', () => {
    // The whole of the reported defect: this used to be identical to the
    // state above, so the click produced no visible change anywhere.
    const banner = bannerFor({ externalChangeDetected: true, reloadPending: true })
    expect(banner.message).toContain('Reloading')
    expect(banner.message).toContain('data.json')
    expect(banner.message).not.toContain('changed on disk')
  })

  it('drops Reload while it is running but keeps Keep Mine, which is now the cancel', () => {
    // Keep Mine is not decoration here: R169 made it abort the in-flight read,
    // so it is the only way back out once Reload has been clicked. Offering
    // "Reload and Discard" again would be offering the thing already underway.
    const banner = bannerFor({ externalChangeDetected: true, reloadPending: true })
    expect(banner.actions).toEqual(['Keep Mine'])
  })

  it('shows nothing at all for a background reload with no decision outstanding', () => {
    // A *clean* document auto-reloads with no banner and no click behind it.
    // `reloadPending` is true there too, and it must not raise a banner of its
    // own — there is no decision to present, and a notification appearing
    // unbidden for an operation the user did not ask for is noise.
    const state: DocumentSessionState = {
      phase: 'ready',
      document: openDocumentFor({ dirty: false, reloadPending: true }),
      selection: { selectedNode: 0, caretOffset: 0 }
    }
    const found = derivedNotifications(state, 'doc-1', false).find(
      (n) => n.id === 'derived:externalChange'
    )
    expect(found).toBeUndefined()
  })
})

/**
 * R169 §4.4 / acceptance 5 — a reload that *fails* must say so.
 *
 * The command's `run` was `void ctx.session.reloadAndDiscard()`, which
 * discarded the promise and therefore every failure in it. A reload of a file
 * that had since been deleted left the banner up with no explanation: the same
 * "the button is dead" symptom as the missing progress state, from an entirely
 * different cause, which is why fixing only one would have left the report half
 * answered.
 *
 * `Command.run` takes its session through an `AppContext`, so this drives the
 * real registered command against a stub rather than asserting the wiring by
 * reading it.
 */
describe('R169 — a failing reload is surfaced, a cancelled one is not', () => {
  afterEach(() => {
    resetNotificationsForTests()
  })

  function runReloadCommand(outcome: Awaited<ReturnType<DocumentSession['reloadAndDiscard']>>): {
    settled: Promise<void>
  } {
    const command = getCommand('klados.document.reloadExternalChange')
    if (command === undefined) throw new Error('the reload command is not registered')
    let resolveSettled: () => void
    const settled = new Promise<void>((r) => {
      resolveSettled = r
    })
    const session = {
      reloadAndDiscard: vi.fn().mockImplementation(async () => {
        // Resolve on the turn *after* the command's own `.then` runs.
        queueMicrotask(() => queueMicrotask(() => resolveSettled()))
        return outcome
      })
    } as unknown as DocumentSession
    command.run({ context: getContext(), session } satisfies AppContext)
    return { settled }
  }

  it('raises an error notification when the reload fails', async () => {
    const { settled } = runReloadCommand({ ok: false, message: 'Could not read data.json.' })
    await settled

    const pushed = getPushedNotifications()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.severity).toBe('error')
    expect(pushed[0]!.message).toBe('Could not read data.json.')
  })

  it('says nothing when the reload was cancelled by Keep Mine', async () => {
    // Cancellation is the user getting what they asked for. A red banner here
    // would punish someone for choosing to keep their own edits.
    const { settled } = runReloadCommand({ ok: true, cancelled: true })
    await settled

    expect(getPushedNotifications()).toHaveLength(0)
  })

  it('says nothing when the reload succeeds', async () => {
    const { settled } = runReloadCommand({ ok: true })
    await settled

    expect(getPushedNotifications()).toHaveLength(0)
  })
})
