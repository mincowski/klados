/**
 * M5d-PLAN.md R2 — pulled out of `Layout.tsx` once the title bar became a
 * second surface that needs the exact same "run a command, show its chord"
 * behaviour `PaneShell`/`CommandBar` already had. Keeping one copy is what
 * guarantees `tooltipFor`'s shape (`"Title (Chord)"`, D-055's "every
 * title-bar button keeps its chord in the tooltip") can't drift between
 * the two call sites the way a copy-pasted helper eventually would.
 */
import { getContext } from './context'
import { effectiveChordFor, formatChord } from './keybindings'
import type { AppContext, Command } from './registry'
import { activeSession } from '../session/activeSession'

/** "Title (Chord)" when a keybinding exists, just the title otherwise — the
 * tooltip shape everywhere a command renders as an icon rather than text,
 * so the label a text button used to show is never actually lost, just
 * moved (UI-FEEDBACK.md). `effectiveChordFor`, not `defaultChordFor`, since
 * R65 (`R65-shortcuts-help.md` §2) — a tooltip showing a chord a user
 * has since overridden is confidently wrong, not just imprecise.
 *
 * R68 (`R66-palette-polish.md` §3's own refinement): a toggle command's
 * stored title is now the *noun* (`Soft Wrap`, not `Toggle Soft Wrap`), so
 * an icon-only button — the only place that title renders bare, with no
 * On/Off state alongside it — needs the verb supplied back. `state !==
 * undefined` is exactly "this is a toggle" (the field's own contract), so
 * this is the one place besides the palette that reads it. */
export function tooltipFor(command: Command): string {
  const title = command.state !== undefined ? `Toggle ${command.title}` : command.title
  const chord = effectiveChordFor(command.id)
  return chord === null ? title : `${title} (${formatChord(chord)})`
}

export function runCommand(command: Command): void {
  command.run({ context: getContext(), session: activeSession } satisfies AppContext)
}
