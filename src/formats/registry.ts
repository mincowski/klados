import type { FormatCapabilities, FormatModule } from '../core/types'
import { csvFormatModule } from './csv/index'
import { jsonFormatModule } from './json/index'
import { tomlFormatModule } from './toml/index'
import { xmlFormatModule } from './xml/index'

const REGISTERED_FORMATS: readonly FormatModule[] = [
  xmlFormatModule,
  jsonFormatModule,
  tomlFormatModule,
  csvFormatModule
]

const CONFIDENCE_THRESHOLD = 0.5

export function selectFormat(head: Uint8Array, filename: string | null): FormatModule | null {
  let best: FormatModule | null = null
  let bestConfidence = CONFIDENCE_THRESHOLD

  for (const format of REGISTERED_FORMATS) {
    const confidence = format.detect(head, filename)
    if (confidence > bestConfidence) {
      best = format
      bestConfidence = confidence
    }
  }
  return best
}

/**
 * Looks up a format's `FormatCapabilities` by the id an already-open
 * document carries (`OpenDocument.formatId`) — this, not a view testing
 * the id itself, is how invariant 8 wants format-varying UI decided (the
 * Detail view's scalar-facets table, D9). Undefined only if a document
 * somehow carries an id no registered module declares, which can't happen
 * for a document this app actually opened.
 */
export function getFormatCapabilities(formatId: string): FormatCapabilities | undefined {
  return REGISTERED_FORMATS.find((format) => format.capabilities.id === formatId)?.capabilities
}

/**
 * The full `FormatModule` (not just its capabilities) for an already-open
 * document's `formatId` — M3-PLAN.md F10/D-036's `spliceSubtree` wiring
 * needs `.parseRange`/`.resumeContextFor`, which `getFormatCapabilities`
 * deliberately doesn't expose. Same "undefined only if a document somehow
 * carries an id no registered module declares" guarantee as
 * `getFormatCapabilities` — can't happen for a document this app opened.
 */
export function getFormatModule(formatId: string): FormatModule | undefined {
  return REGISTERED_FORMATS.find((format) => format.capabilities.id === formatId)
}

/**
 * The extensions every registered format actually claims, for the "could not detect a
 * format" message (R148, `docs/plans/R145-csv.md` §5) — CSV made this failure visible
 * (a `.dat`/`.txt` file, or any extensionless file whose first byte identifies nothing,
 * was already unopenable; CSV has no content check at all, per §5, so it hits this path
 * far more often). There is still no manual "Open As…" override anywhere in the app —
 * that is a separate, larger task — so this only turns a dead end into a hint about
 * which extensions *are* recognized, rather than adding a new affordance.
 */
export function supportedExtensionsList(): string {
  return REGISTERED_FORMATS.flatMap((format) => format.capabilities.extensions).join(', ')
}

/**
 * A file-type entry for a native file dialog, in Electron's own shape —
 * `extensions` carry **no leading dot**, which is the one thing about
 * `FileFilter` that is easy to get wrong and produces a dialog that silently
 * matches nothing.
 *
 * Declared here rather than imported from Electron so this module stays
 * Electron-free (it is imported by the worker and by tests), and so the value
 * is plain serializable data that can cross IPC.
 */
export interface DialogFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

const ALL_FILES: DialogFilter = { name: 'All files', extensions: ['*'] }

/** `.tsv` → `tsv`. Electron's `FileFilter` wants the extension undotted. */
function undotted(extension: string): string {
  return extension.startsWith('.') ? extension.slice(1) : extension
}

/**
 * The extension of `fileName`, undotted and lowercased, or `null` when it has
 * none. Deliberately not `path.extname` — this module is imported by the
 * renderer and the worker, neither of which has `node:path`.
 */
function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  // `-1` is no dot at all; `0` is a dotfile (`.gitignore`), whose leading dot
  // names the file rather than typing it.
  if (dot <= 0 || dot === fileName.length - 1) return null
  return fileName.slice(dot + 1).toLowerCase()
}

/**
 * R194. Filters for the Open dialog, derived rather than hand-maintained.
 *
 * This list used to be a literal in `main/documents.ts` —
 * `['xml', 'json', 'toml', 'csv', 'tsv', 'tab']` under the name
 * `'XML/JSON/TOML/CSV documents'` — which was exactly right, and had no way of
 * staying that way: registering a format does not make anyone revisit the main
 * process, and the *name* drifts as readily as the extensions. Both halves now
 * follow `REGISTERED_FORMATS`.
 */
export function openDialogFilters(): readonly DialogFilter[] {
  const names = REGISTERED_FORMATS.map((format) => format.capabilities.displayName)
  const extensions = REGISTERED_FORMATS.flatMap((format) =>
    format.capabilities.extensions.map(undotted)
  )
  return [{ name: `${names.join('/')} documents`, extensions }, ALL_FILES]
}

/**
 * R194. Filters for Save As on an open document.
 *
 * **The document's own extension leads**, because Electron appends the *first*
 * extension of the selected filter when the user types a bare name. Every
 * format but CSV declares a single extension today, so the rule is currently
 * invisible — but CSV declares `.csv`, `.tsv` and `.tab`, and saving a `.tsv`
 * file must not quietly turn it into a `.csv`. `core/types.ts` gives
 * `[".xml", ".xsd", ".svg"]` as the shape it expects, so this stops being
 * invisible the moment any format declares its second extension.
 *
 * A file with no extension, or one the format does not declare, gets the
 * format's first — there is no better answer, and it is what the old
 * behaviour (nothing at all) failed to provide.
 *
 * An unknown `formatId` yields All-files alone: the previous behaviour, rather
 * than a throw, for a case `getFormatCapabilities` documents as impossible for
 * a document this app actually opened.
 */
export function saveAsDialogFilters(formatId: string, fileName: string): readonly DialogFilter[] {
  const capabilities = getFormatCapabilities(formatId)
  if (capabilities === undefined) return [ALL_FILES]

  const declared = capabilities.extensions.map(undotted)
  const current = extensionOf(fileName)
  const ordered =
    current !== null && declared.includes(current)
      ? [current, ...declared.filter((extension) => extension !== current)]
      : declared

  return [{ name: `${capabilities.displayName} documents`, extensions: ordered }, ALL_FILES]
}
