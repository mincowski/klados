/**
 * R65 (`R65-shortcuts-help.md`) — the keyboard shortcuts panel.
 * Reuses `Palette.tsx`'s own shape (overlay, focus containment, Escape to
 * close, restoring focus to wherever it came from) rather than inventing a
 * second one — the hard parts are already solved there.
 *
 * Two kinds of key, per §3, and the panel is honest about the difference:
 *
 * **Derived** — every registered command with an effective chord
 * (`getKeybindings()`, not `DEFAULT_KEYBINDINGS` — R65's own §2 finding is
 * that the two can disagree once a user overrides one), grouped by
 * `Command.category`. Cannot drift from what the app actually does, the
 * same reason invariant 10 is enforced by test rather than by discipline.
 *
 * **Curated** — `IN_PANE_KEYS` below. None of Tree's arrows/Home/End/Enter
 * (`Tree.tsx`'s own `onKeyDown`), Grid's cell navigation plus its header
 * row (`Grid.tsx`'s own `onKeyDown`), Raw's Tab/Shift+Tab/Enter/Escape
 * (`components/Raw/rawKeymap.ts`), or the palette's own `@`/`/`/`:`/`>`
 * mode prefixes (`paletteLogic.ts`'s `parsePaletteInput` — R70, `R69-focus-and-find.md`
 * §2's own closing note) is a registered command, so none of them can be
 * derived — hand-maintained deliberately, per §3b, rather than via a test
 * that parses `switch (event.key)` blocks, which would be worse than the
 * drift it prevents.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import {
  effectiveChordFor,
  formatChord,
  getKeybindings,
  subscribeKeybindings
} from '../../commands/keybindings'
import { getAllCommands, type Command } from '../../commands/registry'
import { Icon } from '../Icon/Icon'
import { closeShortcuts, isShortcutsOpen, subscribeShortcutsOpen } from './shortcutsStore'
import './Shortcuts.css'

interface InPaneGroup {
  readonly pane: string
  readonly file: string
  readonly keys: readonly { readonly keys: string; readonly does: string }[]
}

/** Curated, not derived — see this module's own top comment for why. Kept
 * in one place so the next person changing one of the three files below
 * has one place to update. */
const IN_PANE_KEYS: readonly InPaneGroup[] = [
  {
    pane: 'Tree',
    file: 'components/Tree/Tree.tsx',
    keys: [
      { keys: 'Up / Down', does: 'Move to the previous/next row' },
      { keys: 'Right', does: 'Expand, or move to the first child' },
      { keys: 'Left', does: 'Collapse, or move to the parent' },
      { keys: 'Home / End', does: 'Jump to the first/last visible row' },
      { keys: 'Enter / Space', does: 'Toggle expand/collapse' }
    ]
  },
  {
    pane: 'Detail (Grid)',
    file: 'components/Detail/Grid.tsx',
    keys: [
      { keys: 'Up / Down / Left / Right', does: 'Move the active cell' },
      { keys: 'Home / End', does: 'Jump to the first/last column' },
      { keys: 'Page Up / Page Down', does: 'Move by a page of rows' },
      { keys: 'Enter / Space', does: 'Open the active cell' },
      { keys: 'Up from the top row', does: 'Move into the column header' },
      { keys: 'Enter (header)', does: 'Toggle sort on the active column' },
      { keys: 'P (header)', does: 'Toggle pin on the active column' },
      { keys: 'Down (header)', does: 'Return to the body' }
    ]
  },
  {
    pane: 'Raw',
    file: 'components/Raw/rawKeymap.ts',
    keys: [
      { keys: 'Tab', does: 'Indent (or replace a selection on one line)' },
      { keys: 'Shift+Tab', does: 'Remove one level of indent' },
      { keys: 'Enter', does: "Insert a new line, carrying the current line's indent" },
      { keys: 'Escape, then Tab', does: 'Let Tab move focus out of Raw instead of indenting' }
    ]
  },
  {
    // R70 (`R69-focus-and-find.md` §2's own closing note): `@` and `/`
    // are palette *modes*, not registered commands, so the derived section
    // below will never find them on its own — the third instance of
    // "already built, undiscovered" this stretch turned up (after F6/
    // Ctrl+1-3, R61, and the arrow keys, R61 again), so it goes in the
    // curated table explicitly rather than staying invisible a fourth time.
    pane: 'Command Palette',
    file: 'components/Palette/paletteLogic.ts',
    keys: [
      { keys: '@name', does: 'Jump to a node by name' },
      { keys: '/path/query', does: 'Run a Klados path query' },
      { keys: ':42', does: 'Go to line 42 — or byte offset 42 in a document with no lines' },
      { keys: '>', does: 'Explicit command mode (the default with no prefix)' }
    ]
  },
  {
    // R121 (`R120-find-bar-keyboard.md` §7): the Find bar's own container
    // handler (`FindBar.tsx`'s `handleBarKeyDown`) — Tab order, Escape and
    // Ctrl+Alt+Enter are all handled locally, not as registered commands
    // (§4's own reasoning: none of them make sense invoked from outside an
    // open bar), so none of this is derivable either.
    pane: 'Find bar',
    file: 'components/Find/FindBar.tsx',
    keys: [
      { keys: 'Enter / Shift+Enter', does: 'Next / previous match (from the find field)' },
      {
        keys: 'Enter',
        does: 'Replace the current match and move to the next (from the replace field)'
      },
      { keys: 'Ctrl+Alt+Enter', does: 'Replace all' },
      {
        keys: 'Tab / Shift+Tab',
        does: "Cycle the bar's own controls — find, then replace, then the rest"
      },
      { keys: 'Escape', does: 'Close Find and return to the pane' },
      { keys: 'F6 or Ctrl+1/2/3', does: 'Leave the bar with it still open' }
    ]
  }
]

