# R47–R50 — making the repo's own signals trustworthy

<!-- status: built-caveat -->

**Built.** Register: `docs/TASKS.md`.

Prompted by a pre-publication audit. None of this changes what the app does; all of it changes
whether the repo can be believed — by CI, by a contributor, and by the next agent reading a results
document that says "lint is clean."

**These four are separate `R` ids on purpose, and R47 in particular must be its own commit:**
renormalizing line endings rewrites every tracked text file, and anything committed alongside it
would be invisible in the diff.

---

## R47 — the lint signal is buried, and it is hiding real errors

```
✖ 5370 problems (4 errors, 5366 warnings)
```

**5,363 of the warnings are `Delete ␍`.** There is no `.gitattributes`, `core.autocrlf` is `true`,
and Prettier is configured for LF — so on this machine every tracked file is checked out with CRLF
and every line of every file is a Prettier violation.

**The consequence is not cosmetic.** `npm run lint` exits non-zero today, because of **4 real
errors** — `@typescript-eslint/explicit-function-return-type` on three arrow helpers and one
function in `test/xmlFormat.test.ts` (around lines 80–82). They have survived because the last
several results documents all say a version of *"lint clean — CRLF warnings only, the repo's
existing baseline."* That sentence is how a tool gets switched off without anyone deciding to
switch it off.

**Fix, in this order:**

1. Add `.gitattributes` — `* text=auto eol=lf` plus explicit `binary` entries for the assets under
   `assets/` (`.ico`, `.icns`, `.png`) so nothing tries to normalize them.
2. `git add --renormalize .` and commit **that alone**. Expect a diff touching essentially every
   text file; that is the point of it being its own commit.
3. Fix the four `explicit-function-return-type` errors.
4. Re-run `npm run lint` and record the real number in the results section. If it is not zero,
   **report what is left rather than declaring a new baseline** — a second "existing baseline" is
   how the first one happened.

**Do not solve this by relaxing the Prettier rule or by disabling the ESLint rule.** Both make the
symptom disappear while leaving the repo's files inconsistent for anyone on a non-Windows machine.

---

## R47 — Results

`npm run lint` went from **5,370 problems (4 errors, 5,366 warnings)** to **37 problems (0 errors, 37
warnings)** — all 37 real, pre-existing Prettier formatting nits unrelated to line endings, and none
blocking (`npm run lint` now exits 0).

**The fix needed one more step than the plan's own four**, found by doing it rather than by reading
it: **`git add --renormalize .` staged nothing.** The repository's blobs were already LF —
`core.autocrlf=true` on this machine converts on *checkout*, and `git show HEAD:<path>` confirmed
every sampled file's stored content was already LF before this round touched anything. Only the
*working tree* — the actual bytes on disk, which is what ESLint/Prettier read — was CRLF. Adding
`.gitattributes` changes what a *future* checkout produces; it does nothing to files already
materialized on disk, and `git checkout-index -f -a` (the usual "re-apply attributes" incantation)
turned out not to rewrite them either — `git status`/`git diff` both compare through the same clean
filter `.gitattributes` now specifies, so once the filtered comparison matches, git considers the
working tree file unchanged and several of its own re-checkout paths skip touching it. What actually
worked: delete every tracked file (`git ls-files -z | xargs -0 rm -f`) and `git checkout HEAD -- .`,
which has no filter-comparison shortcut to take because there is nothing left to compare against —
it always writes fresh from the index. Verified directly (a small script counting `0x0D` bytes across
all 438 tracked text files, not trusting `grep` — this shell's own `grep -c $'\r'` returned false
zeroes against files independently confirmed to contain hundreds of `\r` bytes each, so the tool
itself was not a reliable oracle here and every claim in this section was checked with `node -e`
byte-counting instead).

