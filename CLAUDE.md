# Klados — working instructions

A desktop viewer and source-level editor for node-based data formats: XML and JSON first,
TOML and YAML later. Electron + TypeScript. MIT licensed.

The distinguishing feature is that when a node contains repeating similar children, their
contents are collected into a **table**. A file with two thousand `<car>` elements becomes
a grid with one row per car.

## Where things stand

**Status lives in `docs/TASKS.md`, and only there** — the board (what is built, what is open),
what is still owed, and the `R` id register. It used to live here as well, in a status table and
a doc map, plus each plan document's own header: four places to update when a round landed, so one
always got missed. M5 was listed as open for months after it shipped; R60 went stale one commit
after it landed. `test/docsStatus.test.ts` now enforces the single source.

**Plan documents live in `docs/plans/`.** One file per topic, named for its lowest `R` id; see
§ "Plan documents" below.

### Where the detail lives

This file used to carry the round-by-round narrative — 458 lines of it at its worst, read in full
at the start of every session and never once pruned. Four files now carry it, each with a
different job and a different lifecycle:

- **`docs/FINDINGS.md` — read before implementing anything.** The curated list of measured facts
  and traps that would otherwise cost a day to rediscover. Pruned, not appended: an entry leaves
  when it stops being true.
- **`docs/DECISIONS.md`** — why an approach was chosen and what was rejected. Read before changing
  one.
- **`docs/LOG.md`** — what was built when, newest first. Archaeology; nobody reads it end to end.
- **`docs/TASKS.md`** — the board (status of every range), what is still owed, and the `R` id
  register. **The single source of truth for status**, enforced by `test/docsStatus.test.ts`.

**Do not add narrative here.** When a round lands: set the plan document's `<!-- status: … -->`
marker, update `docs/TASKS.md`'s board, and put the story in `docs/LOG.md`. A line joins
`docs/FINDINGS.md` only if the round produced a trap that will bite someone working on something
unrelated — most rounds produce none.

## Document map

Read the relevant section before implementing — do not work from this file alone.
`docs/CONCEPT.md` is ~1750 lines; pull in the sections you need, not the whole file.

### Always

