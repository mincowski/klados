/**
 * Pure logic for the command palette (M1-PLAN.md D5, CONCEPT.md §7's
 * "Command palette" section): prefix-mode parsing, fuzzy matching over
 * command titles, and ranking. Kept free of React and the DOM (besides
 * `localStorage`, guarded the same way `theme.ts` guards it) so it can be
 * exercised directly by `test/palette.test.ts` without a renderer.
 */
import type { Command } from '../../commands/registry'
import type { Pane } from '../../focus'

export type PaletteMode = 'command' | 'jumpToNode' | 'goToPosition' | 'pathQuery'

/**
 * R69 (`R69-focus-and-find.md` §1): which pane a palette jump lands
 * keyboard focus in once it completes — Tree for `@`/`/` (both name
 * *nodes*), Raw for `:` (which names a *position*, the plan's own
 * recommendation). `'command'` is excluded from the parameter type rather
 * than handled at runtime: an ordinary command run restores focus to
 * wherever it was instead of jumping anywhere, a different code path
 * (`Palette.tsx`'s `closeRestoringFocus`) that never calls this at all —
 * excluding it here means a future call site that tries anyway is a
 * compile error, not a silent wrong answer.
 */
export function paneForPaletteJump(mode: Exclude<PaletteMode, 'command'>): Pane {
  return mode === 'goToPosition' ? 'raw' : 'tree'
}

export interface ParsedPaletteInput {
  readonly mode: PaletteMode
  /** The input with its mode prefix (`@`, `:` or `/`) stripped. Equal to
   * the raw input in `'command'` mode, which has no prefix of its own
   * (§7: `>` is the *default* mode, not a required character). */
  readonly query: string
}

/**
 * `>` is accepted as an explicit prefix for the default mode too, so a
 * user who types it (matching the other modes' shape) isn't punished for
 * it — it's stripped just like `@`/`:`/`/` are.
 *
 * `/` (M4-PLAN.md G9): the Klados path query mode — its sibling to `@`'s
 * exact name lookup (G1), reusing the same prefix-mode machinery rather
 * than a second entry point. `/` reads naturally for a query language
 * whose own grammar is built from `/`-separated steps (§6.3) — a query
 * typed here, `/`-prefix included, is often a valid path expression
 * verbatim.
 */
export function parsePaletteInput(input: string): ParsedPaletteInput {
  if (input.startsWith('@')) return { mode: 'jumpToNode', query: input.slice(1) }
  if (input.startsWith(':')) return { mode: 'goToPosition', query: input.slice(1) }
  if (input.startsWith('/')) return { mode: 'pathQuery', query: input.slice(1) }
  if (input.startsWith('>')) return { mode: 'command', query: input.slice(1) }
  return { mode: 'command', query: input }
}

export interface FuzzyMatch {
  readonly score: number
  readonly indices: readonly number[]
}

/**
 * Subsequence fuzzy match: every character of `query` must appear in
 * `target`, in order, but not necessarily contiguously. Scores contiguous
 * runs and word-boundary starts higher, and prefers matches that start
 * earlier in the target — enough to make "commonly expected result floats
 * to the top" true without pulling in a matching library for ~30 lines.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, indices: [] }

  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices: number[] = []
  let qi = 0
  let score = 0
  let previousMatchIndex = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    indices.push(ti)
    let charScore = 1
    if (previousMatchIndex === ti - 1) charScore += 2
    if (ti === 0 || /[\s\-_/]/.test(t[ti - 1] ?? '')) charScore += 1
    score += charScore
    previousMatchIndex = ti
    qi++
  }

  if (qi < q.length) return null
  score -= indices[0]! * 0.1
  return { score, indices }
}

/** `${category}: ${title}`, VS Code's own shape ("View: Toggle Word Wrap")
 * — R66 (`R66-palette-polish.md` §1). One function, used for both
 * matching and rendering, so the string the user sees is always the exact
 * one `fuzzyMatch` scored: computing it twice (once to match, once to
 * display) is how the highlighted-character-index mismatch §1 warns about
 * would actually happen. */
export function paletteLabel(command: Command): string {
  return `${command.category}: ${command.title}`
}

export interface RankedCommand {
  readonly command: Command
  readonly score: number
  readonly indices: readonly number[]
  /** `paletteLabel(command)` — carried alongside rather than recomputed at
   * each render/highlight call site, so a caller can't accidentally
   * highlight indices from one string against a different one. */
  readonly label: string
}

/**
 * Filters `commands` to those whose **`Category: Title`** fuzzy-matches
 * `query` (all of them, when `query` is empty) — R66: matching only the
 * title left every category's own name unsearchable (`view` matched
 * nothing in the View category unless the word also happened to be in a
 * command's own name). Sorts: commands with a recency rank (`recencyRank`
 * returns a non-negative index, most-recent first) sort ahead of everything
 * else in that order, and the remainder sort by fuzzy score descending.
 * `recencyRank` returning `-1` means "never used".
 */
export function rankCommands(
  commands: readonly Command[],
  query: string,
  recencyRank: (id: string) => number
): RankedCommand[] {
  const results: RankedCommand[] = []
  for (const command of commands) {
    const label = paletteLabel(command)
    const match = fuzzyMatch(query, label)
    if (match === null) continue
    results.push({ command, score: match.score, indices: match.indices, label })
  }

  results.sort((a, b) => {
    const ra = recencyRank(a.command.id)
    const rb = recencyRank(b.command.id)
    if (ra !== -1 && rb !== -1 && ra !== rb) return ra - rb
    if (ra !== -1 && rb === -1) return -1
    if (ra === -1 && rb !== -1) return 1
    return b.score - a.score
  })

  return results
}

// ---------------------------------------------------------------------------
// Recency, persisted across sessions (D5's own acceptance criterion). Same
// `localStorage`-with-a-guard shape as theme.ts, so it degrades to
// "no recency" rather than throwing under Vitest or a locked-down webview.

const RECENCY_STORAGE_KEY = 'klados.palette.recency'
const RECENCY_LIMIT = 50

function readPersistedRecency(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(RECENCY_STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) return []
    return parsed as string[]
  } catch {
    return []
  }
}

let recency: string[] = readPersistedRecency()

function persistRecency(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(RECENCY_STORAGE_KEY, JSON.stringify(recency))
}

/** Call when a command is actually run from the palette — not on every
 * keystroke, and not for commands run via a keybinding or another surface,
 * per §7's "recently-used commands" meaning *palette* usage. */
export function recordRecentCommand(id: string): void {
  recency = [id, ...recency.filter((existing) => existing !== id)].slice(0, RECENCY_LIMIT)
  persistRecency()
}

/** Index into recency order (0 = most recently used), or `-1` if `id` has
 * never been run from the palette. */
export function getRecencyRank(id: string): number {
  return recency.indexOf(id)
}

/** Test-only: clears in-memory and persisted recency between test cases. */
export function resetPaletteRecencyForTests(): void {
  recency = []
  if (typeof localStorage !== 'undefined') localStorage.removeItem(RECENCY_STORAGE_KEY)
}