**No separate "renormalize" commit exists, and that is correct, not a shortcut.** §R47's own plan
expected step 2 to produce a large diff; because the blobs were already normalized, there was
nothing for git to stage — `.gitattributes` alone was sufficient once the working tree caught up to
what git already had stored. `git log` shows exactly the two commits this task's own opening section
requires: `.gitattributes` alone, and (after it) everything else.

Fixed the four real errors: `scripts/electron-screenshot.mjs`'s `main` (a plain `.mjs`, run directly
by Node — a TS return-type annotation there is a syntax error, so this is a scoped
`eslint-disable-next-line` with a stated reason, not a rule relaxation) and three arrow-function
helpers in `test/xmlFormat.test.ts`'s `genXml` (`name`/`ws`/`wrapWs`, all genuinely typeable as
`(): string`).

---

## R48 — `npm test` does not run the browser tests, and one of them only passes in company

Two defects that compound: the command everyone runs covers less than it appears to, and the
project it omits contains a test whose result depends on what ran before it.

### 48a. The documented test command covers one project of two

```jsonc
"test": "vitest run --project node",          // 1122 tests
"test:browser": "vitest run --project browser" // 94 tests
```

`CLAUDE.md`'s Commands table lists `npm test` as *the* test command. The browser project holds
essentially all the real-layout coverage of the last ten rounds — R33's contrast assertions, R34's
wide-grid guards, R38's icon/scroll assertions, R41's caret survival, R44's scrollbar geometry,
R46's coalescing. None of it runs.

**Fix: `npm test` runs both projects.** Keep `test:node` and `test:browser` for targeted runs. If
the combined runtime is objectionable, that is R50's problem (CI) and §48c's (the 82.7 s file), not
a reason to keep the default incomplete.

### 48b. `tabStrip.test.tsx` passes in the suite and fails alone

| how it is run | result |
|---|---|
| `npm run test:browser` (all 20 files) | **94/94 pass** |
| `npx vitest run --project browser test/tabStrip.test.tsx` | **fails** |

```
TabStrip overflow (R35–R37) > clicking the right chevron scrolls the strip
  without changing the active tab
TypeError: Cannot read properties of undefined (reading 'click')
  test/tabStrip.test.tsx:231  →  rightChevron!.click()
```

`const [, rightChevron] = container.querySelectorAll<HTMLButtonElement>(…)` finds fewer buttons than
it expects. The overflow controls only render when the strip actually overflows (R36 §3a), and
whether it overflows depends on the container's width — which this test does not pin, so it inherits
whatever ambient viewport state the preceding files left behind.

R38's results recorded this as pre-existing and "left as found," which was accurate. It has since
become worse than a visible failure: **the suite reports green, so nothing surfaces it.**

**Fix: pin the width the test depends on** — set an explicit container width that guarantees
overflow for the tab count it creates, rather than relying on the default viewport.

**And assert presence before use.** `rightChevron!` turned "expected 2 chevrons, found 1" into a
stack trace with a screenshot. A `expect(buttons).toHaveLength(…)` first line makes the next
failure of this kind self-explaining. Worth a sweep for other `!` assertions on query results in
`test/` while there.

### 48c. While in here: the node suite is one file

`invariants.test.ts` is **82.7 s of the node project's 85 s** — the truncation and byte fuzz passes
over `cars-10mb.xml`. It is valuable (R17's span bugs came from exactly this kind of exhaustive
check) and it should not be deleted, but it makes the default suite unusable in a tight loop.

**Fix: a smaller default corpus with the full one behind a flag**, the pattern `test:large` already
establishes. Report the resulting default runtime.

---

## R48 — Results

**48a.** `npm test` is now `vitest run` (no `--project` filter — the config's own `projects` array
already covers both, so omitting the filter runs everything). The old `npm test` behavior is
`npm run test:node`, added rather than repurposed so a targeted node-only run is still one command.
`test:watch`/`test:browser` unchanged.