| File | Contains | Read when |
|---|---|---|
| `docs/FINDINGS.md` | measured facts and traps, curated | **before implementing anything** |
| `docs/CONCEPT.md` | the full design, 13 sections — **§13 lists every remaining open question with the milestone that closes it** | always, the relevant section |
| `docs/DECISIONS.md` | settled decisions and why, D-001… | before changing an approach |
| `docs/TASKS.md` | **the status board, what is owed, and the `R` id register** | **before writing any plan document**, and to find what is built |
| `docs/PLANNING.md` | how a plan earns its claims — render visual decisions, verify mechanisms, state the cost | **before writing any plan document** (its bookkeeping is `TASKS.md`'s job; this is its content) |
| `src/core/types.ts` | the format module contract | anything touching parsing |
| `docs/LOG.md` | what was built when, newest first | archaeology — "why is this like this?" |
| `docs/spikes/` | spike results — the whole artifact a spike leaves behind, its code being gone | before re-investigating something that may already have been measured |

### Topic documents

`docs/plans/` holds every plan and results document — 53 files, one per topic (plus the
historical `M*-PLAN` / `M*-RESULTS` pairs). **`docs/TASKS.md`'s board is the index**: it lists
every range, its status, and the document that owns it. Do not maintain a second index here.

Read the one that covers the area you are about to change. Its header states the range and the
status; its Results section states what actually landed, which is not always what the plan asked
for.

One reference document lives outside `docs/`, next to what it documents:

| File | Contains | Read when |
|---|---|---|
| `assets/README.md` | icon assets, the generation script, the title-bar spec | UI chrome or icon work |

## Invariants

These are not preferences. Breaking one means the architecture no longer works.

1. **Never convert the source to a JavaScript string.** Not for convenience, not
   temporarily, not for debugging. JS strings are UTF-16 and double a 200 MB file to
   400 MB. Work on `Uint8Array`; decode short slices on demand.
   *Bounded exception:* CodeMirror keeps its own UTF-16 copy of the **window** it is given
   — ~1 MB, never the whole document (D-031). Bounded by window size, not file size.
2. **No object per node.** All node data lives in the parallel typed arrays of
   `NodeStore`. Writing `{ kind, name, children }` means something has gone wrong.
3. **All spans are byte offsets**, `Int32Array` throughout.
4. **Parsers are iterative, never recursive descent.** Deeply nested input is real input
   and will overflow the stack.
5. **Parsers never throw on malformed input.** Emit a diagnostic and continue where the
   grammar allows. A partial tree beats an error screen.
6. **Editing happens only in the Raw view; Save writes the byte buffer.** Never regenerate
   the document from the model on save. This is what makes byte-identical saves possible,
   and it is the single decision the rest of the design hangs on.
7. **Save preserves the original encoding.** Never silently convert to UTF-8.
8. **Nothing above `src/formats/` knows which format produced a document.** Format-specific
   behaviour is expressed through `FormatCapabilities`, never by testing a format id.
9. **No literal colours in components.** Semantic theme tokens only; a stylelint rule
   enforces it. Elevation is a token *pair* (background + shadow) because shadow does not
   read on dark surfaces.
10. **Every command reachable from any surface must also be reachable from the palette.**
    Enforced by test, not discipline.

## Do not modify `src/core/types.ts`

If an implementation would be easier with a different contract, **stop and report**. That
is a design signal, not a blocker. The contract's closing section lists what is
deliberately excluded and why — read it before proposing changes.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | run in development |
| `npm test` | test suite, both projects (node + real-Chromium browser) |
| `npm run test:node` / `npm run test:watch` | node project only |
| `npm run test:browser` | browser project only |
| `npm run test:large` | include fixtures over 50 MB, and the full (not reduced) invariant fuzz sample counts |
| `npm run typecheck` | tsc, no emit |
| `npm run lint` | eslint + prettier |
| `npm run inspect -- <file>` | CLI harness: parse a file and report |
| `npm run fixtures:generate` | build large test fixtures (gitignored) |

## Task numbering — `R`, and only `R`

**Every new task in every plan document is `R<n>`, numbered in one continuous sequence across
the whole project.** Not per milestone, not per document. The next plan starts at whatever
number the last one ended on plus one.

The letter never changes. It stands for *request*, not for a milestone, which is the point:
a task can move between milestones — get deferred, get pulled forward, get split out into its
own round — without being renumbered, and a task id stays a stable handle in commits,
`DECISIONS.md` entries and results documents forever.

- **The register of what's been allocated is `docs/TASKS.md`.** Read the last id there before
  writing a plan; append the new range when the plan lands. Never reuse a number, even for a
  task that was dropped — a dropped `R41` stays dropped and visible.
- **Never renumber.** Moving `R57` from one milestone to another changes which document
  describes it, not what it is called.
- **A task belongs to exactly one plan document**, which stays its home even if the milestone
  around it is reorganized.

### Plan documents — one file per topic, named for its lowest `R` id

Milestones stopped carrying meaning some time ago: M5c through M5h are a letter sequence, not a
description, and `CLAUDE.md`'s own doc map already lists them out of order because the names sort
by neither time nor topic. The `R` scheme decoupled task ids from milestones; this decouples
documents from them too.

- **`docs/plans/R<n>-<slug>.md`**, where `<n>` is the **lowest** `R` id the file covers. `R19` above
  covers R19–R20.
- **A file may cover several `R` ids when they are one topic** — related work belongs together,
  and the relationships between tasks are often the most valuable thing in the document
  (`R19-document-props.md` exists largely to record that R20 does *not* make R19 revertable).
  The header states the full range; **the filename never changes when the range grows**, so a
  link or commit reference stays valid forever.
- **Plan and results live in the same file**, with results appended as a section when the work
  lands, rather than split into a second document. Splitting is what let `M5g-RESULTS.md`
  contradict its own plan silently — a correction belongs next to the claim it corrects. Split
  into `-PLAN`/`-RESULTS` only if a topic genuinely outgrows one file.
- **A topic file needs no milestone.** `docs/TASKS.md`'s milestone column may be `—`.

**Existing `M*-PLAN.md` / `M*-RESULTS.md` documents are not renamed or merged**, for exactly the
reason historical task ids aren't: every cross-reference in `docs/`, in commit messages and in
`DECISIONS.md` would be invalidated for no gain. The two conventions coexist; new work uses the
new one.

**Historical ids are not renamed.** Milestones M0–M5c used a per-milestone letter — B (M0),
D (M1), E (M2), F (M3), G (M4), H (M5), J (M5c) — and every plan, results document, commit
message and decision referring to them keeps that id. `M5c-PLAN.md`'s J1 is J1 permanently.
The `R` sequence starts after M5c and runs forward from there; the two schemes coexist rather
than one being migrated into the other, because renaming settled history would invalidate
every cross-reference in `docs/` for no gain.

## Spikes — the document is the artifact, the code is not

**A spike runs on its own branch, and the only thing that merges to `main` is a document in
`docs/spikes/`.** The apparatus is throwaway by definition; it does not come with it.

That document is the entire deliverable, so it is written to be read years later by someone
who cannot run the code. It should be **long**. It carries:

- **the question**, in the form that makes the answer a decision rather than a number
- **the environment** — machine, OS, runtime versions, and anything that makes a figure a
  lower or upper bound (a 60 Hz display puts a 16.7 ms floor under every latency in
  `docs/spikes/M0a-codemirror-and-parsers.md`, and not saying so would make every one of
  them a lie)
- **the method, and why that method** — that spike used Electron rather than a browser page
  *because a browser cannot report renderer RSS*, which is the sort of thing nobody
  reconstructs from the code
- **every number**, not just the ones the conclusion rests on
- **the mistakes made getting there.** This is the part that justifies the rule: the code
  contains the fix, only the document can contain the error. That spike's three
  harness bugs — a fractional byte offset that made CodeMirror throw off an async pass,
  a stale `scrollTop` after a document swap — are worth more than the harness was.

**Why not just keep the code.** R155 is the cautionary case rather than a hypothetical.
A completed M0a harness sat in the repository for the project's whole life, and its
`package-lock.json` pinned an Electron the app had long since moved past — producing **19 of
the repository's 25 Dependabot alerts**, permanently, burying the six real ones. That is
R47's finding in a new place: four real lint errors under 5,363 CRLF warnings is how a tool
gets switched off, and nobody was ever going to update a dead spike's lockfile.

**Re-runnable measurement tooling is not a spike.** Benches that later rounds re-run live in
`spike/` (see its `README.md`) and stay. The test is whether anyone will run it again.

**Historical documents keep their old paths.** A results document citing
`spike/codemirror-harness/` describes what was true when it was written, exactly as
pre-R144 documents keep saying "NodePad". Only *live* documents get repointed —
`docs/README.md`, `docs/TASKS.md`'s board, and `DECISIONS.md`, which is read before changing
an approach rather than as a record of one.

## Conventions

- TypeScript `strict` plus `noUncheckedIndexedAccess`
- Vitest for tests; parser work is invariant-tested, not example-tested — see M0-PLAN B12
- Dev-only assertions via `import.meta.env.DEV`
- No new dependencies without asking

## Working agreements

- **Build the current milestone only.** The concept describes features years out. An agent
  reading it will want to start on the tree view; M0 has no UI at all.
- **Review, fix, then commit — once per `R` id.** A task is not finished when the code works.
  After each `R` number — not after a round, and not after a whole milestone — **review the working
  tree as a separate pass, reading `git diff`** rather than working from the memory of having
  written it. Fix what the review finds. *Then* commit, once, with the fixes folded in.

  Reviewing before committing is deliberate: every commit then represents work that has been
  looked at, and the history carries no "fix the bug I just introduced two commits ago" noise. If
  a finding is out of scope or needs a decision, report it instead of quietly fixing it — the
  agreement below still applies, and a commit is not a reason to skip it.

  **This is not ceremony. It is where this project's defects have actually been found.** M2's
  `isNumericColumn` (1522 ms, absent from E10's own table) and `M4-RESULTS.md`'s six-issue
  addendum both came out of reviewing work already believed finished. R17's exhaustive fixture
  check found two TOML span bugs that hand-written examples *and* a 300-sample generated corpus
  had both missed. R18 exists because reviewing `M5g-RESULTS.md` found a shipped invariant
  violation. R19 was a 12.6 GB hang that had already been observed once and written up as
  "confirmed not an app bug."

  What the review looks for, in this codebase specifically: the ten invariants above; whether the
  plan's claims are true of the code that *landed* rather than of the code that was intended; a
  component measured cleanly while the pipeline around it was not (four instances so far);
  recursion over user input; an O(n) conversion called from a hot loop; and tests asserting shape
  but not exact values — R17's span bug was invisible to every tree-shape assertion, because
  parent, child and value all still resolved correctly and only the span boundary was wrong.

  **If the review finds nothing, say so** in the topic document's results section. A silent review
  is indistinguishable from one that never happened.
- **Every change reaches `main` through a pull request, squash-merged. `main` is never pushed to
  directly.** The branch is `r<n>-<slug>`, named for the **lowest** `R` id it carries — the same
  rule the plan document's filename follows, so a topic covering R151–R153 is one plan, one branch,
  one pull request:

  ```bash
  git switch -c r151-ci-matrix
  # ... work, review per R id, commit ...
  gh pr create --fill && gh pr merge --squash --delete-branch
  ```

  **The reason is that CI runs before `main`, not after it.** Of the first ten commits on the
  published history, five were fixes for problems the pipeline found *after* they had landed, and
  three of those only when a `v*` tag started a release build — each costing a deleted draft release
  and a moved tag. On a branch that costs nothing; on `main` every one of them is a commit saying
  the project broke itself.

  The review agreement above is unchanged and is not what the squash replaces: **review per `R` id,
  before the branch's own commits**, and name every id in the squash message. Its stated purpose —
  that each commit on `main` represents work someone looked at, with no "fix the bug I introduced
  two commits ago" noise — is exactly what a squashed, reviewed branch delivers.

  **No exception for documentation-only changes**, tempting as that is: `test/docsStatus.test.ts`
  fails when a plan document's marker disagrees with `docs/TASKS.md`'s board, so a docs commit can
  redden CI precisely like a code one.

  **And no GitHub issue per task.** `docs/TASKS.md` is the single source of truth for status; an
  issue tracker would be a second one, which is the four-places problem that rule already exists to
  fix. The `R` id is the ticket, the plan document is its description, and the pull request is where
  the discussion goes.
- **When a round lands, put its story in `docs/LOG.md`** and add a row to `CLAUDE.md`'s status
  table — not a paragraph. A line joins `docs/FINDINGS.md` only if the work produced a trap that
  will bite someone working on something unrelated; most rounds produce none. This is the rule
  R32 exists to establish: the section it replaced had grown to 458 lines because every round
  appended and nothing was ever removed.
- **And set the plan document's `<!-- status: … -->` marker**, on line 3, to one of `built`,
  `built-caveat`, `open`, `closed`, `superseded` — then update `docs/TASKS.md`'s board to match.
  `test/docsStatus.test.ts` fails if they disagree, if a plan document has no marker, or if a
  `built-caveat` has no entry in the Owed table. **A round that owes something records what**, in
  that table; that list is the reason the marker vocabulary has a separate value for it.
- **And flip the plan document's own prose header too.** The marker and the board are machine-
  checked; the prose header a human actually reads is not. `docs/LOG.md` and the board are not the
  plan document itself — a topic file that still opens `**Open.**` after its own Results section
  says it's built is a contradiction sitting in the one place someone reads first when they're
  about to touch that area. R50 (`docs/plans/R47-repo-hygiene.md`) found eleven of these at once,
  accumulated silently because this clause didn't exist yet. Where a round is only partly done
  (an unmet acceptance criterion, a deferred half), say so in the header rather than flattening
  to "built" — `docs/plans/R43-grid-sizing-and-scroll.md`'s and `docs/plans/R24-tabs.md`'s own headers are
  the pattern to match.
- **Ask about the version when a round lands.** The version in `package.json` is the user's
  call, not a rule this file encodes — but **ask**, every time, whether the round warrants at
  least a minor bump, rather than leaving it to be noticed later. It went unraised through 373
  commits at `0.0.1` precisely because nothing ever prompted the question.

  **This stopped being cosmetic at R141.** electron-builder takes the version from
  `package.json` and the release name from the tag, and the two are *not connected* — so the
  version now names every artifact (`klados-1.0.0-setup.exe`), and a tag that disagrees with it
  produces a release named for one version containing files named for another. R141's workflow
  asserts they match and fails the job when they do not.
- **Report rather than work around.** Stop if: a stated invariant cannot be satisfied, a
  measurement contradicts the plan, the contract needs changing, or something in
  `CONCEPT.md` turns out to be wrong in practice. The last one is expected — the design has
  been reviewed but never executed.

  **Never ship code you have already discovered is inert.** A faithful implementation of a wrong
  plan is not a faithful implementation. R115 wrote the `.cm-selectionBackground` rules the plan
  asked for *after* establishing that nothing renders that class, and shipped them with a note —
  so the round reported a caveat while the defect it was meant to fix stayed on screen, untouched,
  for another round. If the plan text has become dead on contact with the code, stop there and
  report; do not write it down first.

  **And do not report blocked until you have looked for another route to the same goal.** A plan
  names *a* mechanism; the task is the goal behind it. R117 is the case: the plan said CodeMirror
  drew the selection, that turned out to be false, and the round concluded the goal needed an
  editor change it declined to make — when `::selection` reached the same result with no behaviour
  change at all, one probe away. "The stated mechanism is absent" and "the goal is unreachable" are
  different findings; only report the second one after checking.
- **Record decisions.** When something in `DECISIONS.md` changes, update it in the same
  commit, including why.
