/**
 * R229 (`docs/plans/R229-release-token-scope.md` §3, criterion 1) — the
 * workflows hold no write token where third-party code runs, keep no token in
 * `.git/config`, and run only actions locked in `.github/workflows/actions.lock`.
 *
 * Read the way `packagedFiles.test.ts` reads `electron-builder.yml`: from the
 * file, with no YAML dependency. `js-yaml` is in `node_modules` only as a
 * transitive dependency, and importing it would be adding one without asking.
 * So `readYaml` reads **the subset these files use** (block mappings and
 * sequences, block scalars, quoted and plain scalars, flow sequences of plain
 * strings) and **throws on anything else**. A reader that returned something
 * plausible for a construct it did not understand would let a check pass on a
 * file it never read (FINDINGS: *a test helper that returns `false` for input
 * it does not recognize*).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Yaml = string | Yaml[] | { [key: string]: Yaml }

interface Line {
  readonly indent: number
  readonly text: string
  readonly number: number
}

/** Strips a trailing ` # comment` that is not inside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === '#' && (i === 0 || text[i - 1] === ' ')) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text
}

function scalar(raw: string, line: number): Yaml {
  const text = stripComment(raw).trim()
  if (/^[&*!]|^<<|^\{|^[|>]/.test(text)) {
    throw new Error(`readYaml: unsupported construct on line ${line}: ${text}`)
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`readYaml: multi-line flow sequence on line ${line}`)
    const inner = text.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((part) => scalar(part, line) as string)
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2)
      throw new Error(`readYaml: bad quote on line ${line}`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2)
      throw new Error(`readYaml: bad quote on line ${line}`)
    const inner = text.slice(1, -1)
    if (inner.includes('\\')) throw new Error(`readYaml: escapes are not supported, line ${line}`)
    return inner
  }
  return text
}

/** Parses `key: rest` without being fooled by a colon inside quotes or `${{ }}`. */
function keyValue(text: string, line: number): { key: string; rest: string } | null {
  const match = /^('[^']*'|"[^"]*"|[^\s'"#][^:#]*?):(?:\s+(.*))?$/.exec(text)
  if (match === null) return null
  const key = scalar(match[1]!, line)
  if (typeof key !== 'string') throw new Error(`readYaml: a non-string key on line ${line}`)
  return { key, rest: match[2] ?? '' }
}

export function readYaml(source: string): Yaml {
  const lines: Line[] = []
  source.split(/\r?\n/).forEach((raw, i) => {
    if (raw.includes('\t')) throw new Error(`readYaml: a tab on line ${i + 1}`)
    const trimmed = raw.trim()
    if (trimmed === '---' || trimmed === '...') throw new Error('readYaml: multiple documents')
    lines.push({
      indent: raw.length - raw.trimStart().length,
      text: raw.trimEnd().trimStart(),
      number: i + 1
    })
  })
  let at = 0
  const isContent = (l: Line): boolean => l.text !== '' && !l.text.startsWith('#')
  const skip = (): void => {
    while (at < lines.length && !isContent(lines[at]!)) at++
  }

  /** The lines of a block scalar: everything more indented than `parent`,
   * blank lines included, with the common indentation removed. */
  function blockScalar(parent: number, style: string): string {
    const body: Line[] = []
    while (at < lines.length && (lines[at]!.text === '' || lines[at]!.indent > parent)) {
      body.push(lines[at]!)
      at++
    }
    while (body.length > 0 && body[body.length - 1]!.text === '') body.pop()
    const base = Math.min(...body.filter((l) => l.text !== '').map((l) => l.indent))
    const raw = body.map((l) => (l.text === '' ? '' : ' '.repeat(l.indent - base) + l.text))
    const joined = style.startsWith('>') ? raw.join(' ') : raw.join('\n')
    return style.endsWith('-') ? joined : `${joined}\n`
  }

  /** The value after `key:` on a line at `indent`. */
  function valueAfter(rest: string, indent: number, line: number): Yaml {
    const value = stripComment(rest).trim()
    if (/^[|>]-?$/.test(value)) return blockScalar(indent, value)
    if (value !== '') return scalar(value, line)
    skip()
    const next = lines[at]
    if (next !== undefined && next.indent > indent) return block(next.indent)
    if (next !== undefined && next.indent === indent && next.text.startsWith('- ')) {
      return block(indent)
    }
    // `pull_request:` with nothing after it: YAML's null, read as empty.
    return ''
  }

  function block(indent: number): Yaml {
    skip()
    const first = lines[at]!
    if (first.indent !== indent)
      throw new Error(`readYaml: bad indentation on line ${first.number}`)
    if (first.text === '-' || first.text.startsWith('- ')) {
      const items: Yaml[] = []
      while (at < lines.length) {
        skip()
        const line = lines[at]
        if (line === undefined || line.indent !== indent || !line.text.startsWith('- ')) break
        const rest = line.text.slice(2)
        if (keyValue(rest, line.number) !== null) {
          // `- key: value` opens a mapping two columns in; re-read the line there.
          lines[at] = { indent: indent + 2, text: rest, number: line.number }
          items.push(block(indent + 2))
        } else {
          at++
          items.push(scalar(rest, line.number))
        }
      }
      return items
    }
    const map: { [key: string]: Yaml } = {}
    while (at < lines.length) {
      skip()
      const line = lines[at]
      if (line === undefined || line.indent < indent) break
      if (line.indent > indent) throw new Error(`readYaml: bad indentation on line ${line.number}`)
      if (line.text.startsWith('- ')) break
      const pair = keyValue(line.text, line.number)
      if (pair === null) throw new Error(`readYaml: cannot read line ${line.number}: ${line.text}`)
      if (pair.key in map)
        throw new Error(`readYaml: duplicate key ${pair.key} on line ${line.number}`)
      at++
      map[pair.key] = valueAfter(pair.rest, indent, line.number)
    }
    return map
  }

  skip()
  const result = block(0)
  skip()
  if (at < lines.length) throw new Error(`readYaml: unread input from line ${lines[at]!.number}`)
  return result
}