**48b.** Confirmed the failure standalone (`npx vitest run --project browser test/tabStrip.test.tsx
-t "clicking the right chevron"`) before touching anything — and the plan's own diagnosis needed a
correction, found by measuring rather than assuming: `container.style.width = '400px'` was **already
pinned**, in this describe block's own `beforeEach`. A debug read showed the real state:
`scrollWidth` (1360) genuinely exceeded `clientWidth` (368) — the strip *was* overflowing — but zero
`.tab-strip-scroll-btn` elements existed yet. This is `TabStrip.tsx`'s own `ResizeObserver`-backed
overflow effect not having flushed by the time the assertion ran, not an unpinned viewport: a fixed
two-`requestAnimationFrame` wait (this file's `paint()`) is enough once the browser instance is
already warm (later in a batch) but not reliably on a cold first mount — confirmed by adding an
arbitrary 200 ms wait, which made it pass. Fixed properly with `waitForOverflowButtons`, a bounded
poll for the actual condition rather than a frame count — the same "wait for what you're actually
waiting for" shape `R35`'s own test in this file already uses via a real `scrollend` event, not a
new pattern. Applied to every test in the describe block that assumes overflow buttons exist right
after `openManyTabs`. Verified reliable: three consecutive standalone runs of the whole file, all
green (previously failed roughly every standalone run).

**Also fixed, per the plan's own instruction:** every `!`-asserted `querySelectorAll` destructure in
this file now has an `expect(...).toHaveLength(...)` immediately before it. Swept the rest of
`test/` for the same destructuring-then-`!` shape (`const [...] = ...querySelectorAll(...)`) —
this file was the only one using it, so the sweep found nothing further to fix.

**48c.** `invariants.test.ts`'s test 5 ("truncation fuzz") is the one expensive invariant here — a
*full* `format.parse` per sampled offset, unlike test 4 (`parseRange`, bounded by the sampled
subtree) or test 6 (100 byte corruptions but one parse). `TRUNCATION_FUZZ_SAMPLES` now reads the same
`RUN_LARGE`/`NODEPAD_TEST_LARGE` flag the fixture-size filter already uses: 20 samples by default, the
full 200 under `test:large`. The fixture itself (`cars-10mb.xml`) stays in the default corpus —
every other invariant against it is cheap and worth keeping — only this one test's sample count
shrinks.

**Runtimes, measured:**

| | before | after |
|---|---|---|
| `npm run test:node` (node project alone) | ~85–99 s | **~26–28 s** |
| `npm test` (node + browser, not run together before R48a) | n/a (browser omitted) | **~33–35 s**, 1216 tests |

**A pre-existing `test:large` cost, found while verifying 48c, not caused by it.** Confirming
`TRUNCATION_FUZZ_SAMPLES`'s `RUN_LARGE` branch actually reaches 200 (not just that the ternary
reads correctly) meant running `NODEPAD_TEST_LARGE=1` for real. A targeted run — one fixture
(`deep-1m.json`), test 5 only — did exactly that: 200 samples in 3.1 s, confirming the branch. A
full, unfiltered `NODEPAD_TEST_LARGE=1 vitest run --project node test/invariants.test.ts -t
"truncation fuzz"` across every fixture (`cars-500mb.xml` included) was also started, to see the
real `test:large` shape end to end. It took **1257 s (~21 min)** and ended with **8 of the
truncation-fuzz tests failing** — not assertion failures, `[vitest-worker]: Timeout calling
"onTaskUpdate"`, a worker RPC timeout, on the largest fixtures at the full 200-sample count.

