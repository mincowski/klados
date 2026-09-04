/**
 * M5d-PLAN.md R5 — middle truncation for a filename, "never end
 * truncation" (`CONCEPT.md` §11.4: the end of a filename carries the
 * extension and usually the version or date). Built once here so §11.4's
 * tab strip inherits it rather than growing its own copy later.
 *
 * Deliberately not canvas-measured: splitting off a fixed-length tail and
 * letting CSS `text-overflow: ellipsis` truncate the (flex-shrinkable)
 * head is what actually produces "ellipsis appears before the tail,
 * however narrow the container gets" without a measurement pass on every
 * resize — see `TitleBar.css`'s `.title-bar-title-head`/`-tail`.
 */
export interface MiddleTruncationParts {
  /** CSS-truncated (ellipsis) when the container is too narrow. Empty
   * string when `text` is no longer than `tailChars`. */
  readonly head: string
  /** Never truncated — always fully visible. */
  readonly tail: string
}

/** Long enough to keep a typical extension plus a few characters of stem
 * visible (`report-v2.xml` stays whole; only genuinely long names split). */
const DEFAULT_TAIL_CHARS = 12

export function splitForMiddleTruncation(
  text: string,
  tailChars: number = DEFAULT_TAIL_CHARS
): MiddleTruncationParts {
  if (text.length <= tailChars) return { head: '', tail: text }
  return { head: text.slice(0, text.length - tailChars), tail: text.slice(text.length - tailChars) }
}
