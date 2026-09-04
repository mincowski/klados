/**
 * Encoding detection. Order of precedence: BOM, then a format's declared
 * encoding (e.g. the XML prolog), then UTF-8.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

function matchesBom(head: Uint8Array, bom: readonly number[]): boolean {
  if (head.length < bom.length) return false
  for (let i = 0; i < bom.length; i++) {
    if (head[i] !== bom[i]) return false
  }
  return true
}

function detectBom(head: Uint8Array): { encoding: string; length: number } | null {
  // UTF-16LE's BOM (FF FE) is a prefix of UTF-8's BOM only in the BE case
  // (FE FF), so UTF-8 must be checked first to avoid misreading it as UTF-16BE.
  if (matchesBom(head, UTF8_BOM)) return { encoding: 'utf-8', length: 3 }
  if (matchesBom(head, UTF16LE_BOM)) return { encoding: 'utf-16le', length: 2 }
  if (matchesBom(head, UTF16BE_BOM)) return { encoding: 'utf-16be', length: 2 }
  return null
}

export function detectEncoding(head: Uint8Array, declared: string | null): string {
  const bom = detectBom(head)
  if (bom !== null) return bom.encoding
  if (declared !== null) return declared
  return 'utf-8'
}

export function stripBom(bytes: Uint8Array): { bytes: Uint8Array; bomLength: number } {
  const bom = detectBom(bytes)
  const bomLength = bom?.length ?? 0
  return { bytes: bytes.subarray(bomLength), bomLength }
}

/**
 * Length of a BOM at offset 0, or 0. Used by parsers to skip a leading BOM
 * in place — spans stay absolute in the original buffer (C1), so nothing
 * ever slices it off.
 */
export function bomLengthAt(bytes: Uint8Array): number {
  return detectBom(bytes)?.length ?? 0
}
