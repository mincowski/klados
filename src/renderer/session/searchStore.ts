/**
 * Search state on the document session (M4-PLAN.md G4, CONCEPT.md §6.2/
 * §6.6/§11.4). Results are an `Int32Array` of byte offsets, ascending,
 * "resolved to nodes only when displayed" — `navigation/nodeSpanLookup.ts`
 * (D14) already does offset → node; this module never builds a second one.
 *
 * **Per document, not per app.** A different `DocumentSession` (there is
 * only one today, per `activeSession.ts` — a future tab strip would give
 * each tab its own) gets its own `createSearchStore(session)`. Results,
 * match state and query all die the moment the session's own document does
 * — closed, or replaced by opening a different file.
 *
 * **An edit invalidates the match set by re-running, not by shifting
 * offsets through the delta list.** Find is fast enough that a fresh scan
 * is simpler than maintaining correctness across a splice, and a match set
 * that's *nearly* right is exactly the failure mode this project keeps
 * finding expensive (`M3-RESULTS.md`'s delta-list findings, D-010). The
 * re-run itself rides `documentSession.ts`'s own debounced reparse — no
 * second debounce timer here — but the moment the document goes dirty and
 * *before* that reparse lands, the current result is marked `stale`
 * immediately rather than left to look current while it silently isn't.
 */
import {
  chooseFindPath,
  decodedWindowsFor,
  findAsciiInRange,
  findDecodedInWindow,
  type MatchSet,
  type TextFindOptions
} from '../../core/textFind'
import { parsePath, type PathDiagnostic } from '../../core/path/parse'
import { evaluatePathChunked } from '../navigation/pathQueryJob'
import type { DocumentSession, OpenDocument } from './documentSession'
import { JobSlot, runChunkedJob, type SearchJob } from './searchJob'

/** ~1 MiB per step of the byte path — small enough that several steps fit
 * comfortably inside one of G3's default 8 ms slices on ordinary hardware,
 * large enough that the per-call overhead of `findAsciiInRange` (building a
 * fresh 256-entry shift table) doesn't dominate. */
const BYTE_CHUNK_BYTES = 1024 * 1024

/** R86 (`R86-find-as-query-surface.md` §2): path joins text as a second
 * query mode, rather than the palette's old `setDirectResult` snapshot
 * (R88 retired it — a snapshot has no `SearchQuery` to re-run when the
 * document changes underneath it, so an edit left a path result stale
 * permanently; a `mode: 'path'` query re-runs exactly like a text one).
 * `options` is meaningless in `'path'` mode (case/regex
 * don't apply to a structural query) but stays required on `SearchQuery` —
 * callers always have *some* value for it, and an optional field two modes
 * would each have to null-check differently isn't worth the branch. */
export type SearchMode = 'text' | 'path'

export interface SearchQuery {
  readonly text: string
  readonly mode: SearchMode
  readonly options: TextFindOptions
}

export interface SearchResult {
  readonly starts: Int32Array
  readonly ends: Int32Array
  /** `false` while a chunked job is still scanning the document. */
  readonly complete: boolean
  /** §6.6's seam for M5's streaming parse: "provisional match counts on a
   * partially-parsed document." Always `false` in M4 — nothing sets it yet
   * — but the shape exists so a later provisional search doesn't need a
   * new field threaded through every consumer. */
  readonly provisional: boolean
  /** `true` once the document has been edited since this result was
   * computed — the count is known wrong, not merely delayed. Cleared the
   * moment a fresh search against the new store lands. */
  readonly stale: boolean
}

export const EMPTY_SEARCH_RESULT: SearchResult = {
  starts: new Int32Array(0),
  ends: new Int32Array(0),
  complete: true,
  provisional: false,
  stale: false
}

export interface SearchStore {
  getSnapshot(): SearchResult
  getQuery(): SearchQuery | null
  subscribe(listener: () => void): () => void
  /** Runs `query` against the live document, superseding whatever search
   * (or re-run) is currently in flight. An empty `query.text` clears the
   * result without starting a job — there is nothing to search for. */
  search(query: SearchQuery): void
  /** R86 (`R86-find-as-query-surface.md` §2/§3): set when the current
   * `activeQuery` is `mode: 'path'` and its text failed to parse — `null`
   * otherwise, including for a text query, an empty query, or a path query
   * that parsed fine. `FindBar`'s footnote row (R87) reads this rather than
   * re-parsing the query itself, so the two can never disagree. */
  getPathDiagnostic(): PathDiagnostic | null
  /** Clears the active query and its result without starting a new one. */
  clear(): void
  dispose(): void
}

