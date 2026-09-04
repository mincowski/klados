/**
 * The Find bar (M4-PLAN.md G5, CONCEPT.md §6.2). Mounted inside the Raw
 * pane's own `.raw-container` (`Raw.tsx` — M5e-PLAN.md R8e; was mounted at
 * the app level, `position: fixed` to the viewport, which collided with
 * the drawn title bar's OS-painted caption-button region), visibility
 * toggled by `findStore.ts` — still "always present when Raw is, store-
 * driven" rather than a conditional render keyed off `findState.isOpen` at
 * the mount site.
 *
 * Query text and options live here, in component state — nothing else
 * needs them. `activeSearchStore` and `findStore`'s `currentIndex` are the
 * two pieces every other consumer (Raw's highlighting, a future Tree/grid
 * overlay) actually reads.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { useSyncExternalStore } from 'react'
import { isAsciiOnly, type TextFindOptions } from '../../../core/textFind'
import type { PathDiagnostic } from '../../../core/path/parse'
import { nodeContainingOffset } from '../../nodeSpanLookup'
import {
  matchIndexAtOrAfter,
  nextMatchIndex,
  previousMatchIndex
} from '../../navigation/matchNavigation'
import { focusLastPane } from '../../focus'
import { activeSession } from '../../session/activeSession'
import { activeSearchStore } from '../../session/activeSearchStore'
import type { SearchResult } from '../../session/searchStore'
import type { ReplaceMatch } from '../../session/documentSession'
import { encodeForRoundTrip, estimateReplaceAllUndoBytes } from '../../session/documentEdits'
import { getTotalMemoryBudgetBytes } from '../../settings'
import { useDocumentSession } from '../../session/useDocumentSession'
import { activeDocumentId } from '../../notifications/documentId'
import { notify } from '../../notifications/notificationStore'
import { Icon } from '../Icon/Icon'
import {
  closeFind,
  consumeFindPrefill,
  getFindState,
  setCurrentMatchIndex,
  subscribeFind,
  toggleReplace,
  type FindPrefill,
  type FindState
} from './findStore'
import { registerFindController } from './findController'
import './Find.css'

/** R90 (`R86-find-as-query-surface.md` §6): mirrors
 * `GRID_EXPORT_CONFIRM_ROWS` (`gridExport.ts`) — the same "this many
 * discrete items in one action" shape, so the number doesn't need
 * inventing or defending separately. A local constant, not an import: a
 * session-layer confirmation gate has no reason to depend on `Detail/`. */
const REPLACE_ALL_CONFIRM_MATCHES = 50_000

function useFindState(): FindState {
  return useSyncExternalStore(subscribeFind, getFindState, getFindState)
}

function useSearchResult(): SearchResult {
  return useSyncExternalStore(
    activeSearchStore.subscribe,
    activeSearchStore.getSnapshot,
    activeSearchStore.getSnapshot
  )
}

function usePathDiagnostic(): PathDiagnostic | null {
  return useSyncExternalStore(
    activeSearchStore.subscribe,
    activeSearchStore.getPathDiagnostic,
    activeSearchStore.getPathDiagnostic
  )
}

/** R87 (`R86-find-as-query-surface.md` §3): `.*` and `/` are one exclusive
 * group with `'plain'` as the off state (neither pressed) — `Aa` composes
 * with either, so it isn't part of this group. */
type MatchMode = 'plain' | 'regex' | 'path'

