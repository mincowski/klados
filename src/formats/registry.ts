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
