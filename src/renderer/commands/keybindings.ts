/**
 * Keybindings (CONCEPT.md §7, M1-PLAN.md D4): chord support, resolved
 * against the command registry by id (never against handlers directly),
 * user-overridable and persisted as a JSON file in `userData` — no
 * in-app editor in M1, the file is the whole interface.
 *
 * Global vs. editor-local bindings: every binding this module knows about
 * is a *global* one (palette, pane toggles, focus movement) — CodeMirror's
 * own keymap (D10) owns everything else (typing, cursor motion inside the
 * editor). This module's listener is attached in the capture phase on
 * `window`, so a global binding always wins over whatever CodeMirror would
 * otherwise do with the same keys — which is safe precisely because every
 * binding here requires a modifier (Ctrl/Shift/F-key), never a bare
 * printable character CodeMirror needs for typing. A binding that ever
 * needed a bare key would have to be reconsidered against this rule, not
 * bolted on with `stopPropagation`.
 */
import { activeSession } from '../session/activeSession'
import { getKladosApi } from '../preloadApi'
import { compileContextExpression, getContext } from './context'
import { getCommand } from './registry'

export interface KeyBinding {
  readonly commandId: string
  /** One combo (`['Ctrl+Shift+L']`) or a chord (`['Ctrl+K', 'Ctrl+S']`). */
  readonly chord: readonly string[]
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

/** A pending chord auto-cancels after this long — long enough to type the
 * second part deliberately, short enough not to eat an unrelated keypress
 * from a user who paused and moved on. */
const CHORD_TIMEOUT_MS = 1500

/**
 * Canonical form of a key combo, e.g. `"Ctrl+Shift+L"`. Modifiers always
 * in `MODIFIER_ORDER`; the key itself uppercased for letters (`event.key`
 * is case-sensitive on letters — `Shift+l` and `Shift+L` must normalize to
 * the same combo). Returns `null` for a bare modifier keypress, which is
 * never itself a complete combo.
 */
export function normalizeKeyCombo(event: {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null

  const held: Record<(typeof MODIFIER_ORDER)[number], boolean> = {
    Ctrl: event.ctrlKey,
    Alt: event.altKey,
    Shift: event.shiftKey,
    Meta: event.metaKey
  }
  const parts = MODIFIER_ORDER.filter((mod) => held[mod])

  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  parts.push(key as (typeof MODIFIER_ORDER)[number] & string)
  return parts.join('+')
}

export const DEFAULT_KEYBINDINGS: readonly KeyBinding[] = [
  { commandId: 'klados.palette.open', chord: ['Ctrl+Shift+P'] },
  // R65 (`R65-shortcuts-help.md` §4): F1 is the one F-key everyone
  // still knows, and it's free (F3/F6/F8 are taken). Not `?` — a bare
  // printable key, which this module's own capture-phase rule forbids
  // (it would be stolen from typing in Raw).
  { commandId: 'klados.help.shortcuts', chord: ['F1'] },
  { commandId: 'klados.document.open', chord: ['Ctrl+O'] },
  { commandId: 'klados.theme.toggle', chord: ['Ctrl+Shift+L'] },
  // R59 (`R58-zoom.md` §4): the conventional combos, unshifted —
  // `=`/`-` need no Shift on a standard layout, matching how browsers bind
  // "zoom in" to `Ctrl+=` rather than literally requiring `Ctrl+Shift+=`.
  // Whether these actually reach the renderer past Electron's own default
  // application menu (which binds the same combos to its built-in,
  // unbounded zoom roles) is unverified — the same open question §2 of that
  // document already raised for the menu's own accelerators, not resolved
  // by this task; the palette is what invariant 10 guarantees regardless.
  { commandId: 'klados.view.zoomIn', chord: ['Ctrl+='] },
  { commandId: 'klados.view.zoomOut', chord: ['Ctrl+-'] },
  { commandId: 'klados.view.resetZoom', chord: ['Ctrl+0'] },
  { commandId: 'klados.focus.tree', chord: ['Ctrl+1'] },
  { commandId: 'klados.focus.detail', chord: ['Ctrl+2'] },
  { commandId: 'klados.focus.raw', chord: ['Ctrl+3'] },
  { commandId: 'klados.focus.next', chord: ['F6'] },
  { commandId: 'klados.focus.previous', chord: ['Shift+F6'] },
  { commandId: 'klados.layout.toggleTree', chord: ['Ctrl+Shift+T'] },
  { commandId: 'klados.layout.toggleDetail', chord: ['Ctrl+Shift+D'] },
  { commandId: 'klados.layout.toggleRaw', chord: ['Ctrl+Shift+R'] },
  { commandId: 'klados.raw.toggleWrap', chord: ['Ctrl+Shift+W'] },
  { commandId: 'klados.navigate.back', chord: ['Alt+ArrowLeft'] },
  { commandId: 'klados.navigate.forward', chord: ['Alt+ArrowRight'] },
  { commandId: 'klados.navigate.drillUp', chord: ['Ctrl+ArrowUp'] },
  { commandId: 'klados.navigate.drillDown', chord: ['Ctrl+ArrowDown'] },
  { commandId: 'klados.navigate.locateInTree', chord: ['Ctrl+Shift+E'] },
  { commandId: 'klados.navigate.locateInSource', chord: ['Ctrl+Shift+J'] },
  { commandId: 'klados.navigate.nextDiagnostic', chord: ['F8'] },
  { commandId: 'klados.navigate.previousDiagnostic', chord: ['Shift+F8'] },
  // M4-PLAN.md G5's Ctrl+F collision (D-038): document-wide Find takes the
  // conventional binding; the grid's own quick filter moves rather than
  // being decided by which pane has focus.
  { commandId: 'klados.find.open', chord: ['Ctrl+F'] },
  // R90 (`R86-find-as-query-surface.md` §6) — the conventional chord for
  // "open Find with Replace already expanded," same as Ctrl+F's own
  // "already the platform convention" reasoning above.
  { commandId: 'klados.find.openWithReplace', chord: ['Ctrl+H'] },
  { commandId: 'klados.find.next', chord: ['F3'] },
  { commandId: 'klados.find.previous', chord: ['Shift+F3'] },
  { commandId: 'klados.grid.focusFilter', chord: ['Ctrl+Alt+F'] },
  { commandId: 'klados.edit.undo', chord: ['Ctrl+Z'] },
  { commandId: 'klados.edit.redo', chord: ['Ctrl+Y'] },
  { commandId: 'klados.document.save', chord: ['Ctrl+S'] },
  { commandId: 'klados.document.saveAs', chord: ['Ctrl+Shift+S'] },
  // R26 (`R24-tabs.md` §4): keyboard tab switching/closing —
  // conventional across every tabbed app on the platform.
  { commandId: 'klados.tabs.next', chord: ['Ctrl+Tab'] },
  { commandId: 'klados.tabs.previous', chord: ['Ctrl+Shift+Tab'] },
  { commandId: 'klados.tabs.closeActive', chord: ['Ctrl+W'] },
  // R37 (D-067): `Alt+<digit>`, not `Ctrl+<digit>` — `Ctrl+1`/`2`/`3` above
  // are already pane focus, a better use of them in a three-pane tool, and
  // `Alt+<digit>` is free specifically because this app draws its own
  // frameless title bar with no menu bar for Alt to activate.
  { commandId: 'klados.tabs.select1', chord: ['Alt+1'] },
  { commandId: 'klados.tabs.select2', chord: ['Alt+2'] },
  { commandId: 'klados.tabs.select3', chord: ['Alt+3'] },
  { commandId: 'klados.tabs.select4', chord: ['Alt+4'] },
  { commandId: 'klados.tabs.select5', chord: ['Alt+5'] },
  { commandId: 'klados.tabs.select6', chord: ['Alt+6'] },
  { commandId: 'klados.tabs.select7', chord: ['Alt+7'] },
  { commandId: 'klados.tabs.select8', chord: ['Alt+8'] },
  { commandId: 'klados.tabs.selectLast', chord: ['Alt+9'] }
]

/** Human-readable form of a chord, e.g. `["Ctrl+K", "Ctrl+S"]` →
 * `"Ctrl+K Ctrl+S"` — display only (palette, tooltips), never fed back
 * into matching. */
export function formatChord(chord: readonly string[]): string {
  return chord.join(' ')
}

/** The default chord bound to `commandId`, or `null` if unbound. Looks up
 * `DEFAULT_KEYBINDINGS` specifically, not the loaded (possibly
 * user-overridden) bindings — an accurate hint in the common case of an
 * unmodified keymap, and still useful before `loadKeybindings()` resolves.
 * Prefer `effectiveChordFor` (below) anywhere the answer needs to be
 * *correct*, not just a reasonable guess — R65 (`R65-shortcuts-help.md`
 * §2) is what found the difference matters: this function alone can't tell
 * a user who overrode a chord that their own binding is different. */
export function defaultChordFor(commandId: string): readonly string[] | null {
  return DEFAULT_KEYBINDINGS.find((binding) => binding.commandId === commandId)?.chord ?? null
}

// ---------------------------------------------------------------------------
// The effective (loaded, possibly user-overridden) keybindings — a
// subscribable module-level store, same shape `theme.ts`/`layoutStore.ts`
// already use for state a command sets and a component displays. R65 §2:
// before this existed, `App.tsx`'s `useKeymap` was the *only* reader of
// `loadKeybindings()`'s result, kept in a private `let` inside its own
// effect closure — every chord this app ever displayed (palette hints,
// title-bar tooltips) came from `defaultChordFor` instead, silently wrong
// for any binding a user had overridden. `useKeymap` now reads from here
// too, so there is one source of truth rather than two.

const effectiveListeners = new Set<() => void>()
let effectiveBindings: readonly KeyBinding[] = DEFAULT_KEYBINDINGS

/** The currently-loaded bindings — `DEFAULT_KEYBINDINGS` until
 * `loadKeybindings()`'s promise resolves (the same async window
 * `App.tsx`'s own comment already documents), the merged result after. */
export function getKeybindings(): readonly KeyBinding[] {
  return effectiveBindings
}

/** Called once, by whoever owns the load (`App.tsx`'s `useKeymap`) — not
 * exported for general use beyond that, since a second caller resolving a
 * second, differently-scoped load would just race the first. */
export function setKeybindings(bindings: readonly KeyBinding[]): void {
  effectiveBindings = bindings
  for (const listener of effectiveListeners) listener()
}

export function subscribeKeybindings(listener: () => void): () => void {
  effectiveListeners.add(listener)
  return () => effectiveListeners.delete(listener)
}

/** The effective chord bound to `commandId` right now — `getKeybindings()`'s
 * own list, not `DEFAULT_KEYBINDINGS`. What every *display* surface should
 * call (the palette, title-bar tooltips, R65's shortcuts panel); `defaultChordFor`
 * remains correct for anything that specifically wants the shipped default
 * regardless of what the user changed (there is no such caller today, but
 * the distinction is real, so both stay). */
export function effectiveChordFor(commandId: string): readonly string[] | null {
  return getKeybindings().find((binding) => binding.commandId === commandId)?.chord ?? null
}

/** Test-only: resets the effective-bindings store between test cases. */
export function resetKeybindingsStoreForTests(): void {
  effectiveBindings = DEFAULT_KEYBINDINGS
  effectiveListeners.clear()
}

/** Later entries win on a `commandId` collision — how a user override
 * replaces a default without needing to know the rest of the defaults. */
function mergeBindings(
  base: readonly KeyBinding[],
  overrides: readonly KeyBinding[]
): KeyBinding[] {
  const byCommand = new Map<string, KeyBinding>()
  for (const binding of [...base, ...overrides]) byCommand.set(binding.commandId, binding)
  return [...byCommand.values()]
}

function isKeyBindingArray(value: unknown): value is KeyBinding[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { commandId?: unknown }).commandId === 'string' &&
        Array.isArray((entry as { chord?: unknown }).chord) &&
        (entry as { chord: unknown[] }).chord.every((part) => typeof part === 'string')
    )
  )
}