/** `false` means the query text failed to parse as a path — `diagnostic`
 * carries why, for `FindBar`'s footnote row (R87). Parsing happens fresh on
 * every call, never cached on the query — `parsePath`'s resolver closes
 * over `document.store.interner`, so a `ParsedPath` is only ever valid
 * against the store that produced it (§2's own reasoning for why
 * `SearchQuery` holds text, not a parsed tree). */
type FindJobOutcome =
  | { readonly ok: true; readonly job: SearchJob<MatchSet> }
  | { readonly ok: false; readonly diagnostic: PathDiagnostic }

function pathJobFor(document: OpenDocument, text: string): FindJobOutcome {
  const parsed = parsePath(text, (name) =>
    document.store.interner.lookup(name, document.sourceBuffer.encoding)
  )
  if (!parsed.ok) return { ok: false, diagnostic: parsed.diagnostic }

  const nodeJob = evaluatePathChunked(
    document.store,
    document.nameIndex,
    document.sourceBuffer,
    parsed.path
  )
  const store = document.store
  return {
    ok: true,
    job: {
      cancel: nodeJob.cancel,
      result: nodeJob.result.then((nodes) => {
        // R72-path-query.md's `runPathQuery`: every downstream consumer
        // (Raw highlighting, match navigation) assumes an ascending
        // `starts` array — `evaluatePathChunked`'s own output is only
        // ascending insofar as each step's context order already was.
        const order = Array.from(nodes, (node) => store.spanOf(node)).sort(
          (a, b) => a.start - b.start
        )
        return {
          starts: Int32Array.from(order, (span) => span.start),
          ends: Int32Array.from(order, (span) => span.end)
        }
      })
    }
  }
}