**Not a regression from R48c or anything else in this round.** `test:large`'s fixture set and the
worker-pool infrastructure it runs against both predate this round; R48c only made the *default*
run skip most of this same cost by reading the pre-existing `RUN_LARGE`/`NODEPAD_TEST_LARGE` flag
the fixture-size filter already used — it does not change what happens once that flag is set. This
appears to be a previously-unmeasured characteristic of `test:large` on the largest fixtures
(`cars-200mb.xml`, `cars-500mb.xml`) rather than something this round introduced: a ~21-minute,
all-fixtures-at-full-sample-count run is not a shape any earlier round's own results document
records having actually executed end to end. **Not investigated further or fixed here** — out of
R47–R50's own scope, which is about the *default* signal, not the exhaustive one — but flagged
rather than left for the next person running `test:large` on the full corpus to rediscover cold.
Worth a look whenever R51+ or a CI-adjacent round next touches `test:large` or the worker pool:
raising Vitest's RPC timeout for this project, or chunking the largest-fixture runs, are the two
obvious candidates, neither evaluated here.

---

## R49 — there is no CI and no hooks

`.github/workflows` does not exist; `.husky` does not exist. Nothing prevents a push that fails
typecheck, lint, or either test project — which has been survivable with one contributor and will
not be once the repo is public.

**Fix: one workflow, running on push and pull request:** `npm ci`, `npm run typecheck`,
`npm run lint`, `npm test` (both projects after R48). The browser project needs Playwright's
Chromium — `npx playwright install --with-deps chromium`.

**R47 is a prerequisite, not a nice-to-have.** Adding CI while `npm run lint` exits non-zero means
either a red badge from day one or a workflow that ignores lint, and the second is worse than no CI.

Deliberately **not** in scope: release/packaging automation, and any signing or notarization. Those
belong to the publication round, which has its own decisions to make.

**Git hooks are a separate question and the recommendation is to skip them for now.** A pre-commit
hook that runs the full suite is slow enough to get bypassed with `--no-verify`, and one that runs
only lint duplicates CI. Revisit if CI turns out to catch the same class of thing repeatedly.

---

## R49 — Results

`.github/workflows/ci.yml`: `actions/checkout` → `actions/setup-node` (Node 22, `cache: npm`) →
`npm ci` → `npm run typecheck` → `npm run lint` → `npx playwright install --with-deps chromium` →
`npm test` (both projects, per R48a). Triggers on push to `main` and on every pull request. No git
hooks added, per the plan's own recommendation to skip them for now.

**Fixture generation is deliberately not a CI step.** `spike/fixtures/` (~1 GB, `spike/.gitignore`'s
own `fixtures/` entry) is generated locally by `npm run fixtures:generate` and never committed — a
fresh CI checkout has none of it. `invariants.test.ts` already degrades gracefully for exactly this
case (`if (FIXTURES.length === 0) it.skip(...)`, present before this round), so CI runs the rest of
the suite and reports that one file's tests skipped rather than failing or spending CI minutes
regenerating a gigabyte of fixtures on every run. The exhaustive fixture-backed invariants stay a
local/`test:large` check, same division of labor R48c's own runtime split already draws.