function asMap(value: Yaml | undefined, what: string): { [key: string]: Yaml } {
  if (value === undefined || typeof value === 'string' || Array.isArray(value)) {
    throw new Error(`${what} is not a mapping`)
  }
  return value
}

function asList(value: Yaml | undefined, what: string): Yaml[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a sequence`)
  return value
}

const STEP_KEYS = new Set(['name', 'id', 'if', 'uses', 'run', 'with', 'env', 'shell'])

/** Every string in `value`, keys included. Not `JSON.stringify`: that writes
 * a newline as `\n`, so `npm` at the start of a line reads as `nnpm` and no
 * word boundary is found (the mutation check below caught exactly this). */
function stringsOf(value: Yaml): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  return Object.entries(value).flatMap(([k, v]) => [k, ...stringsOf(v)])
}

interface Step {
  readonly uses: string | null
  readonly run: string | null
  readonly with: { [key: string]: Yaml }
  /** Every string the step hands to the runner, for "does this step run X". */
  readonly text: string
}

/** A step as the checks need it. **Throws on a shape it does not know**: a
 * key outside `STEP_KEYS`, both `uses` and `run`, or neither. */
export function readStep(raw: Yaml, where: string): Step {
  const step = asMap(raw, where)
  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.has(key)) throw new Error(`${where}: unknown step key "${key}"`)
  }
  const uses = step.uses ?? null
  const run = step.run ?? null
  if ((uses === null) === (run === null))
    throw new Error(`${where}: needs exactly one of uses and run`)
  if (uses !== null && typeof uses !== 'string') throw new Error(`${where}: uses is not a string`)
  if (run !== null && typeof run !== 'string') throw new Error(`${where}: run is not a string`)
  const withMap = step.with === undefined ? {} : asMap(step.with, `${where}.with`)
  return { uses, run, with: withMap, text: stringsOf(step).join('\n') }
}

interface Workflow {
  readonly file: string
  readonly permissions: Yaml | undefined
  readonly jobs: { name: string; permissions: Yaml | undefined; steps: Step[] }[]
}

export function readWorkflow(file: string, source = readFileSync(file, 'utf8')): Workflow {
  const doc = asMap(readYaml(source), file)
  const jobs = Object.entries(asMap(doc.jobs, `${file} jobs`)).map(([name, raw]) => {
    const job = asMap(raw, `${file} job ${name}`)
    const steps = asList(job.steps, `${file} job ${name} steps`).map((s, i) =>
      readStep(s, `${file} job ${name} step ${i + 1}`)
    )
    return { name, permissions: job.permissions, steps }
  })
  return { file, permissions: doc.permissions, jobs }
}

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml']
const LOCKFILE = '.github/workflows/actions.lock'

/** Third-party code a write-token job must not run (§3 criterion 1). */
const THIRD_PARTY = /\bnpm\b|\bnpx\b|\bnode\b|electron-builder|actions\/checkout/

/** The findings for one workflow; empty when it holds. A function of the
 * source so the mutation checks below can run it on a changed copy. */
export function workflowFindings(file: string, source: string, lockSource: string): string[] {
  const findings: string[] = []
  const workflow = readWorkflow(file, source)
  const lock = asMap(readYaml(lockSource), LOCKFILE)
  const locked = asList(asMap(lock.workflows, 'lock workflows')[file] ?? [], `lock ${file}`)
  const dependencies = asMap(lock.dependencies, 'lock dependencies')

  const permissions = JSON.stringify(workflow.permissions)
  if (permissions !== JSON.stringify({ contents: 'read' })) {
    findings.push(`${file}: top-level permissions are ${permissions}, not contents: read`)
  }

  const writers = workflow.jobs.filter(
    (job) => job.permissions !== undefined && asMap(job.permissions, job.name).contents === 'write'
  )
  const expectedWriters = file.endsWith('release.yml') ? 1 : 0
  if (writers.length !== expectedWriters) {
    findings.push(`${file}: ${writers.length} jobs hold contents: write, not ${expectedWriters}`)
  }
  for (const job of writers) {
    for (const step of job.steps) {
      const hit = THIRD_PARTY.exec(step.text)
      if (hit !== null) findings.push(`${file}: the write job ${job.name} runs "${hit[0]}"`)
    }
  }

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (step.uses !== null) {
        if (!/^[\w.-]+\/[\w.-]+@v\d+\.\d+\.\d+$/.test(step.uses)) {
          findings.push(`${file}: ${step.uses} is not an exact version`)
        }
        if (!locked.includes(step.uses))
          findings.push(`${file}: ${step.uses} is not in the lockfile`)
        const entry = dependencies[step.uses]
        const commit = entry === undefined ? undefined : asMap(entry, step.uses).commit
        if (typeof commit !== 'string' || !/^sha1-[0-9a-f]{40}$/.test(commit)) {
          findings.push(`${file}: ${step.uses} has no locked 40-hex commit`)
        }
        if (
          step.uses.startsWith('actions/checkout@') &&
          step.with['persist-credentials'] !== 'false'
        ) {
          findings.push(`${file}: a checkout in ${job.name} keeps its credentials`)
        }
      }
      if (step.run !== null && step.run.includes('gh extension install github/gh-actions-lock')) {
        if (!/--pin v\d+\.\d+\.\d+/.test(step.run)) {
          findings.push(`${file}: gh-actions-lock is installed without --pin`)
        }
      }
    }
  }
  return findings
}

const lockSource = (): string => readFileSync(LOCKFILE, 'utf8')

describe('R229 — the workflows hold no write token where third-party code runs', () => {
  it.each(WORKFLOWS)('%s holds', (file) => {
    expect(workflowFindings(file, readFileSync(file, 'utf8'), lockSource())).toEqual([])
  })

  it('the checks see what they claim to: each workflow has steps, uses and a checkout', () => {
    // A reader that silently read nothing would make every check above pass.
    for (const file of WORKFLOWS) {
      const steps = readWorkflow(file).jobs.flatMap((job) => job.steps)
      expect(steps.length).toBeGreaterThan(5)
      expect(steps.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true)
    }
    expect(readWorkflow(WORKFLOWS[1]!).jobs.map((j) => j.name)).toEqual(['release', 'publish'])
  })

  // Each mutation reverts one of R229's changes in a copy of the real file,
  // and the findings must name it.
  const mutations: { name: string; file: string; from: string; to: string; finding: RegExp }[] = [
    {
      name: 'the workflow-level token raised to write',
      file: '.github/workflows/release.yml',
      from: 'permissions:\n  contents: read\n',
      to: 'permissions:\n  contents: write\n',
      finding: /top-level permissions/
    },
    {
      name: 'ci.yml without its permissions block',
      file: '.github/workflows/ci.yml',
      from: 'permissions:\n  contents: read\n',
      to: '',
      finding: /top-level permissions/
    },
    {
      name: 'the build job given the write token',
      file: '.github/workflows/release.yml',
      from: '    permissions:\n      contents: read\n\n    # Every leg',
      to: '    permissions:\n      contents: write\n\n    # Every leg',
      finding: /2 jobs hold contents: write/
    },
    {
      name: 'a checkout in the write job',
      file: '.github/workflows/release.yml',
      from: '      - name: Download the built files\n',
      to: '      - uses: actions/checkout@v7.0.1\n        with:\n          persist-credentials: false\n      - name: Download the built files\n',
      finding: /the write job publish runs "actions\/checkout"/
    },
    {
      name: 'npm in the write job',
      file: '.github/workflows/release.yml',
      from: '          set -euo pipefail\n          tag=',
      to: '          set -euo pipefail\n          npm ci\n          tag=',
      finding: /the write job publish runs "npm"/
    },
    {
      name: 'a checkout that keeps its credentials',
      file: '.github/workflows/ci.yml',
      from: '      - uses: actions/checkout@v7.0.1\n        with:\n          persist-credentials: false\n\n      # **The',
      to: '      - uses: actions/checkout@v7.0.1\n\n      # **The',
      finding: /keeps its credentials/
    },
    {
      name: 'a major-only tag',
      file: '.github/workflows/ci.yml',
      from: 'actions/setup-node@v7.1.0',
      to: 'actions/setup-node@v7',
      finding: /actions\/setup-node@v7 is not an exact version/
    },
    {
      name: 'a version missing from the lockfile',
      file: '.github/workflows/release.yml',
      from: 'actions/upload-artifact@v7.0.2',
      to: 'actions/upload-artifact@v7.0.1',
      finding: /upload-artifact@v7.0.1 is not in the lockfile/
    },
    {
      name: 'the extension unpinned',
      file: '.github/workflows/ci.yml',
      from: 'gh extension install github/gh-actions-lock --pin v0.2.0',
      to: 'gh extension install github/gh-actions-lock',
      finding: /without --pin/
    }
  ]

  it.each(mutations)('finds $name', ({ file, from, to, finding }) => {
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    expect(source.split(from).length - 1).toBe(1)
    const findings = workflowFindings(file, source.replace(from, to), lockSource())
    expect(findings.join('\n')).toMatch(finding)
  })

  it('finds a locked commit that is not 40 hex', () => {
    const lock = lockSource().replace(
      /sha1-3d3c42e5aac5ba805825da76410c181273ba90b1/,
      'sha1-3d3c42e'
    )
    const file = '.github/workflows/ci.yml'
    expect(workflowFindings(file, readFileSync(file, 'utf8'), lock).join('\n')).toMatch(
      /actions\/checkout@v7.0.1 has no locked 40-hex commit/
    )
  })
})

describe('readYaml and readStep refuse what they do not understand', () => {
  it.each([
    ['an anchor', 'a: &x 1\n'],
    ['a flow mapping', 'a: {b: 1}\n'],
    ['a tab', 'a:\n\tb: 1\n'],
    ['a second document', 'a: 1\n---\nb: 2\n'],
    ['a line that is not key: value', 'a: 1\njust text\n'],
    ['a duplicate key', 'a: 1\na: 2\n'],
    ['an escape in a double-quoted string', 'a: "x\\ny"\n']
  ])('throws on %s', (_name, source) => {
    expect(() => readYaml(source)).toThrow(/readYaml/)
  })

  it('throws on a step key it does not know', () => {
    expect(() => readStep({ uses: 'a/b@v1.0.0', 'working-directory': 'x' }, 'step')).toThrow(
      /unknown step key "working-directory"/
    )
  })

  it('throws on a step with both uses and run, or neither', () => {
    expect(() => readStep({ uses: 'a/b@v1.0.0', run: 'x' }, 'step')).toThrow(/exactly one/)
    expect(() => readStep({ name: 'x' }, 'step')).toThrow(/exactly one/)
  })

  it('reads the shapes the workflows use, exactly', () => {
    expect(
      readYaml(
        [
          'on:',
          '  push:',
          "    tags: ['v*']",
          'jobs:',
          '  a:',
          '    steps:',
          '      - uses: x/y@v1.2.3 # trailing',
          '        with:',
          '          persist-credentials: false',
          '      - run: |',
          '          one # kept: inside a block',
          '',
          '            two',
          '      - run: >-',
          "          --arm64 -c.x='${name}'",
          '    args: ""'
        ].join('\n')
      )
    ).toEqual({
      on: { push: { tags: ['v*'] } },
      jobs: {
        a: {
          steps: [
            { uses: 'x/y@v1.2.3', with: { 'persist-credentials': 'false' } },
            { run: 'one # kept: inside a block\n\n  two\n' },
            { run: "--arm64 -c.x='${name}'" }
          ],
          args: ''
        }
      }
    })
  })
})
