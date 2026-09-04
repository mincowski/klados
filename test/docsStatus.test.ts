/**
 * `docs/TASKS.md` is the single source of truth for what is built and what is
 * not. This asserts it actually is one.
 *
 * The problem it exists for: status used to be recorded in four places —
 * `CLAUDE.md`'s status table, `CLAUDE.md`'s doc map, `docs/TASKS.md`, and each
 * plan document's own prose header — so a round that landed had four places to
 * update and one always got missed. R50 corrected eleven such contradictions by
 * hand; M5 was listed as "partly open" for months after every one of its tasks
 * had shipped, and R60 was stale again one commit after it landed.
 *
 * Prose cannot be checked (an attempt to grep for it produced 80% false
 * positives — "open" appears in ordinary sentences), so every plan document
 * carries a machine-readable marker instead and the board is derived from it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PLANS_DIR = 'docs/plans'
const TASKS = 'docs/TASKS.md'

const VALID_STATUSES = ['built', 'built-caveat', 'open', 'closed', 'superseded'] as const
type Status = (typeof VALID_STATUSES)[number]

const BADGE: Record<Status, string> = {
  built: 'built',
  'built-caveat': 'built ⚠',
  open: '**OPEN**',
  closed: 'closed',
  superseded: 'superseded'
}

const tasks = readFileSync(TASKS, 'utf8')

/** Plan documents that carry a marker, keyed by filename. */
function markers(): Map<string, Status> {
  const out = new Map<string, Status>()
  for (const file of readdirSync(PLANS_DIR)) {
    if (!file.endsWith('.md')) continue
    const body = readFileSync(`${PLANS_DIR}/${file}`, 'utf8')
    const m = /<!-- status: ([a-z-]+) -->/.exec(body)
    if (m) out.set(file, m[1] as Status)
  }
  return out
}

/**
 * Board rows: filename -> the badge text the board claims for it.
 *
 * Scoped to the Board section on purpose. The "Historical ids" table further
 * down is `| letter | milestone | plan |`, whose third cell is also a plan
 * path — parsing the whole file reads its *milestone* column as a status.
 */
function boardRows(): Map<string, string> {
  const out = new Map<string, string>()
  const section = tasks.slice(tasks.indexOf('## Board'), tasks.indexOf('## Owed'))
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split('|').map((c) => c.trim())
    // R-range board rows are | range | status | home |; milestone rows are | home | status |
    const rHome = /docs\/plans\/([A-Za-z0-9-]+\.md)/.exec(cells[3] ?? '')?.[1]
    if (rHome !== undefined) {
      out.set(rHome, cells[2] ?? '')
      continue
    }
    const mHome = /docs\/plans\/([A-Za-z0-9-]+\.md)/.exec(cells[1] ?? '')?.[1]
    const mStatus = cells[2] ?? ''
    if (mHome !== undefined && VALID_STATUSES.some((s) => mStatus.includes(s))) {
      out.set(mHome, mStatus)
    }
  }
  return out
}

describe('docs/TASKS.md is the single source of truth for status', () => {
  it('every plan document carries a valid status marker', () => {
    const found = markers()
    const missing: string[] = []
    for (const file of readdirSync(PLANS_DIR)) {
      if (!file.endsWith('.md')) continue
      // Results documents are records of a round, not the round's home.
      if (file.endsWith('-RESULTS.md')) continue
      if (!found.has(file)) missing.push(file)
    }
    expect(missing, `plan documents with no <!-- status: … --> marker`).toEqual([])

    for (const [file, status] of found) {
      expect(VALID_STATUSES, `${file} has an unknown status "${status}"`).toContain(status)
    }
  })

  it('the board agrees with every marker', () => {
    const found = markers()
    const board = boardRows()
    const disagreements: string[] = []

    for (const [file, status] of found) {
      const claimed = board.get(file)
      if (claimed === undefined) {
        disagreements.push(`${file}: marker says "${status}" but the board has no row for it`)
        continue
      }
      if (!claimed.includes(BADGE[status])) {
        disagreements.push(`${file}: marker says "${status}", board says "${claimed}"`)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('every built-caveat document has at least one Owed entry naming it', () => {
    const owedSection = tasks.slice(tasks.indexOf('## Owed'), tasks.indexOf('## Allocated'))
    expect(owedSection.length, 'the Owed section is missing').toBeGreaterThan(0)

    const undocumented: string[] = []
    for (const [file, status] of markers()) {
      if (status !== 'built-caveat') continue
      if (!owedSection.includes(file)) undocumented.push(file)
    }
    expect(
      undocumented,
      'a document marked built-caveat owes something; say what in the Owed table'
    ).toEqual([])
  })

  it('every path the board points at resolves', () => {
    // Scoped to the board, not the whole file. The register below it legitimately
    // quotes pre-restructure paths when describing the move that changed them —
    // an earlier version of this test checked the whole file and failed on R77's
    // own register row, which says where `docs/ICONS.md` went.
    const section = tasks.slice(tasks.indexOf('## Board'), tasks.indexOf('## Owed'))
    const missing: string[] = []
    for (const m of section.matchAll(/`(docs\/[A-Za-z0-9/-]+\.md)`/g)) {
      const p = m[1]
      if (p === undefined) continue
      if (!existsSync(p)) missing.push(p)
    }
    expect(missing, 'board rows pointing at files that do not exist').toEqual([])
  })
})
