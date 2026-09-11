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
 * R194. Filters for Save As: **the file's own extension, then All files.**
 *
 * Note what it does not take — a `formatId`. Save As needs no format knowledge
 * at all, and an earlier version of this function that took one was wrong in a
 * way worth recording, because the mistake is easy to repeat.
 *
 * It offered every extension the document's format declares, leading with the
 * file's own. That conflates two different questions.
 * `FormatCapabilities.extensions` answers *"which files can this format
 * open?"*; Save As asks *"which extensions may this document be written
 * under?"*. For CSV the first list is `.csv`, `.tsv`, `.tab` — so a
 * comma-delimited document was offered `.tsv`, **implying a conversion that
 * cannot happen**: invariant 6 means Save writes the byte buffer verbatim, so
 * the result is a file full of commas called `.tsv`. Nothing in this app breaks
 * (`sniffDialect` reads the delimiter from content and never from the name),
 * but every other tool trusts the extension.
 *
 * The other half of the same conflation: an `.abc` file that happens to contain
 * XML is opened by content, and its author has a reason for calling it `.abc`.
 * Offering `.xml`, `.xsd` and `.svg` there — a list the document has nothing to
 * do with — is a guess where the file already gave the answer.
 *
 * So: whatever the file is called now, plus `*.*`. An extension this app has
 * never heard of is carried through unchanged, which is the point.
 *
 * **A file with no extension gets All files alone.** There is no current ending
 * to offer, and inventing the format's canonical one is the same guess in
 * smaller clothing — someone who opened a file called `data` did so knowing it
 * had no extension.
 */
export function saveAsDialogFilters(fileName: string): readonly DialogFilter[] {
  const current = extensionOf(fileName)
  if (current === null) return [ALL_FILES]
  return [{ name: `${current.toUpperCase()} files`, extensions: [current] }, ALL_FILES]
}