/** Reads user overrides from disk (via the main process) and merges them
 * over the defaults. Resolves to just the defaults if there's no override
 * file, the API isn't available (e.g. under Vitest), the IPC call itself
 * fails, or the file is malformed — nothing about a keybindings problem
 * should be able to brick startup, so every failure mode here degrades
 * rather than rejects. */
export async function loadKeybindings(): Promise<KeyBinding[]> {
  const api = getKladosApi()
  if (api === undefined) return [...DEFAULT_KEYBINDINGS]

  try {
    const raw = await api.keybindings.read()
    if (raw === null) return [...DEFAULT_KEYBINDINGS]
    const parsed: unknown = JSON.parse(raw)
    if (!isKeyBindingArray(parsed)) return [...DEFAULT_KEYBINDINGS]
    return mergeBindings(DEFAULT_KEYBINDINGS, parsed)
  } catch {
    return [...DEFAULT_KEYBINDINGS]
  }
}

/** Persists `overrides` as the complete override file (not a diff against
 * defaults) — simpler to reason about, and the file is small either way. */
export async function saveKeybindingOverrides(overrides: readonly KeyBinding[]): Promise<void> {
  const api = getKladosApi()
  if (api === undefined) return
  await api.keybindings.write(JSON.stringify(overrides, null, 2))
}