export function FindBar(): JSX.Element | null {
  const findState = useFindState()
  const documentState = useDocumentSession()
  const result = useSearchResult()
  const pathDiagnostic = usePathDiagnostic()

  const [text, setText] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matchMode, setMatchMode] = useState<MatchMode>('plain')
  const [replaceText, setReplaceText] = useState('')
  // R103 (`R102-find-single-line.md` §3): `<input type="text">` silently
  // concatenates a pasted multi-line string with no separator — measured
  // directly, `'a\nb'` assigned to one becomes `'ab'`, so a needle copied
  // across two lines becomes a string that appears in no document and Find
  // says "No matches" with nothing explaining why. `handlePaste` (below)
  // intercepts a paste containing a line break, strips it explicitly, and
  // this flag is what tells the footnote render to say so — `false` again
  // on the next ordinary text change, so the note doesn't outlive the paste
  // that caused it.
  const [showLineBreakNotice, setShowLineBreakNotice] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // R90 (`R86-find-as-query-surface.md` §6) — a Replace All confirmation
  // in flight (above `REPLACE_ALL_CONFIRM_MATCHES`, or one that would
  // exceed the undo memory budget), waiting on the notification's own
  // `klados.find.confirmReplaceAll`/`cancelReplaceAll` actions. Grid's
  // own `pendingExport` is the same shape for the same reason: there's
  // exactly one `FindBar` instance, so this doesn't need to be session
  // state — a component-local pending value the controller below resolves.
  const pendingReplaceAllRef = useRef<{
    readonly matches: readonly ReplaceMatch[]
    readonly replacementText: string
  } | null>(null)

  // `registerFindController` is called once (empty deps) and its functions
  // must still see the *latest* result/selection, not whatever was live at
  // registration time — refs updated every render, read from inside
  // `goNext`/`goPrevious` below rather than captured by the initial closure.
  const resultRef = useRef(result)
  resultRef.current = result
  const findStateRef = useRef(findState)
  findStateRef.current = findState
  const documentStateRef = useRef(documentState)
  documentStateRef.current = documentState

  // R88 (`R86-find-as-query-surface.md` §4): the palette's `/` hand-off —
  // `null` for an ordinary `Ctrl+F` open. `prefillConsumedRef` guards this
  // to run exactly once per open, the same "read at the moment the surface
  // that owns it opens" shape `PaletteContent`'s own lazy `useState(() =>
  // consumePendingInitialQuery())` initializer uses — a ref rather than an
  // initializer since this component never unmounts between opens
  // (`findState.isOpen` gates the render, not the mount). The `setText`/
  // `setMatchMode` calls happen here, synchronously during render — React's
  // own "adjust state when a prop changes" pattern (the same shape
  // `Palette.tsx`'s own `activeList`/`lastActiveList` clamp uses) — rather
  // than from an effect, which `react-hooks/set-state-in-effect` flags for
  // the cascading-render risk it exists to catch. Only the query itself
  // (`prefillToRunRef`, below) is a side effect and has to wait for one.
  const prefillConsumedRef = useRef(false)
  const prefillToRunRef = useRef<FindPrefill | null>(null)
  if (findState.isOpen && !prefillConsumedRef.current) {
    prefillConsumedRef.current = true
    const prefill = consumeFindPrefill()
    if (prefill !== null) {
      setText(prefill.text)
      setMatchMode(prefill.mode === 'path' ? 'path' : 'plain')
      prefillToRunRef.current = prefill
    }
  }
  if (!findState.isOpen && prefillConsumedRef.current) {
    prefillConsumedRef.current = false
  }

  useEffect(() => {
    if (!findState.isOpen) return
    inputRef.current?.focus()
    const prefill = prefillToRunRef.current
    if (prefill === null) {
      // R128 (`R126-find-count-stability.md` §5): a plain reopen with
      // surviving query text re-runs it — `handleClose` clears
      // `activeSearchStore`'s result (correct: it also drives Raw's match
      // decorations), but this component never unmounts between opens, so
      // the query text itself survives in component state and a reopen
      // with no prefill used to leave it describing a result set that had
      // been thrown away. Uses the component's *current* options
      // (case-sensitivity, match mode) — they survived the close too, and
      // silently resetting them on reopen would be a new bug in place of
      // this one.
      if (text.length > 0) {
        if (matchMode === 'path') runPathQuery(text)
        else runSearch(text, { caseSensitive, regex: matchMode === 'regex' })
      }
      return
    }
    prefillToRunRef.current = null
    if (prefill.mode === 'path') runPathQuery(prefill.text)
    else runSearch(prefill.text, { caseSensitive: false, regex: false })
    // Deliberately keyed on `findState.isOpen` alone (R128's own note
    // above): re-running on every `text`/`matchMode`/`caseSensitive` change
    // would restart the search on every keystroke instead of only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findState.isOpen])

  // R79 (`R78-find-affordances.md` §2, text search half) — the anchor a
  // fresh search selects from. Not the caret itself: `moveTo` moves the
  // caret to the selected match, so by the next keystroke the caret would
  // already be wherever the *previous* keystroke landed, and backspacing
  // would never return to where the search started. Refreshed when Find
  // opens and whenever the query goes empty — the two moments "search just
  // started" actually means.
  const anchorOffsetRef = useRef(0)
  useEffect(() => {
    if (findState.isOpen && documentStateRef.current.phase === 'ready') {
      anchorOffsetRef.current = documentStateRef.current.selection.caretOffset
    }
  }, [findState.isOpen])
  useEffect(() => {
    if (text.length === 0 && documentState.phase === 'ready') {
      anchorOffsetRef.current = documentState.selection.caretOffset
    }
  }, [text, documentState])

  // R79 — set immediately before a *user-driven* search starts
  // (`runSearch`'s debounce callback below), consumed once that search's
  // result lands complete. An edit-driven re-run (`searchStore`'s own
  // session subscription, re-running the active query after a debounced
  // reparse) never sets this — only `FindBar` itself initiates a search
  // through `runSearch` — so an edit never yanks the caret out from under
  // someone typing.
  const pendingAutoSelectRef = useRef(false)

  // A document switch mid-debounce must not let a stale pending search
  // fire against the *new* document once the 150ms timer elapses —
  // `activeSearchStore` itself already clears on a document change (G4),
  // but a debounced `search()` call that lands afterward would just start
  // a fresh one, silently applying whatever text was mid-typed for the
  // previous document. Cancelling here is the same "an edit... so does
  // closing the document" supersede rule G4 established, applied to this
  // component's own debounce rather than left to accidentally still work.
  const filePath = documentState.phase === 'ready' ? documentState.document.filePath : null
  const lastFilePathRef = useRef(filePath)
  useEffect(() => {
    if (lastFilePathRef.current === filePath) return
    lastFilePathRef.current = filePath
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [filePath])

  // Registered once — `goNext`/`goPrevious` read from the refs above, not
  // from this closure's own render-time values, so a stable registration
  // is correct rather than stale.
  useEffect(
    () =>
      registerFindController({
        goNext: () => goNext(),
        goPrevious: () => goPrevious(),
        confirmReplaceAll: () => handleConfirmReplaceAll(),
        cancelReplaceAll: () => handleCancelReplaceAll()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // A fresh query invalidates whatever match navigation was parked on —
  // the old index means nothing against a different result set.
  function runSearch(nextText: string, options: TextFindOptions): void {
    setCurrentMatchIndex(null)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pendingAutoSelectRef.current = true
      activeSearchStore.search({ text: nextText, mode: 'text', options })
    }, 150)
  }

  // R87 §3: a path is a query you compose, not a needle you narrow live —
  // `/garage/` is a parse error halfway through typing `/garage/cars`, so
  // evaluating on every keystroke would flicker between an error and zero
  // matches. Runs immediately (no debounce — Enter is already the
  // deliberate trigger the debounce exists to stand in for) and clears any
  // pending navigation the same way `runSearch` does.
  function runPathQuery(nextText: string): void {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    setCurrentMatchIndex(null)
    pendingAutoSelectRef.current = true
    activeSearchStore.search({
      text: nextText,
      mode: 'path',
      options: { caseSensitive: false, regex: false }
    })
  }

  function handleTextChange(value: string, strippedLineBreak = false): void {
    setText(value)
    setShowLineBreakNotice(strippedLineBreak)
    if (matchMode !== 'path') runSearch(value, { caseSensitive, regex: matchMode === 'regex' })
  }

  /** R103: an ordinary `onChange` never sees a line break — a keyboard
   * Enter can't produce one in a text input, so paste (or a similar
   * programmatic value assignment) is the only route a line break could
   * arrive by. Only a pasted string that actually contains one is
   * intercepted; every other paste falls through to the browser's own
   * default handling unchanged. */
  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>): void {
    const pasted = event.clipboardData.getData('text')
    if (!/[\r\n]/.test(pasted)) return
    event.preventDefault()
    const stripped = pasted.replace(/[\r\n]+/g, '')
    const el = event.currentTarget
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    handleTextChange(text.slice(0, start) + stripped + text.slice(end), true)
  }

  function handleCaseSensitiveChange(value: boolean): void {
    setCaseSensitive(value)
    runSearch(text, { caseSensitive: value, regex: matchMode === 'regex' })
  }

  /** Clicking `.* ` or `/` again turns it back off (`'plain'`); clicking the
   * other member of the group switches directly, rather than requiring two
   * clicks to get there — the exclusivity `role="radiogroup"` communicates. */
  function handleMatchModeChange(next: 'regex' | 'path'): void {
    const mode = matchMode === next ? 'plain' : next
    setMatchMode(mode)
    if (mode === 'path') {
      // Not evaluated here — R87 §3: path mode runs on Enter, not on
      // whatever text happened to be in the box when the button was
      // clicked (which may not even be valid path syntax at all). A text
      // search's own debounce may still be pending from before this click
      // (switching modes inside the 150ms window) — left running, it would
      // fire a stale `mode: 'text'` search after the switch and silently
      // overwrite whatever path result Enter produces first.
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      setCurrentMatchIndex(null)
      return
    }
    runSearch(text, { caseSensitive, regex: mode === 'regex' })
  }

  function moveTo(index: number): void {
    setCurrentMatchIndex(index)
    const currentDocumentState = documentStateRef.current
    const start = resultRef.current.starts[index]
    if (start === undefined || currentDocumentState.phase !== 'ready') return
    const node = nodeContainingOffset(currentDocumentState.document.store, start)
    activeSession.setSelectedNode(node)
    activeSession.setCaretOffset(start)
  }

  // Folds two jobs into one effect keyed on `result`, rather than two
  // effects racing to react to the same change (R79's own "d"): a re-run
  // can land a result *smaller* than the one `currentIndex` was parked
  // against — an edit that removes matches, most directly — and separately,
  // a user-driven search that just completed may have a pending auto-select
  // to perform. Left unclamped, the display would read "38 of 3" and no
  // match would ever draw as current (nothing in the new, shorter array
  // equals the stale index); resetting to `null` is exactly "search just
  // started," the same state `matchIndexAtOrAfter`'s own fallback expects.
  useEffect(() => {
    // A re-run publishes an *incomplete* empty result the instant it starts
    // (`searchStore.ts`'s own `runSearch`: `{ ...EMPTY_SEARCH_RESULT,
    // complete: false }`) before the real one lands — including an
    // edit-driven re-run whose real result will turn out identical. Acting
    // on that transient zero-length array here would null out a perfectly
    // valid `currentIndex` on every edit, not just a shrinking one, and
    // nothing would put it back (an edit-driven re-run has no pending
    // auto-select to do it). So both jobs below wait for `result.complete`.
    if (!result.complete) return
    if (pendingAutoSelectRef.current) {
      pendingAutoSelectRef.current = false
      if (result.starts.length > 0) {
        const index = matchIndexAtOrAfter(result.starts, anchorOffsetRef.current)
        if (index !== null) {
          moveTo(index)
          return
        }
      }
    }
    if (findState.currentIndex !== null && findState.currentIndex >= result.starts.length) {
      setCurrentMatchIndex(null)
    }
  }, [result, findState.currentIndex])

  function goNext(): void {
    const currentDocumentState = documentStateRef.current
    if (currentDocumentState.phase !== 'ready') return
    const index = nextMatchIndex(
      resultRef.current.starts,
      findStateRef.current.currentIndex,
      currentDocumentState.selection.caretOffset
    )
    if (index !== null) moveTo(index)
  }

  function goPrevious(): void {
    const currentDocumentState = documentStateRef.current
    if (currentDocumentState.phase !== 'ready') return
    const index = previousMatchIndex(
      resultRef.current.starts,
      findStateRef.current.currentIndex,
      currentDocumentState.selection.caretOffset
    )
    if (index !== null) moveTo(index)
  }

  // R122 (`R120-find-bar-keyboard.md` §5) — the guard is load-bearing:
  // `closeFind()` is also reachable from paths where the user is not in the
  // bar at all (a document switch, a command), and grabbing focus there
  // would be a worse bug than the one being fixed.
  function handleClose(): void {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    const barHadFocus = barRef.current?.contains(document.activeElement) ?? false
    activeSearchStore.clear()
    closeFind()
    if (barHadFocus) focusLastPane()
  }

  /** R90 §6 — the shared refusal path both Replace and Replace All resolve
   * through: `applyReplaceAll`'s own refusal (not-ready/read-only/
   * unsupported-encoding) becomes a transient notification, not a thrown
   * error or a silent no-op — the same treatment `Raw.tsx`'s own edit
   * refusal gets, and the decision this round's own DECISIONS.md amendment
   * is about: a read-only document is now learned about *here*, not only
   * in the Raw pane's standing banner. */
  function runReplaceAllNow(matches: readonly ReplaceMatch[], replacementText: string): void {
    const outcome = activeSession.applyReplaceAll(matches, replacementText)
    if (!outcome.ok) {
      notify({
        severity: 'warning',
        message: outcome.message,
        documentId: activeDocumentId(),
        dedupeKey: 'find.replaceRefused'
      })
    }
  }

  /** Whether replacing `matches` with `replacementText` would exceed the
   * undo memory budget — computed here, before ever asking, so the
   * confirmation (when one is shown) can say so up front rather than the
   * user discovering it only after committing (§11.2). `null` encoding
   * means the replace will refuse outright regardless of size; treated as
   * "would not be undoable" is moot there, but returning `true` (i.e. no
   * extra warning) would be actively misleading if a caller ever showed a
   * warning based on this alone without also attempting the replace. */
  function wouldBeUndoable(matches: readonly ReplaceMatch[], replacementText: string): boolean {
    if (documentState.phase !== 'ready') return true
    const encoded = encodeForRoundTrip(
      replacementText,
      documentState.document.sourceBuffer.encoding
    )
    if (encoded === null) return true
    const estimated = estimateReplaceAllUndoBytes(matches, encoded.byteLength)
    return documentState.document.undoBytes + estimated <= getTotalMemoryBudgetBytes()
  }

  function currentMatches(): ReplaceMatch[] {
    return Array.from(result.starts, (start, i) => ({ start, end: result.ends[i]! }))
  }

  /** Replaces just the current match, then advances to the next one — the
   * conventional single-Replace behavior. Reuses `applyReplaceAll` with a
   * one-element list rather than a separate code path: on the substance
   * it's the same "byte splice(s), one undo entry" operation `applyEdit`
   * already is, just started from Find instead of typed in Raw (§6's own
   * invariant-6 analysis). The re-run this triggers (`searchStore`'s own
   * edit-driven re-run of the active query) is what refreshes the match
   * list; `pendingAutoSelectRef`/`anchorOffsetRef` — the same machinery
   * R79's auto-select already uses — is what lands on the next match once
   * it does, anchored at the replaced span's own start.
   */
  function handleReplace(): void {
    if (matchMode === 'path' || documentState.phase !== 'ready') return
    const index = findState.currentIndex
    const start = index !== null ? result.starts[index] : undefined
    const end = index !== null ? result.ends[index] : undefined
    if (start === undefined || end === undefined) return
    anchorOffsetRef.current = start
    pendingAutoSelectRef.current = true
    runReplaceAllNow([{ start, end }], replaceText)
  }

  function handleReplaceAllClick(): void {
    if (matchMode === 'path') return
    const matches = currentMatches()
    if (matches.length === 0) return
    const undoable = wouldBeUndoable(matches, replaceText)
    if (matches.length <= REPLACE_ALL_CONFIRM_MATCHES && undoable) {
      runReplaceAllNow(matches, replaceText)
      return
    }
    pendingReplaceAllRef.current = { matches, replacementText: replaceText }
    const countPart = `Replacing ${matches.length.toLocaleString()} match${matches.length === 1 ? '' : 'es'}.`
    const undoPart = undoable ? ' Continue?' : ' This cannot be undone. Continue?'
    notify({
      severity: 'warning',
      message: countPart + undoPart,
      actions: [
        { label: 'Replace All', commandId: 'klados.find.confirmReplaceAll' },
        { label: 'Cancel', commandId: 'klados.find.cancelReplaceAll' }
      ],
      documentId: activeDocumentId(),
      dedupeKey: 'find.replaceAllConfirm'
    })
  }

  function handleConfirmReplaceAll(): void {
    const pending = pendingReplaceAllRef.current
    if (pending === null) return
    pendingReplaceAllRef.current = null
    runReplaceAllNow(pending.matches, pending.replacementText)
  }

  function handleCancelReplaceAll(): void {
    pendingReplaceAllRef.current = null
  }

  // Enter stays find-next/Shift+Enter find-previous (or, in path mode, the
  // query trigger). R102: with the field back to `<input type="text">`,
  // Enter can no longer insert a newline in the first place — `preventDefault`
  // here is only about not letting it also submit/navigate, not about
  // suppressing a newline the element itself can't produce (R103's
  // `handlePaste`, above, is what a line break can still arrive by).
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    // R122 (`R120-find-bar-keyboard.md` §5): Escape moved to the bar's own
    // container handler (`handleBarKeyDown`, below) so every control closes
    // on it, not only the find input.
    if (event.key === 'Enter') {
      // Ctrl+Alt+Enter is Replace All (R121 §4) — handled by
      // `handleBarKeyDown` once this bubbles there. Left alone here so it
      // isn't *also* read as a plain Enter (find-next).
      if (event.ctrlKey && event.altKey) return
      event.preventDefault()
      // R87 §3: Enter is the deliberate trigger path mode runs on, not
      // find-next — next/previous still work via F3/Shift+F3 and the ↑/↓
      // buttons once a result exists.
      if (matchMode === 'path') {
        runPathQuery(text)
        return
      }
      if (event.shiftKey) goPrevious()
      else goNext()
    }
  }

  // R121 (`R120-find-bar-keyboard.md` §4): Enter in the replace field runs
  // Replace — `handleReplace` already no-ops when there is no current match
  // (`findState.currentIndex === null`), the same guard that disables ⇄.
  function handleReplaceKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && !(event.ctrlKey && event.altKey)) {
      event.preventDefault()
      handleReplace()
    }
  }

  /** R120 §2: derives the bar's tab order from the DOM rather than
   * hand-maintaining a list of refs, so a control added later is picked up
   * with no edit here. The one deviation from DOM order — the replace input
   * splices in right after the find input — is the whole reason this
   * function exists instead of plain `querySelectorAll` order (§2's three
   * options). Filters out disabled controls: ↑/↓/⟳ are disabled with no
   * matches and ⇄ is disabled with no current match, so a tab stop would
   * otherwise land on a dead control. Not cached across renders (§8) — a
   * control's `disabled` state changes on every search keystroke. */
  function orderedFocusables(bar: HTMLElement): HTMLElement[] {
    const all = Array.from(bar.querySelectorAll<HTMLElement>('input, button')).filter(
      (el) => !el.hasAttribute('disabled')
    )
    const replaceInput = all.find((el) => el.classList.contains('find-replace-input'))
    if (replaceInput === undefined) return all
    const rest = all.filter((el) => el !== replaceInput)
    const findInputIndex = rest.findIndex(
      (el) => el.classList.contains('find-input') && el !== replaceInput
    )
    if (findInputIndex === -1) return all
    rest.splice(findInputIndex + 1, 0, replaceInput)
    return rest
  }

  /** R120/R122/R123 — the container handler §1 found is needed regardless
   * of R120 alone: R123's wrap can't be expressed in DOM order or
   * `tabindex`, so it requires intercepting the key, and once it exists the
   * ordering (R120) and closing (R122) ride the same mechanism. */
  function handleBarKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      handleClose()
      return
    }
    if (event.key === 'Enter' && event.ctrlKey && event.altKey) {
      event.preventDefault()
      // R121 §4: no-op when the replace row isn't showing — there is
      // nothing to replace all *to*.
      if (matchMode !== 'path' && findState.replaceExpanded) handleReplaceAllClick()
      return
    }
    if (event.key !== 'Tab') return
    // R122 §5's guard: the global keymap `preventDefault()`s `Ctrl+Tab`
    // (`klados.tabs.next`) but does not `stopPropagation()`, so it still
    // reaches here — without this, `Ctrl+Tab` would switch tabs *and* move
    // focus inside the bar at the same time.
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const focusables = orderedFocusables(event.currentTarget)
    if (focusables.length === 0) return
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const step = event.shiftKey ? -1 : 1
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + step + focusables.length) % focusables.length
    focusables[nextIndex]?.focus()
  }

  if (!findState.isOpen) return null

  const total = result.starts.length
  const currentDisplay = findState.currentIndex !== null ? findState.currentIndex + 1 : 0
  // R126 (`R126-find-count-stability.md` §2): `(stale)` dropped — the
  // moment the count is genuinely unknown the label already says
  // "Searching…", which costs no width; `(stale)` covered only the window
  // where the number is frozen and approximately right, and in that window
  // the user is looking at the text they're editing, not the find bar.
  const countLabel = !result.complete
    ? 'Searching…'
    : total === 0
      ? 'No matches'
      : `${currentDisplay.toLocaleString()} of ${total.toLocaleString()}`
  // §3 — the exact reservation: the widest this label can ever be is
  // `{total} of {total}`, once `(stale)` no longer adds to it. Same
  // `toLocaleString()` formatting as the label itself, so the sizer is
  // exact rather than merely close.
  const countSizer = `${total.toLocaleString()} of ${total.toLocaleString()}`

  // R90 §6 — hidden, not merely disabled, in path mode: a path result is a
  // set of node spans, and "replace every matched element with this text"
  // is a different and much larger feature than replacing matched text.
  const showReplace = matchMode !== 'path'

  return (
    <div
      className="find-bar"
      role="search"
      aria-label="Find in document"
      ref={barRef}
      onKeyDown={handleBarKeyDown}
    >
      <div className="find-bar-row">
        {showReplace && (
          <button
            type="button"
            className="find-replace-disclosure"
            aria-expanded={findState.replaceExpanded}
            aria-label={findState.replaceExpanded ? 'Hide replace' : 'Show replace'}
            title="Replace (Ctrl+H)"
            onClick={() => toggleReplace()}
          >
            <Icon name={findState.replaceExpanded ? 'chevron-down' : 'chevron-right'} />
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          className="find-input"
          placeholder={matchMode === 'path' ? 'Path query, Enter to run…' : 'Find…'}
          value={text}
          onChange={(event) => handleTextChange(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          aria-label="Find"
        />
        <span className="find-count" aria-live="polite">
          <span className="find-count-sizer" aria-hidden="true">
            {countSizer}
          </span>
          <span className="find-count-value">{countLabel}</span>
        </span>
        <button
          type="button"
          className="find-toggle"
          aria-pressed={caseSensitive}
          title={
            matchMode === 'path'
              ? 'Match case (disabled — not applicable to a path query)'
              : 'Match case'
          }
          disabled={matchMode === 'path'}
          onClick={() => handleCaseSensitiveChange(!caseSensitive)}
        >
          Aa
        </button>
        {/* R87 (`R86-find-as-query-surface.md` §3): `.*` and `/` are one
         * exclusive group with a `'plain'` off state — `.*` unpressed
         * already meant plain text before this round, so `/` joins it as
         * the second radio rather than a third independent-looking toggle,
         * which would lie about the two being mutually exclusive. */}
        <div className="find-mode-group" role="radiogroup" aria-label="Match mode">
          <button
            type="button"
            className="find-toggle"
            role="radio"
            aria-checked={matchMode === 'regex'}
            title="Use regular expression"
            onClick={() => handleMatchModeChange('regex')}
          >
            .*
          </button>
          <button
            type="button"
            className="find-toggle"
            role="radio"
            aria-checked={matchMode === 'path'}
            title="Path query"
            onClick={() => handleMatchModeChange('path')}
          >
            /
          </button>
        </div>
        <button
          type="button"
          onClick={goPrevious}
          disabled={total === 0}
          aria-label="Previous match"
        >
          <Icon name="arrow-up" />
        </button>
        <button type="button" onClick={goNext} disabled={total === 0} aria-label="Next match">
          <Icon name="arrow-down" />
        </button>
        <button type="button" onClick={handleClose} aria-label="Close find">
          <Icon name="dismiss" />
        </button>
      </div>
      {/* R90 (`R86-find-as-query-surface.md` §6) — the replace row,
       * collapsed by default (`Ctrl+H` opens with it already expanded).
       * Hidden, not disabled, in path mode (`showReplace` above) — see
       * that constant's own comment. */}
      {showReplace && findState.replaceExpanded && (
        <div className="find-bar-row find-replace-row">
          {/* Lines the replace input up under the find textarea — the
           * disclosure button only exists on the row above (deliberately;
           * there is nothing to disclose from this one), so this reserves
           * the same width rather than leaving the input to start further
           * left than the field it sits below. */}
          <span className="find-replace-spacer" aria-hidden="true" />
          <input
            type="text"
            className="find-input find-replace-input"
            placeholder="Replace…"
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            onKeyDown={handleReplaceKeyDown}
            aria-label="Replace"
          />
          <button
            type="button"
            onClick={handleReplace}
            disabled={findState.currentIndex === null}
            aria-label="Replace"
            title="Replace (Enter)"
          >
            <Icon name="arrow-swap" />
          </button>
          <button
            type="button"
            onClick={handleReplaceAllClick}
            disabled={total === 0}
            aria-label="Replace All"
            title="Replace All (Ctrl+Alt+Enter)"
          >
            <Icon name="arrow-repeat-all" />
          </button>
        </div>
      )}
      {/* R72 §6 — Tier 1 (`R72-path-query.md`): the old render
       * condition (`!regex && !caseSensitive`, unconditional on the
       * needle) showed this on essentially every search, including every
       * ASCII one where the two case-fold paths measurably never diverge
       * — the footnote read as boilerplate, not a warning. It's also
       * hidden exactly when `regex` is on, one of the two modes it
       * describes. Keyed on `!caseSensitive && !isAsciiOnly(text)`
       * instead (`textFind.ts`'s own exported predicate, not a re-derived
       * test, so the note and the behaviour can't drift) — the only
       * region a divergence can actually occur, per the module's own
       * measured table. Two symmetric messages rather than one: neither
       * says "try the other mode," since in regex mode that would be
       * actively bad advice (the pattern may depend on metacharacters
       * `.*` would defeat by lying about the trade-off's actual shape). */}
      {/* R87 §3: the path grammar's own parse diagnostic, in the same
       * footnote row R72 §6 already renders the look-alike-character note
       * in — both are "why the count reads the way it does," and never
       * occur together (path mode disables `Aa`/`.* ` above). A caret under
       * the offending character, R72 §5's own pattern for the palette's own
       * `/` mode — `find-footnote-path-query` shares `--font-mono` with the
       * caret row so the two columns actually line up. */}
      {matchMode === 'path' && pathDiagnostic !== null && (
        <div className="find-footnote find-footnote-path">
          <div className="find-footnote-path-query">{text}</div>
          <div className="find-footnote-path-caret" aria-hidden="true">
            {' '.repeat(Math.max(0, Math.min(pathDiagnostic.offset, text.length)))}^
          </div>
          <div>{pathDiagnostic.message}</div>
        </div>
      )}
      {matchMode !== 'path' && !caseSensitive && !isAsciiOnly(text) && (
        <span className="find-footnote">
          {matchMode === 'regex'
            ? 'Look-alike characters: plain mode matches a slightly different set.'
            : 'Look-alike characters: .* mode matches a slightly different set.'}
        </span>
      )}
      {/* R103 (`R102-find-single-line.md` §3): the one thing reverting the
       * find field to a single line genuinely loses — a plain
       * `<input type="text">` concatenates a pasted multi-line string with
       * no separator, silently, so a needle copied across two lines would
       * otherwise become a string that matches nothing with no explanation
       * on screen. `handlePaste` strips the line breaks explicitly; this
       * says so, in the same footnote row the ASCII-folding note and R87's
       * path diagnostic already use. */}
      {matchMode !== 'path' && showLineBreakNotice && (
        <span className="find-footnote">Line breaks were removed from the pasted text.</span>
      )}
    </div>
  )
}