function findJobFor(document: OpenDocument, query: SearchQuery): FindJobOutcome {
  if (query.mode === 'path') return pathJobFor(document, query.text)

  const bytes = document.sourceBuffer.bytes
  const { text: needle, options } = query

  if (chooseFindPath(needle, options) === 'byte') {
    const starts: number[] = []
    const ends: number[] = []
    return {
      ok: true,
      job: runChunkedJob(0, (cursor) => {
        if (cursor >= bytes.length) {
          return {
            done: true,
            value: { starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
          }
        }
        const to = Math.min(cursor + BYTE_CHUNK_BYTES, bytes.length)
        const chunk = findAsciiInRange(bytes, needle, options.caseSensitive, cursor, to)
        for (let i = 0; i < chunk.starts.length; i++) {
          starts.push(chunk.starts[i]!)
          ends.push(chunk.ends[i]!)
        }
        return { done: false, state: to }
      })
    }
  }

  const windows = decodedWindowsFor(document.rowIndex)
  const starts: number[] = []
  const ends: number[] = []
  return {
    ok: true,
    job: runChunkedJob(0, (windowIndex) => {
      if (windowIndex >= windows.length) {
        return {
          done: true,
          value: { starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
        }
      }
      const window = windows[windowIndex]!
      const chunk = findDecodedInWindow(
        bytes,
        document.rowIndex,
        document.encoding,
        needle,
        options,
        window,
        bytes.length
      )
      for (let i = 0; i < chunk.starts.length; i++) {
        starts.push(chunk.starts[i]!)
        ends.push(chunk.ends[i]!)
      }
      return { done: false, state: windowIndex + 1 }
    })
  }
}

export function createSearchStore(session: DocumentSession): SearchStore {
  let result: SearchResult = EMPTY_SEARCH_RESULT
  let activeQuery: SearchQuery | null = null
  // R86: set by `runSearch` when the active query is a path that failed to
  // parse — cleared by every path that would otherwise leave it describing
  // a query that's no longer active (a fresh `search()`, `clear()`, a
  // document switch, or a path query that goes on to parse successfully).
  let pathDiagnostic: PathDiagnostic | null = null
  const jobs = new JobSlot<MatchSet>()
  const listeners = new Set<() => void>()

  // Initialized from whatever the session's current state already is, not
  // just `null` — `createSearchStore` can be constructed after a document
  // is already open (the ordinary case, since `activeSearchStore.ts` wraps
  // an already-live `activeSession`). Left as `null` here, the first
  // subsequent notification would see `document.filePath !== null` and
  // wrongly read that as "a different document just opened", discarding
  // whatever `search()` had just been asked to do.
  const initialSnapshot = session.getSnapshot()
  let lastFilePath: string | null =
    initialSnapshot.phase === 'ready' ? initialSnapshot.document.filePath : null
  let lastStore: OpenDocument['store'] | null =
    initialSnapshot.phase === 'ready' ? initialSnapshot.document.store : null

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function setResult(next: SearchResult): void {
    result = next
    notify()
  }

  function runSearch(document: OpenDocument, query: SearchQuery): void {
    setResult({ ...EMPTY_SEARCH_RESULT, complete: false })
    const outcome = findJobFor(document, query)
    if (!outcome.ok) {
      // A path that doesn't parse never reaches `jobs` at all — nothing to
      // cancel a *previous* job for except whatever ran before this call.
      jobs.cancel()
      pathDiagnostic = outcome.diagnostic
      setResult(EMPTY_SEARCH_RESULT)
      return
    }
    pathDiagnostic = null
    const job = jobs.start(() => outcome.job)
    job.result.then(
      (matches) => {
        setResult({ ...matches, complete: true, provisional: false, stale: false })
      },
      () => {
        // Cancelled — superseded by a newer search, an edit's re-run, or the
        // document closing. Whichever superseded it already owns `result`;
        // there is nothing for this settled-late job to do.
      }
    )
  }

  function search(query: SearchQuery): void {
    pathDiagnostic = null
    activeQuery = query.text.length === 0 ? null : query
    if (activeQuery === null) {
      jobs.cancel()
      setResult(EMPTY_SEARCH_RESULT)
      return
    }
    const snapshot = session.getSnapshot()
    if (snapshot.phase !== 'ready') {
      setResult(EMPTY_SEARCH_RESULT)
      return
    }
    runSearch(snapshot.document, activeQuery)
  }

  function clear(): void {
    activeQuery = null
    pathDiagnostic = null
    jobs.cancel()
    setResult(EMPTY_SEARCH_RESULT)
  }

  const unsubscribe = session.subscribe(() => {
    const snapshot = session.getSnapshot()

    if (snapshot.phase !== 'ready') {
      if (lastFilePath !== null) {
        lastFilePath = null
        lastStore = null
        clear()
      }
      return
    }

    const { document } = snapshot
    if (document.filePath !== lastFilePath) {
      // A different document is now open — §11.4: search is per-document,
      // so whatever query/result belonged to the previous one dies here.
      lastFilePath = document.filePath
      lastStore = document.store
      activeQuery = null
      pathDiagnostic = null
      jobs.cancel()
      setResult(EMPTY_SEARCH_RESULT)
      return
    }

    if (document.store !== lastStore) {
      // A reparse landed (edit, undo/redo, splice or full) against the
      // *same* document — the store identity change is documentSession's
      // own signal that `applyReparseResult` just committed. Re-running
      // here rides that already-debounced reparse; no second debounce.
      lastStore = document.store
      if (activeQuery !== null) runSearch(document, activeQuery)
      return
    }

    // Store hasn't changed yet, but the buffer has — an edit landed and the
    // debounced reparse (and this store's own re-run) hasn't caught up.
    // Mark stale immediately rather than let a stale-but-plausible count
    // sit unmarked until the debounce elapses.
    if (activeQuery !== null && document.dirty && result.complete && !result.stale) {
      setResult({ ...result, stale: true })
    }
  })

  return {
    getSnapshot: () => result,
    getQuery: () => activeQuery,
    getPathDiagnostic: () => pathDiagnostic,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    search,
    clear,
    dispose() {
      unsubscribe()
      jobs.cancel()
      listeners.clear()
    }
  }
}