// ---------------------------------------------------------------------------
// The chord-matching state machine.

export interface KeymapController {
  /** Returns `true` if the event was consumed (and thus `preventDefault`
   * should be — and was — called on it). */
  handleKeyDown(event: KeyboardEvent): boolean
  /** The first combo of a chord in progress, or `null`. Exposed so a
   * future UI can show a pending-chord indicator (D4's own acceptance
   * criterion — "a half-entered chord is visible rather than mysterious"). */
  readonly pendingChord: string | null
  dispose(): void
}

export function createKeymapController(getBindings: () => readonly KeyBinding[]): KeymapController {
  let pending: {
    readonly firstCombo: string
    readonly timer: ReturnType<typeof setTimeout>
  } | null = null

  function cancelPending(): void {
    if (pending === null) return
    clearTimeout(pending.timer)
    pending = null
  }

  /** Whether `commandId` is registered and its `when` (if any) currently
   * passes — the single source of truth both branches below fire from, so
   * a chord-completion and a single-key match can't disagree about it. */
  function canFire(commandId: string): boolean {
    const command = getCommand(commandId)
    if (command === undefined) return false
    return command.when === undefined || compileContextExpression(command.when)(getContext())
  }

  function fire(commandId: string): void {
    getCommand(commandId)?.run({ context: getContext(), session: activeSession })
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    const combo = normalizeKeyCombo(event)
    if (combo === null) return false

    const bindings = getBindings()

    if (pending !== null) {
      const firstCombo = pending.firstCombo
      cancelPending()
      const match = bindings.find((b) => b.chord[0] === firstCombo && b.chord[1] === combo)
      if (match !== undefined && canFire(match.commandId)) {
        event.preventDefault()
        fire(match.commandId)
        return true
      }
      // Mistyped chord, or the matched command's `when` doesn't currently
      // pass: cancel cleanly (D4's acceptance criterion) rather than
      // falling through to also try matching `combo` as a fresh chord
      // start below — a slip while typing a chord shouldn't accidentally
      // trigger an unrelated single-key binding.
      event.preventDefault()
      return true
    }

    const exact = bindings.find((b) => b.chord.length === 1 && b.chord[0] === combo)
    // `canFire` here, not just at completion: a single-key binding whose
    // `when` is false lets the key through (see below), so a chord whose
    // `when` is false must not swallow the first keypress either — and
    // once pending, the branch above swallows the second one too. Without
    // this, a disabled chord command eats two keystrokes while a disabled
    // single-key command eats none.
    const chordStart = bindings.some(
      (b) => b.chord.length === 2 && b.chord[0] === combo && canFire(b.commandId)
    )

    if (chordStart) {
      event.preventDefault()
      pending = {
        firstCombo: combo,
        timer: setTimeout(cancelPending, CHORD_TIMEOUT_MS)
      }
      return true
    }

    if (exact !== undefined && canFire(exact.commandId)) {
      event.preventDefault()
      fire(exact.commandId)
      return true
    }

    return false
  }

  return {
    handleKeyDown,
    get pendingChord() {
      return pending?.firstCombo ?? null
    },
    dispose: cancelPending
  }
}