const CATEGORY_ORDER = ['File', 'Edit', 'Navigate', 'View', 'Help']

function getSnapshotFalse(): boolean {
  return false
}

export function Shortcuts(): JSX.Element | null {
  const open = useSyncExternalStore(subscribeShortcutsOpen, isShortcutsOpen, getSnapshotFalse)
  if (!open) return null
  return <ShortcutsContent />
}

function ShortcutsContent(): JSX.Element {
  // R65 §2: subscribed so an in-flight `loadKeybindings()` resolving while
  // this panel is open re-renders it with the real chords, not just
  // whatever `DEFAULT_KEYBINDINGS` looked like at the moment it opened.
  useSyncExternalStore(subscribeKeybindings, getKeybindings, getKeybindings)

  const [previouslyFocused] = useState<HTMLElement | null>(
    () => document.activeElement as HTMLElement | null
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => headingRef.current?.focus())

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', onPointerDown)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onPointerDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close() reads only refs/state via closures that don't need to retrigger this mount effect
  }, [])

  function close(): void {
    const stillFocusedInPanel = containerRef.current?.contains(document.activeElement) ?? false
    closeShortcuts()
    if (stillFocusedInPanel) previouslyFocused?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  // `getAllCommands()` filtered by surface, not `commandsForSurface` —
  // this panel is documentation, not a live filtered menu: a command whose
  // `when` is currently false (D-055's own "disabled, not hidden" for the
  // title bar) still has a real chord worth knowing, so it stays listed
  // rather than disappearing along with its own momentary availability.
  const byCategory = new Map<string, Command[]>()
  for (const command of getAllCommands()) {
    if (!command.surfaces.includes('palette')) continue
    const chord = effectiveChordFor(command.id)
    if (chord === null) continue
    const list = byCategory.get(command.category) ?? []
    list.push(command)
    byCategory.set(command.category, list)
  }
  const categories = [...byCategory.keys()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  )

  return (
    <div className="shortcuts-overlay" onKeyDown={onKeyDown}>
      <div
        className="shortcuts-panel"
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="klados-shortcuts-heading"
      >
        <div className="shortcuts-header">
          <h2 id="klados-shortcuts-heading" tabIndex={-1} ref={headingRef}>
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            className="shortcuts-close"
            aria-label="Close"
            onClick={() => close()}
          >
            <Icon name="dismiss" />
          </button>
        </div>
        <div className="shortcuts-body">
          <section className="shortcuts-section">
            <h3>In each pane</h3>
            {IN_PANE_KEYS.map((group) => (
              <div key={group.pane} className="shortcuts-pane-group">
                <h4>{group.pane}</h4>
                <table>
                  <tbody>
                    {group.keys.map((row) => (
                      <tr key={row.keys}>
                        <td className="shortcuts-key">{row.keys}</td>
                        <td>{row.does}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
          {categories.map((category) => (
            <section className="shortcuts-section" key={category}>
              <h3>{category}</h3>
              <table>
                <tbody>
                  {byCategory.get(category)!.map((command) => {
                    const chord = effectiveChordFor(command.id)!
                    return (
                      <tr key={command.id}>
                        <td className="shortcuts-key">{formatChord(chord)}</td>
                        <td>{command.title}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