**Amended after the fact:** the workflow as built here **never built the app** — `typecheck` is
`tsc --noEmit` and never invokes Vite, so a bundling failure passed CI. An `npx electron-vite build`
step was added later; the demonstration (a nonexistent icon path that typechecks clean, because
`vite/client`'s ambient `*.svg?raw` declaration types any such path) and the reasoning are in
`docs/plans/R54-signal-followups.md`'s own addendum.

**Not verified against a real GitHub Actions run** — this repository has no configured remote in
this environment, so there is no live push/PR to observe the workflow execute. Every command the
workflow runs (`npm ci` is the one exception — assumed, not re-run, since it would reinstall
`node_modules` unnecessarily) was run directly in this environment and passed: `npm run typecheck`,
`npm run lint`, `npm test`. Flagged rather than silently assumed equivalent to a real CI pass.

---

## R50 — the docs contradict themselves in two places

`DECISIONS.md` and `LOG.md` are in good order: 73 decision entries against 73 index rows with none
missing or orphaned, and LOG.md current through R46 including an honest note that R46's acceptance
criterion was not met. R32's lifecycle split is holding. Two leaks, both structural rather than
careless.

### 50a. Eleven plan documents still say "Open" for work that shipped

`docs/plans/R21-notifications.md`, `R24-tabs.md`, `R31-csv-spike.md`, `R33-scrollbars-and-selection.md`,
`R34-wide-grids.md`, `R35-tab-overflow.md`, `R38-tab-strip-polish.md`, `R39-grid-followups.md`,
`R41-raw-editing.md`, `R42-stale-spans.md` and `R43-grid-sizing-and-scroll.md` all open with
`**Open.**` — and all have Results sections, and all are "built" in `CLAUDE.md`'s status table.

**This is a process gap, not eleven separate oversights.** The working agreement says that when a
round lands its story goes to `docs/LOG.md` and the status table gains a row. It has never said
*flip the plan document's own header*, so nobody has.

**Fix:** update the eleven headers to state the real status, **and add the missing clause to the
working agreement** in `CLAUDE.md` — otherwise the next eleven accumulate the same way. Where a
document is partly done (R43–R46's unmet acceptance criterion, R24's per-tab view state), the header
should say so rather than flatten to "built."

### 50b. `docs/plans/UI-FEEDBACK.md` is advertised as active and has not been touched in ten days of work

986 lines, last commit 2026-08-07, still listed in the doc map's **Active work** tier as "read
before changing a view's behaviour." Every round since R33 has used a per-topic `R` document
instead. It is a fourth lifecycle that ended without its advertisement being retired — the same
shape R32 exists to prevent, in a different file.

**Fix: move its doc-map row to Historical** and say what it was (rounds of observations from using
the app, M2b through M5b). Fold anything still live into `docs/FINDINGS.md` first.

**Do not delete it.** It is referenced from **29 files** across `docs/` and `CLAUDE.md` — including
four `DECISIONS.md` entries (D-034, D-034a, D-049, D-050), `CONCEPT.md` §12 and `M3-PLAN.md`, and
`docs/LOG.md`. Deleting it invalidates every one of those for no gain, which is the same argument
`CLAUDE.md` already makes for not renaming historical task ids. Retiring means moving its doc-map
row, not removing the file.

---

## R50 — Results

**50a.** All eleven headers flipped from `**Open.**` to state their real status — most to
`**Built.**`, with the two genuinely-partial ones saying so explicitly rather than flattening:
`R24-tabs.md` ("R29's own per-tab view state not restored") and `R43-grid-sizing-and-scroll.md`
("R46's own p90 frame-time acceptance criterion unmet"), and `R33-scrollbars-and-selection.md`
("the thumb corner-radius artifact at `top: 0` found, not fixed"). Added the missing clause to
`CLAUDE.md`'s working agreements — "flip the plan document's own header" — right after the existing
"put its story in `docs/LOG.md`" bullet, so the next round to land does this as part of the same
step rather than needing its own audit later.

**50b.** `docs/plans/UI-FEEDBACK.md`'s doc-map row moved from the Active-work tier to Historical, described
as what it was (M2b–M5b, superseded by the per-topic `R` document convention). Not deleted — still
referenced from 29 files. Checked for anything still live before retiring the row, per the plan's
own instruction: three entries in the file are not marked `done` (all `M2b`, none plain `open`) —
wired-up icons, toolbar button icons, and the `paneHeader` command surface. All three read as
already superseded by since-built features (`components/Icon/Icon.tsx` exists and is in wide use;
`registry.ts`'s `Surface` type already includes `'paneHeader'`), not as live unaddressed feedback —
so nothing needed folding into `docs/FINDINGS.md`. The file's own internal `M2b`/`open` status
markers on those three entries are themselves now stale in the same way the eleven plan-document
headers were, but auditing and correcting them is a larger task than this round's own scope (moving
the doc-map's advertisement, not rewriting the file); flagged here rather than silently left for
the next reader to rediscover.

This document's own header is flipped below, now that R47–R50 are all built.
