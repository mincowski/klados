# Klados — build log

What was built, when, and what it turned out to cost. **Newest first.** Append-only: entries are
never rewritten, only corrected in place with the correction visible.

**Nobody reads this file end to end.** It is archaeology — the answer to "why is this like this?"
and "did someone already try that?". For the small set of things worth knowing *before* touching
anything, read `docs/FINDINGS.md` instead; for what's built right now, `docs/TASKS.md`'s board.

**Entry titles are historical too.** An entry describing a round that was open when it was written
keeps saying so; where a later round closed it, the correction is added in place and visible rather
than the original being edited away.

Moved out of `CLAUDE.md` by R32, which found that section had grown to 419 of that file's 615
lines — read in full at the start of every session, and never once pruned.

---

## R156 — a Find result marked stale after it had been recomputed · built

One word — `searchStore.ts` testing `document.dirty` where its own comment says *the buffer has
moved*. `dirty` means **unsaved**: true from the first keystroke until the next save, so it long
outlives the reparse it was standing in for, and every later notification re-marked a result that
had already been recomputed. Measured at R154: stale at +1 ms, correctly cleared at +48 ms when the
re-run landed, wrongly re-marked at +205 ms, permanent from there.

`reparsePending` is the same sentence as a field — true from the moment `sourceBuffer` is replaced
until `applyReparseResult` commits a store built from it — and it exists because M5's H8 banner and
H9 memory budget hit this trap first. `searchStore` was the third such consumer and the only one to
reach for the wrong flag. Confirmed rather than assumed: all four buffer-mutating paths set it.
`transformInProgress` is deliberately excluded — it covers the window before a Transform swaps the
buffer, where the result still does match, so marking stale there would be this same defect briefer.

**The test asserts the mechanism, not a duration, and that is the lesson.** R154 caught this by
watching the flag for 205 ms, but a test that waits for a particular moment repeats the mistake that
hid it — every test in the file waited 50 or 90 ms and asserted inside the window where the flag was
briefly correct. Instead: after the edit and its re-run, issue a notification that provably cannot
have moved a byte (`setCaretOffset`) and assert snapshot *identity*. Deterministic, instant, and
verified to fail first on the real defect.

The round also had to correct itself. Its own plan said the Find count would display as stale while
being correct; it would not, because **nothing in `src/` reads `SearchResult.stale`** — R126 removed
the `(stale)` suffix from the Find bar and left no other reader. Found by grepping for consumers
before writing the results rather than after, which is the only reason it is a correction and not a
shipped false claim. The defect is real but smaller than advertised: a public field holding the
wrong answer under a correct name, and one spurious re-render per edit cycle.

With it fixed, R151–R154 owes nothing and stops being `built-caveat`.

## R155 — spikes leave a document, not a directory · built

Enabling Dependabot produced 25 open alerts, and **19 of them came from one completed M0a spike** —
a throwaway harness pinning `electron ^38.2.0` while the application's own lockfile already
resolved 39.8.10, higher than any advisory asked for. Nothing affected the shipped binaries; the
six real alerts are all build tooling, and the eight runtime dependencies are untouched.

R47's finding in a new place, and worse. Four real lint errors under 5,363 CRLF warnings is how a
tool gets switched off — but R47 had a fix waiting in `.gitattributes`, and nobody is ever going to
update a dead spike's lockfile, so this noise was permanent by construction.

The rule: a spike runs on its own branch and only its document merges, into `docs/spikes/`. That
document is written for someone who cannot run the code, and carries the question, the environment,
the method *and why that method*, every number, and the mistakes made getting there. The last is
what makes deleting the code defensible rather than merely tidy — **the code contains the fix, only
the document can contain the error.** M0a's three harness bugs, one of them a fractional byte
offset that made CodeMirror throw off an internal async pass so the failure surfaced nowhere near
its cause, are worth more than the harness was.

Sufficiency was checked before anything was deleted, document against apparatus rather than judged
by length: M0a's 905 lines carry the environment, the vsync floor that makes 16.7 ms a floor and
not a latency, the editor configuration, A6's windowing primitives by name, and those three bugs
root-caused; H11 names every scheme privilege flag and its run command; R31 names the seeded PRNG
and seed behind its 1,757-edit result; D15's family is tabulated in full in `M1-RESULTS.md`, which
is titled for it.

One real gap was closed rather than argued away. The raw JSON held `min`/`max`, `readMs`,
`docChars`, `lines` and RSS counters that no table carried — "no decision rested on them" being a
claim about questions already asked — so all 24 files are transcribed verbatim into
`docs/spikes/raw-measurements.md`: 2,691 scalar values in, 2,691 rows out, checked by count and by
spot value.

Kept: `generate-fixtures.ts` and five per-milestone benches, which are re-runnable tooling rather
than spikes, now with a `spike/README.md` saying what each measures. The directory keeps its name
because renaming would invalidate every historical path for no gain. `spike/.gitignore` now
excludes `package*.json` at both levels so a stray `npm install` cannot recreate the problem.

References follow R144's precedent, and measuring made the split cheap: of 28 mentions of deleted
paths, only five sit in live documents. The other 23 keep pointing at paths that no longer exist,
because they describe what was true when they were written.

The review pass found one thing. The sweep would have deleted `d15-*.json`, which belongs to **M1**
and D-030 rather than M0a — covered by `M1-RESULTS.md`, but checked rather than assumed, and
grouped under its own heading in the transcription instead of being filed with the M0a data it
happened to sit beside on disk.

## R151–R154 — CI on every platform it ships to · built ⚠ (one item owed)

The first round to land through a pull request, and the round that makes gating on one worth
anything.

The case came out of measuring rather than arguing. `ci.yml` ran `ubuntu-latest` alone;
`release.yml` ran four jobs but only on a `v*` tag. Comparing every run of both across the published
history: **they disagreed on all four commits where both ran, in both directions.** Green CI carried
no information about whether a release would build, and red CI carried none about whether the code
was broken. Both release failures had one cause — a test failing on a platform CI never ran — and
each cost a deleted draft release and a moved tag to discover.

R151 is the matrix: `ubuntu-latest`/`windows-latest`/`macos-latest`, `fail-fast: false`, with
exactly two Linux-only steps (the xvfb install and the `xvfb-run` wrapper) keyed on `runner.os`.
Everything else runs unconditionally on all three, deliberately — an asymmetric matrix leaves steps
that only ever execute on one OS, which is the shape of the problem being closed. macOS is one job:
`macos-latest` is arm64, and Release's Intel job exists to produce a second *binary*, not to
exercise different code. A `concurrency` group was added, which only starts mattering once branches
exist. `actions/checkout` and `actions/setup-node` went from `@v4` (deprecated Node 20, warning on
every run) to `@v7` in both workflows, after reading the actual v5/v6/v7 breaking changes rather
than assuming them — all of them are about fork-checkout policy or *automatic* cache detection,
neither of which this project uses.

Risk was low and measured rather than hoped: Release's Test step is unconditional, so the full suite
had already run green on Windows, on macOS twice and on Ubuntu at `1133cb4`. The round moves a check
that already passes.

R152 and R153 are the two test defects that made CI red at HEAD, and they were the reason the round
was three tasks instead of one. **A gate that fails half the time for reasons unrelated to your
change teaches you to merge past it**, and a check you merge past is not a gate.

R152 is not a flake. `tabStrip.test.tsx` defines `waitForOverflowButtons()`, and every
`.tab-strip-scroll-btn` query in the file waited on it except one — the one that failed, twice in
the last four runs, with `expected +0 to be 3`: zero buttons, meaning the layout pass and
`ResizeObserver` callback had not happened yet. Its `describe` block was added after the helper and
never picked it up. The same lesson as R140's `flushReparse` correction, two rounds running. One
assumption in the plan needed checking and held: the helper waits for *any* button while the
assertion wants *three*, which is only sound because all three are gated on the same
`overflow.overflowing` boolean in one render, so they mount atomically.

R153 raised a performance ratio from 2× to 3× after CI measured 2.024 — over by 1.2%. That is the
move that hides real regressions, so it is justified by what a regression looks like rather than by
the run being close: per-node namespace work on a 150,000-node document costs a multiple, not 2%.
Vitest's `retry` was rejected for both; it would have greened them in one line and hidden R152's
missing wait entirely.

R154 was allocated after the fact, because the matrix's first run failed on two of its three
platforms and both causes had been latent since before the project had CI. The plan's claim that the
suite had already passed on three platforms was true of the suite and **false of
`mainElectron.test.ts`**, which guards itself on `out/main/index.js` and skips when the built app is
absent — and `release.yml` tests *before* it packages, so that describe block had never executed off
Linux in its life. On Windows, `searchStore.test.ts` failed on a fixed sleep: the third instance of
that defect in three rounds.

A fourth instance then turned up locally, in the file the release round had already fixed.
`documentSession.test.ts` failed under full-suite load (ten isolated runs pass — the fixed-sleep
signature) and turned out to contain **five more** of these helpers, one per describe block, because
the pattern is copy-paste per `describe` rather than one shared utility. R140 fixed one wait out of
six in a file it had opened for exactly this reason. All five now delegate to the single quiescence
helper, across 44 call sites — and the conversion reproduced R140's own mistake, a global rewrite
catching call sites belonging to helpers that still took no arguments, which `tsc` reported rather
than leaving wrong-arity calls in tests nobody reruns.

macOS then failed **twice, in two hooks, for unrelated reasons** — and the second one is the better
story. Cold-starting Electron exceeded 30 s, fixed with a 120 s timeout on that hook alone. The next
run failed at 30 s again, in `afterAll`, where the existing comment had named the cause years before
anyone noticed it applied: *"which quits the process on its own (non-macOS)"*. `main/index.ts` calls
`app.quit()` on `window-all-closed` only when the platform is not darwin, because a Mac application
is meant to stay running when its last window closes — so Playwright's `close()`, which waits for
the process to exit, waits for something deliberately designed never to happen. Correct product
behaviour, a gap in the harness; the teardown now bounds the close and kills the process. The first
macOS fix was right and still left the platform red, which is the round's own argument turned on
itself.

The Windows fix took three attempts, and the wrong ones are the useful part. Quiescence — R140's
approach — fails here, because after an edit the store goes stale synchronously and then nothing
moves until the debounce elapses, so "stopped changing" is reached before the work starts: **stable
and not-yet-started are indistinguishable from outside.** Waiting for `stale` to clear and then
settle fails too, and instrumenting *that* is what surfaced a product defect: measured through the
real store and session, the flag clears at +48 ms when the reparse lands and is re-marked at
+205 ms by a notification with the store unchanged and `dirty` still true — permanently, because
nothing else will change the store. `searchStore.ts` uses `dirty` (*unsaved*) as a proxy for *the
buffer moved since the search ran*, and after a reparse those disagree. Reported and carried in the
Owed table rather than fixed: it is pre-existing, and picking the right signal is a product decision
a CI round should not be making. The correct wait turned out to need both flags — `stale` clears
when the re-run starts, `complete` only when it finishes.

## R140–R142 — publication: a fresh history, tagged releases, a README for users · built ⚠ (one item owed)

The application went public as `mincowski/klados` at `v1.0.0`, with binaries for Windows, both
Macs and Linux.

R140 reset the published history. The mechanism was an **orphan commit**, not `filter-repo` and not
`rm -rf .git`: same published result, reversible until `gc`, and incapable of losing local config.
`filter-repo` was rejected for a reason that is about content rather than mechanics — rewriting the
author field leaves the commit messages, which were a dated development diary written for an
audience of one. Publishing a fresh history is a different decision from rewriting an old one, and
this was the first. The 377 pre-reset commits were bundled to `klados-prehistory.bundle` and
verified restorable (22 of 22 doc-referenced hashes resolvable) *before* anything destructive ran;
that bundle is now the only copy.

The finding worth keeping: **grep the working tree, not just the log.** A contact address survived
every commit-graph rewrite because it was file *content* — an `authors = [...]` line inside a
Cargo-shaped TOML fixture. Addresses live in fixtures, changelogs, mailmaps and `package.json`
author fields, and none of them care what happens to the commit graph.

R141 is the tagged-release workflow. `electron-builder.yml` was already complete, so only the
workflow was new — but four non-obvious failure modes each quietly produce a bad first release, and
three of them were hit for real. The tag and `package.json` version are **not connected** —
electron-builder names artifacts from one and GitHub names the release from the other — so the job
asserts they match. `macos-latest` is arm64, so Intel Macs get nothing without an explicit second
job; the two are named `-mac` and `-mac-intel` rather than by architecture, because that is what
makes the download obvious to someone who does not know what is inside their Mac. Splitting them
also required `-c.dmg.artifactName` per job, since an `artifactName` pattern has no conditional —
and the round *before* that split shipped both architectures under one filename, a collision found
only because the asset list looked wrong. `snap` was dropped (a `.snap` outside the Store needs
`--dangerous`), as were the zips and blockmaps, taking the asset list from nine to five.
Everything is unsigned, which is a README instruction rather than a footnote.

Four release attempts were needed, and none of the failures was in product code: an `npm ci`
lockfile that had been out of sync invisibly because `npm ci` had never run; three test timeouts on
Windows and macOS, the first platforms other than Ubuntu to run the suite; the dmg name collision;
and a fixed 40 ms sleep in `documentSession.test.ts` that lost its race on a Windows runner and was
replaced with a quiescence wait. That last pair is what R151 exists to catch on a branch instead.

R142 rewrote the README for people who will never read `docs/`. Six defects were found against the
tree, two of them false claims: it still said *"Pre-alpha — not yet usable"*, `[M0-PLAN.md]` was a
broken link, and *"Third-party notices are generated at build time"* was false — no script anywhere
generated it. The AI-authorship note has **no standard clause** to adopt: no SPDX identifier, no OSI
text, no established `AI-DISCLOSURE.md` convention. The wording written for it names what the human
did rather than claiming "human oversight", and does not apologize.

`CONCEPT.md` §13's first open question is closed. GitHub, npm and the trademark registers were all
checked before the push — DPMA and EUIPO by hand in classes 9 and 42, since every register refuses
programmatic queries — and no conflicting mark was found. Checking cost minutes; a collision found
after a tagged release would have cost the repository URL, the release URLs, `appId`,
`productName`, every screenshot and every external link.

## R145–R150 — CSV · built ⚠ (two items owed)

CSV lands as an input format: `Document` → one unnamed `Array` → an unnamed `Object` per row →
fields as scalar facets, never child nodes — exactly `CONCEPT.md` §2's "scalar facets" and exactly
the shape the grid was built for, per R31's own closing recommendation. R145 dialect sniffing picks
the delimiter by per-row field-count consistency, not frequency, so a semicolon file full of decimal
commas sniffs correctly. R146 is the parser: RFC 4180 quoting, doubled-quote escapes, embedded
delimiters/newlines, byte-exact spans, never throws.

R147 opened with the plan's own required probe before writing anything: whether an empty attribute
name span (the recommended way to name a headerless column) survives contact with the real
`Interner`/`gridDetection`/grid renderer. It does not — a real `NodeStore`/`Interner`/`collectColumns`
round trip collapsed three distinct headerless columns into one, since every empty span interns to
the same id regardless of offset. Reported rather than routed around, per `CLAUDE.md`'s rule about
`core/types.ts`-adjacent contract limits. Row 1 is always treated as the header instead (the plan's
own option (a)), gated by a has-header heuristic that discloses via a diagnostic when that assumption
is doing real work (row 1 is indistinguishable from the data below it).

R148 wires CSV into the registry with extension-only detection (`.csv`/`.tsv`/`.tab` — no content
sniffing, ever, since every text file has commas and newlines) and a regression test pinning that
every existing fixture still resolves to its own format. R149 verified rather than assumed that
D-015/D-065 (wrapper descent, initial selection) already cover CSV's shape unchanged — they do — but
running the real parser through `detectGrid` found a genuine gap: every CSV row failed the existing
"has children" grid-eligibility test, since fields are facets by design, so no CSV file could ever
have produced a grid. Fixed narrowly as **D-088** (`isGridEligible`, `nodeDisplay.ts`), without
touching `hasChildren`/"composite" or any other caller of it.

R150 replaced §8's estimated memory table with real numbers (2,000,000 rows: 3.36×/3.04×/2.85× store-
to-file at 10/20/50 columns, confirming the predicted 50-column "fails" case at 1.6 GB) and re-ran
R31's exhaustive edit-and-compare exercise against the real parser instead of R31's stand-in — 1,756
edits, 0 mismatches, extended to compare facets, which the stand-in never modeled. Two items owed:
a row with two or more unheadered extra fields collapses them into one shared column (the
single-extra-field case, already a Warning, is unaffected), and a `columns × rows`-derived pre-open
memory projection was not built — the existing generic file-size-based `confirmSize` gate already
covers CSV today, measured close to the real multiplier.

## R144 — NodePad becomes Klados · built ⚠ (R140–R142, the rest of the publication document, are not started — **since corrected: they landed, see the R140–R142 entry above**)

`CONCEPT.md` §13's name-availability question finally got checked and NodePad failed it three ways
(D-086): Google corrects the search to *Notepad*, `mskayyali/nodepad` is an active 1.1k-star
project with a commercial product on the same word, and the npm name has been taken since 2011.
Every `node`-formative alternative landed on someone else's established meaning, and the
maintainer's own objection was decisive — *node* appears nowhere in the UI. The replacement is
**Klados** (Greek κλάδος, *branch*), and the mark stops being a letterform: the retired design was
an N with node dots on its vertices, the new mark (`3b-ii`, D-087) is a stem, an arm, and a leg
branching off the arm rather than the stem, giving two branch points instead of one — it reads as a
mark before it reads as a K.

Mechanical scope: 77 command ids and 8 `localStorage` keys (`nodepad.*` → `klados.*`), the
`NodePadApi` interface and its helpers, the `nodepad-file://` read-token scheme, ARIA ids,
`package.json`/`electron-builder.yml`/`tools/generate.py`, `LICENSE`, and every product-facing
doc (`README.md`, `CLAUDE.md`, `CONCEPT.md`, `FINDINGS.md`, `TASKS.md`, `assets/README.md`) —
`docs/LOG.md`, `docs/DECISIONS.md`'s pre-D-086 entries, and plan-document Results sections keep the
old name deliberately (§7c of `docs/plans/R140-publication.md`). Review caught the substitution's
own blind spot before commit: `docs/TASKS.md`'s R144 register row and `CONCEPT.md` §13 **narrate**
the rename ("NodePad fails on three counts", the real third-party repo `mskayyali/nodepad`), and a
blanket pass had turned that narration into "Klados becomes Klados" and a fabricated GitHub handle
— hand-corrected. A second gap only the running app revealed: `TitleBar/Mark.tsx` duplicates the
mark's path data inline in JSX rather than importing `assets/mark-16.svg`, so editing the SVG files
never touched what the title bar actually draws — the dev server still showed the retired N with
node dots until `Mark.tsx` itself was fixed to match. `npm test` passes with the renamed ids,
invariant 10's palette-reachability test included and unmodified. R140–R142 (history reset, tagged
releases, the README rewrite) are untracked follow-on work from the same document, not part of this
round.

## R143 §2 — the splice graft refuses a multi-root reparse · built ⚠ (§3–§10 of the same document are still open investigation, not started)

`decideSplice` (`src/renderer/session/subtreeSplice.ts`) accepted any `parseRange` result whose
`bytesConsumed` matched, without checking it produced exactly one root — a fresh parse with a
*second* top-level node silently orphaned it: a real span, `parent === NO_REF`, invisible to every
tree walk, grid build and query, no diagnostic. XML/JSON/TOML essentially never reach this shape
(a TOML attempt was refused as `malformed` some other way first); a YAML outdent reaches it
routinely, since closing a node early and opening a sibling in the same reparsed range is exactly
what changing a line's indentation does. Fixed with one O(fresh-node-count) check before the graft:
no fresh ref but 0 may have `parent === NO_REF`, refusing with the existing `malformed` →
full-reparse fallback on failure. Covers both the synchronous and H2d chunked splice paths, which
share `decideSplice`. Demonstrated through the real `spliceSubtree` with a `FormatModule` built from
real XML with only `parseRange` overridden to misbehave — both new tests checked to fail with the
guard disabled before being checked to pass with it restored. The rest of `R143-yaml.md` (§3–§10 —
the actual YAML parser, the anchors/aliases contract question, detection, formatting) is unstarted
investigation with open questions for the next turn, not implementation; only §2 was ready to build
on its own.

## R134–R136 — XML namespace resolution, per name not per node · built ⚠ (R137 not started; see the Owed table)

`Interner` gains a capability-gated (`hasNamespaces`, never a format id) prefix/local split at
intern time; `NodeStore` accumulates `xmlns`/`xmlns:*` scope live during a real parse and resolves
each element's own name to a small per-document `resolvedId`, cached in an array indexed by raw
`nameId` — O(1) except when a document genuinely rebinds a prefix (R135), where a linear scan over
the (small, per-declaration) list of real `xmlns` attributes stands in for the sorted-table binary
search the plan originally sketched, since at the sizes involved they cost the same. `gridDetection.ts`
groups children by `resolvedNameIdOf` instead of the raw `nameIdOf` (R136), closing the gap that
file's own comment had documented since M2; `gridColumns.ts`'s `collectGroupMembers` needed the
same fix, found while implementing rather than named in the plan. Review caught a real defect before
commit: the derived namespace state never survived `NodeStore.exportBuffers`/`fromBuffers`, so the
store the real app actually queries after a worker parse was silently falling back to raw name
matching for every document — invisible to every test that constructed its `NodeStore` directly
instead of through the real round trip. Fixed by threading a second small transfer structure through
`ParseDoneMessage`; the same gap on `subtreeSplice.ts`'s incremental-reparse graft path is disclosed,
not fixed, in `docs/TASKS.md`'s Owed table. R137 (path queries resolving `//inv:price` against
document declarations) needs a real change to the query engine's matching contract and was not
started — stopped and reported rather than rushed.

## R132, R138–R139 — existence predicates, and the predicate that became an expression · built (R139 has one unmeasured acceptance criterion — see the Owed table)

`car[@id]`, `car[price]`, `car[@*]`, `car[*]` (R132), and `and`/`or`/`not`/parentheses (R138), landed
together since both touch `parsePredicateBody` in `src/core/path/parse.ts`. That function stopped
being a string-pattern-match and became a real precedence-climbing expression parser over an
explicit operand/operator/paren stack — no recursion, so the module's own "no recursion" claim
stays true, restated to cover the predicate body's own nesting. R129's comparison and R132's
existence are the operand productions; `and`/`or`/`not` combine them, with the XPath 1.0
operator-vs-operand-position rule (`[and]` is existence on an element named `and`; `[price and
year]` has `and` as an operator) falling out for free from the parser's own operand/operator
alternation, no separate lookback needed. `src/core/path/evaluate.ts` generalizes the single
`ComparisonPlan` a step's predicate used to carry into a small plan tree (R139), built once per
query and constant-folded — an unresolved subject anywhere in the tree collapses `and`/`or`/`not`
around it at build time, so `not(price>100)` over a document with no `price` name at all becomes a
single always-true node with no store access. R133 (`not(...)` as a special form) stays allocated
and dropped, exactly as both plan documents specify — R138's expression parser owns `not` as a
unary operator instead. Two of the sixty-odd `test/pathParse.test.ts` tests changed meaning under
R132 (`car[@id]`, `car[garbage]` are now valid existence predicates rather than parse errors) and
were updated to assert the new behaviour. One acceptance criterion (R139's `and` short-circuit cost
measurement) is unmeasured rather than unmet — recorded in `docs/TASKS.md`'s Owed table.

## R126–R128 — the match count: exact reservation, vertical centring, and a reopen that restores results · built

Three defects in the Find bar's count area (`docs/plans/R126-find-count-stability.md`). **R126**: the
`(stale)` suffix — plus, unreported, the ordinal simply growing digits — pushed the whole bar
sideways because `.find-count` sized itself by content with only a `min-width: 6em` floor. Dropped
`(stale)` entirely (`SearchResult.stale` stays in the store for any future consumer; only the render
stopped reading it) and replaced the floor with an *exact* reservation: a hidden `.find-count-sizer`
holding `{total} of {total}` stacked in the same CSS grid cell as the live `.find-count-value`,
right-aligned so the constant part (`of 65,432`) never moves regardless of the ordinal's width.
**R127**: `.find-bar-row`'s `align-items: flex-start` — R89's own justification for it ("once the
textarea can grow past one line, centering would drift the buttons") stopped applying the moment R102
reverted the multi-line find field, and only the side effect (the count sitting above the buttons'
centre line) was left over. Now `align-items: center`. **R128**: reopening Find with `Ctrl+F` kept the
surviving query text (the component never unmounts between opens) but showed `No matches`, because
`handleClose` clears `activeSearchStore`'s result and nothing re-ran the query on a plain reopen — only
a palette hand-off's prefill did. The open effect now re-runs the surviving query (current case-
sensitivity and match mode, not hardcoded ones) whenever there is no prefill and the text is non-empty.

## R120–R123 — the Find bar's keyboard: tab order, Enter, Escape, and staying inside · built

Four keyboard defects (`docs/plans/R120-find-bar-keyboard.md`), all riding one new mechanism: a
`keydown` handler on `.find-bar`'s own container, `handleBarKeyDown`. **R120**: Tab now visits the
replace input right after the find input (spliced in by `orderedFocusables`, which derives the order
from the DOM rather than a hand-maintained ref list, and filters out disabled controls) rather than
falling through to wherever the replace row happens to sit in markup. **R121**: Enter in the replace
field runs Replace; `Ctrl+Alt+Enter` (VS Code's and Sublime's own binding, chosen over `Alt+A` since
this app has no mnemonic-underline convention) runs Replace All from anywhere in the bar, handled
locally rather than as a registered command — closing the same "nothing outside an open bar can
meaningfully act on it" gap `commands.ts` already states for Close. Both buttons' `title`s now name
their chords, and the Shortcuts panel gained a "Find bar" curated group. **R122**: Escape moved from
the find input's own handler to the container, so every control closes on it — and closing now returns
focus to whichever pane last held it (`focus.ts` gained `focusLastPane`), guarded so it only fires when
focus was actually inside the bar. The container handler ignores `Ctrl`/`Alt`/`Meta`+Tab, since the
global keymap `preventDefault()`s `Ctrl+Tab` without `stopPropagation()`. **R123**: Tab past the last
control wraps to the first (and back) — falls out of R120's ordering function for free. The bar stays
non-modal (`F6`/`Ctrl+1-3` still leave it open), documented in the Shortcuts entry itself so the trap
isn't a surprise.

---

## R124 — the go-to hint says which unit *this* document takes · built

Reported as a question: the palette's `:` mode and the status bar's caret button both said "line or
byte" as if the user could choose, but `parseGoToPosition`/`hasMeaningfulLines` (`detailModel.ts`,
D9) already decide that automatically per document — there was never a way to type the other unit,
and nothing in the UI said so. Three copy-only fixes, no behaviour change:

- Palette `:` mode, empty query: `Type a line number (1–N)` (meaningful-lines documents) or
  `Type a byte offset (0–N). This document has no lines to number.` (everything else), `N` from the
  real `lineCount`/`byteLength` via `toLocaleString()`.
- Status bar caret button `title`: `Go to Line` / `Go to Byte Offset`.
- Shortcuts panel's Command Palette row: `:42` → `Go to line 42 — or byte offset 42 in a document
  with no lines`, replacing `:line or :offset` → `Go to a line number or byte offset`, which read as
  two accepted syntaxes rather than one.

New test: `test/goToPositionHint.test.tsx`, asserting the literal rendered strings (not the
predicate) for both a multi-line and a single-line document. `test/goToPosition.test.ts` untouched.
Full plan and rendered-copy rationale: `docs/plans/R124-go-to-position-hint.md`.

---

## R125 — legacy single-byte documents (Windows-1252, ISO-8859-1/15, …) are editable · built

`documentEdits.ts`'s `encodeForRoundTrip` refused every edit to any document not UTF-8/UTF-16,
under a comment claiming real codec tables would be "a separate, sizable piece of scope." R53 had
already built exactly that — `core/textEncode.ts`'s `encodeText`, probing `TextDecoder` with all
256 byte values once and inverting the map, D-074 — for `Interner.lookup`, and nothing connected
the two. `encodeForRoundTrip` is now a one-line delegation.

The part that wasn't a one-line change: `encodeText` returning `null` means two different things —
the encoding itself is never writable (`shift_jis`, genuinely multi-byte), or the encoding is fine
and *this specific text* has a character it can't represent (`日` into `windows-1252`). Collapsing
them back to one `unsupported-encoding` refusal would have made the app worse than before: a user
who has been editing a Windows-1252 document all along, then pastes one CJK character, would be
told Windows-1252 itself is unsupported — false, and a regression in how the reason reads. So
`EditRefusal`/`ReplaceRefusal` split into `unsupported-encoding` (unchanged meaning, now correctly
narrow) and a new `unrepresentable-character` carrying the offending character. `textEncode.ts`
gained `canEncode(encoding)` to tell the two apart without re-probing, and
`findUnrepresentableCharacter(text, encoding)` to name the character in the refusal message.

Not a new decision — D-009 already said "refused with an explanation, not substituted"; this made
the code match the per-character rule that decision actually described, and D-009 now cross-refers
to D-074 as the mechanism. Two existing tests that asserted the old blanket refusal were flipped in
place (`test/documentEdits.test.ts`), and six new tests cover round-tripping bytes (not just the
decoded string) through both `createEdit` and `applyReplaceAll`, on a real XML prolog-declared
encoding. The convert-to-UTF-8 offer this refusal makes possible is deliberately not part of this
round — it rewrites every byte, needs a reparse and an undo-budget confirmation, and building it
first would wire it to a refusal that shouldn't have been firing.

---

## R129–R131 — M7's comparison predicates land, and the plan's own numbers get corrected · built

`docs/plans/R129-query-predicates.md`. Comparison predicates in the path grammar
(`car[price>100]`, `car[@year<2000]`, string and numeric, all six operators), XPath 1.0's `number()`
semantics rather than JS's `Number()` (five documented divergences: `1e3`, `0x10`, `""`, `+5`,
`Infinity` are all `NaN`), a resumable predicate loop so a long candidate walk yields to
`runChunkedJob` instead of running one unpreemptible step (retiring a G10 finding disclosed since
M4), and an allocation-free `NodeStore` attribute accessor that retrofits the existing `facet`
predicate (`@id="c-001"`) onto the same fast path.

**Two of the plan's own pre-measured numbers didn't reproduce and are corrected in the plan
document's own Results section**, with the real costs: §2's 17.5 ms floor for a numeric predicate
turned out to be memory-bandwidth-bound on a full-size corpus, not reachable regardless of
implementation; and §7's "113 ms is mostly allocation" turned out to undercount — `attrStartOf`/
`attrEndOf`'s binary search over a 2,000,000-entry table cost more than the allocations it was
blamed alongside, fixed with a galloping search using a monotone lower-bound hint. A third,
unpredicted cost (a candidate array being copied out of its `Int32Array` on every step) was found
and fixed along the way, taking the no-predicate baseline from 11.0 ms to 0.3 ms as a side effect.

Both wall-clock budgets in §10 are met: `//car[@vin="…"]` (previously 239 ms in the disclosed G10
finding) now completes in 30 ms; `//car[price>50000]` (previously inexpressible — the grammar
didn't parse it) in 30.6 ms. `gridSort.ts`'s `isNumericColumn` deliberately keeps `Number()`
(D-085) rather than unifying with the new grammar — different questions, cosmetic sort vs. query
correctness.

---

## R118 — the modal scrim is removed; it could never cover the caption buttons · built

Reported from a screenshot: the palette dims the app behind it, but Windows' minimize/maximize/close
buttons stay undimmed. Investigated, and it is a hard boundary rather than a bug — `src/shared/titleBar.ts`
already says it in as many words: **"Windows' `titleBarOverlay` paints outside CSS's reach."** With
`titleBarStyle: 'hidden'` plus `titleBarOverlay`, the caption strip is drawn by the OS and composited
over the web contents; it is not DOM. `TitleBar.css`'s `.title-bar-win32 { padding-right: 138px }`
exists precisely to reserve space for pixels the renderer cannot draw into. So an `inset: 0` scrim
covers the whole window *except* that rectangle, by construction.

Recolouring them is possible and was rejected. `setTitleBarOverlay` is already wired as
`titleBar:setOverlayColors`, so dimmed colours could be pushed on open and restored on close — but
it is an async IPC round-trip that would lag the scrim by a frame on something opened as often as
Ctrl+Shift+P; it cannot touch Windows' own hover feedback, so the close button would still flash full
red over a "dimmed" palette; and it puts a second writer on OS state the theme sync already owns,
needing restore-correctness on every exit path.

**The check also found the scrim was not dimming in dark at all.** It was
`color-mix(in srgb, var(--surface-fg) 30%, transparent)`, and `--surface-fg` in dark is `#eceef2` —
a near-white. Measured and rendered: the 30% veil composited `#14171e` up to roughly `#55585e`, a
pale fog rather than a dim. That is *why* the untouched caption buttons read as so mismatched —
everything else shifted several steps lighter and they did not move.

So the scrim goes, from `.palette-overlay` and from `.shortcuts-overlay`, which carried the
identical rule — one modal dimming while the other did not would be a worse inconsistency than
either choice. Modality is still carried by focus capture and by elevation, which is what D-051's
token *pair* exists for, and the measurements confirm each theme leans on the half that works in it:

| | panel vs app behind it | border vs app behind it |
|---|---|---|
| dark | 1.10 (weak; its shadow is near-invisible on dark too) | **1.84 — the real separator** |
| light | **1.00 — `--elev-2-bg` *is* `--surface-bg`, both `#ffffff`** | 1.31, plus a strong two-layer shadow |

Neither theme was relying on the scrim: dark separates by border, light by shadow. Worth recording
that light's panel has *no* background distinction from the app at all — the shadow is load-bearing
there, so anyone flattening it would remove the only thing separating the palette from the page.

Rendered both themes before and after rather than reasoned about. No test asserted the scrim.

## R117 — R115's caveat re-checked: the facts hold, the conclusion does not · built

R113–R116 landed as `built-caveat`, the caveat being that `drawSelection()` is not among `Raw.tsx`'s
CodeMirror extensions, so `.cm-selectionBackground` and `.cm-cursorLayer`/`.cm-cursor` never reach
the DOM and R115's token split is dead CSS. Checked independently rather than taken at face value.

Every measurement in it is right. `Raw.tsx`'s `extensions` array is six custom extensions with no
`basicSetup`; a real mounted `Raw` with a real selection counts 0 `.cm-selectionBackground`, 0
`.cm-cursorLayer` and 0 `.cm-cursor`, focused and blurred alike. `Raw.css`'s two `!important` rules
are dead exactly as reported.

The conclusion is not. The caveat says the browser's own rendering is something this app's CSS
"does not — and currently cannot — touch". **`::selection` touches it.** In the exact shipping form,
reading the same `--selection-bg` that R113 already drives from `:focus-within`, the computed
`::selection` background is `rgb(23,35,63)` (`--row-selected-bg`) when Raw has focus and
`rgb(61,68,83)` (`--row-selected-inactive-bg`) when it does not. Custom properties resolve inside
`::selection`, and an ancestor `:focus-within` re-evaluates *and repaints* — confirmed by screenshot,
not by `getComputedStyle` alone, because a computed value that never reaches the screen is the exact
failure this caveat is about. So R115's goal needs no `drawSelection()`, and the trade-off the
caveat correctly declined to make — secondary-range rendering, a DOM-layout cost — does not have to
be made at all.

The impact is also larger than "inert". `.cm-content`'s computed `::selection` background is
`rgba(0,0,0,0)` — no author rule applies — so Chromium paints its own default: Raw's text selection
is **unthemed in both themes**, a saturated blue on a near-black surface in dark that matches no
token in the palette. And it does not dim on blur; the DOM selection survives at full strength
(`rangeCount: 1`, `collapsed: false`, same text after focus moves to another element) and paints
identically. R115 is not "landed but inert" — it is the one row of the round's own table that is
still wrong on screen, in the direction the round existed to fix.

The caret row of that table is right for the wrong reason. CodeMirror's `.cm-cursor` rules never
apply, but a caret is painted only in the focused editing host — `.cm-content` is
`contenteditable="true"`, and six samples either side of a blur confirm it is `document.activeElement`
only while focused. It is also already themed: `Raw.css:99` sets `caret-color: var(--accent)`,
computed `rgb(122,162,255)`, so the caveat's "this codebase's CSS has no rule for it at all" is wrong
by one line in the same file. Nothing to build there; the reasoning under the row needs replacing so
nobody re-derives it from a base theme that is not in play.

R117 landed in the same pass. The dead `.cm-selectionBackground` pair is deleted rather than left
carrying a misleading `!important`, and `::selection` replaces it on both `.cm-content ::selection`
and `.cm-content::selection` — the text sits in descendant `.cm-line` elements, so the bare form
alone never colours what the user sees. Both read the `--selection-bg` that `.raw-pane` already
carries, so Raw's selection now uses the app's tokens and follows pane focus in both themes. The two
pieces of reasoning are corrected in place, and the characterization test asserting
`drawSelection()`'s layers are absent is kept — reworded from "an owed gap" to "why `::selection`
is the mechanism", and it still fires the day someone adds `drawSelection()` and both mechanisms
would go live at once.

Verified as **painted**, not only computed, since that distinction is the entire reason the task
existed: screenshotted focused and blurred against the real stylesheet in dark, where the selection
had been Chromium's default blue at full strength in both states. The new positive test was checked
to fail without the CSS — it reports `rgba(0, 0, 0, 0)`, the "no author rule applies" state that
let the browser default through.

---

## R113–R116 — content-level focus cues, as a second layer · built (caveat closed by R117)

Sequel to R106: the whole-pane `:focus-within` border answers "which pane has focus"; this round
answers the finer question "which item in it will the keyboard move" — each pane's own selection
or active item now reads blue when the keyboard is in that pane, grey when it is elsewhere.

Mechanism is one CSS variable swap per pane, set on the pane's own viewport root and overridden
under `:focus-within`, so every drawing site inside participates automatically rather than needing
its own `:not(:focus-within)` override written by hand. Two new tokens
(`--row-selected-inactive-bg`, `--focus-ring-inactive`), each measured against the palette rather
than picked — see the plan's own §4 contrast table, including two candidates that measured too
close to hover or to each other and were rejected. Landed in `Tree.css`, `Detail.css`, `Grid.css`,
`Raw.css` and both theme files. R116's enumeration test (modelled on R101's `externalRewrites`
guard) fails for a future pane that never wires the variable in, rather than trusting memory.

**The caveat:** R115 asked for a `.cm-selectionBackground`/caret split characterizing CodeMirror's
own base theme — reasonable to expect, since `Raw.css` already carried `!important` rules for
`.cm-selectionBackground` as if they mattered. They don't: `drawSelection()` is what actually
mounts `.cm-selectionBackground`/`.cm-cursorLayer` into the DOM, and it was never wired into
`Raw.tsx`'s extensions, so those classes never render — Raw's real selection/caret comes from the
browser's own native rendering, untouched by any of this app's CSS. The token split still landed
faithfully; it's inert until `drawSelection()` is added, which is a real editor-behaviour change
(secondary-range rendering, a documented DOM-layout cost) well outside this round's scope. Reported
in the plan's §11 and `docs/TASKS.md`'s Owed table rather than silently added or silently dropped.

## R112 — F6 was dead after opening a document, and could not repair itself · built

Reported: after opening a file, focus is visibly in the Tree pane and F6 does nothing — not once,
but ever, until the user clicks another pane by hand, after which cycling works normally.

Reproduced by mounting the real `Layout` under `StrictMode`, which `main.tsx` wraps the whole app
in: `document.activeElement` is `.tree`, `wasLastFocusedPane` is false for all three panes, and F6
three times running leaves focus exactly where it was. Two mechanisms, and the bug needs both.

**`focusin` is an event, not a state.** `registerPane` learns which pane holds focus only by hearing
it. StrictMode's mount → cleanup → mount replay runs the registration cleanup, which clears
`lastFocusedPane` — but the DOM element never unmounts, so it keeps focus, and no second `focusin`
is fired for the listener that replaces it. `Layout`'s open-a-document effect does not re-run to
repair it either: its `previousPhaseRef` already reads `ready`, so the phase-transition guard
correctly declines to fire twice.

**`moveFocus`'s null case then makes it permanent**, and this is the half worth remembering. With
`lastFocusedPane === null` the index is `-1`, so `next` targets `PANE_ORDER[0]` — the Tree — which
is already focused. `.focus()` on an already-focused element is a no-op, so no `focusin` fires, so
the state is still `null` on the next press. The state that breaks F6 is also the state that
prevents F6 from repairing it. That is why it never recovers on its own, and why a click, which does
fire `focusin`, fixes it for good.

Fix: `registerPane` adopts focus that is already inside the shell it is given. `FocusablePane` gains
an optional `contains?` — real `HTMLElement`s have it, so `PaneShell` gets the behaviour for free
while the plain objects the tests register skip it and the module stays DOM-free by contract.
`document.body` is excluded deliberately: it contains everything and is also where focus sits when
nothing is focused, so counting it would make every registration claim the focus.

Rejected: having `focusPane` set `lastFocusedPane` itself. It would leave the first F6 press still
doing nothing and only unstick the second — treating the symptom one press later rather than the
state being wrong.

Dev-only in practice but not fixed as a dev-only problem: StrictMode is what makes it happen every
time, but a shell registering while focus is already inside it is reachable by any remount, and
nothing in the fix is conditional on StrictMode.

`test/focusAfterOpen.test.tsx` (3 tests), checked to fail without the fix. `FINDINGS.md` gains the
general trap: pairing "learn focus from the event" with "fall back to element zero" can deadlock.

---

## R111 — the grid ring goes too, and the panes step 1px off the window edge · built

Two follow-ups to R106's addendum, both confirmed by looking at the running app before committing.

`.grid-scroll` is out of `Grid.css`'s `:focus-visible` selector. It drew the identical inset box the
addendum had just removed from list mode, so F6 into a grid still produced the sub-pane highlight the
report objected to. Grid mode also has a within-pane indication the list has not — `.grid-cell-active`
rings the keyboard-focused cell — which made the container ring the redundant one of the two.
`.grid-quick-filter` keeps its ring: an ordinary text input has nothing else saying where typing will
go. `.grid-scroll` keeps `outline: none`, so the user-agent ring does not return in its place.

The window edge is the other half. The pane overlay is a 1px border at `inset: 0`, so on the
outermost panes it lands on the window's own edge pixel, which Windows' frame and rounded-corner mask
cover — a focused Tree loses its left edge, a focused Detail or Raw its right. Only left and right
are ever at risk: `TitleBar` sits above `.layout` and `StatusBar` below `.layout-body`.

**Insetting the overlay was ruled out by measurement, not taste.** The scrollbar track is pinned to
`right: 0` at `--scrubber-width` (15px) and its thumb is inset `left: 1px; right: 1px`, so the thumb
spans `[W-14, W-1)` — **the overlay currently sits in exactly the one free pixel column the thumb
leaves**, and moving it inward by 1px would put it on the thumb. So `.layout-body` gets
`padding: 0 1px` and the panes move instead of the ring.

The cost was measured and accepted rather than discovered later: the track background is deliberately
opaque (`--scrollbar-track-bg`, R33/1c) and differs from `--surface-bg`, so Detail and Raw get a 1px
seam between the scrollbar and the window edge at all times, focused or not. Rendered both ways and
compared — indistinguishable at 1x, obvious at 6x. Invisible on the Tree's left edge, which has no
track.

**Worth not confusing**: the gutter shows `--surface-bg`, the same colour as the panes, so it draws
no visible window boundary and does nothing to separate one window from the next when two overlap.
That would be `border-left`/`border-right` on `.layout` in `--surface-border`, matching the
`border-top` it already has. This change only makes the focus ring complete.

## R106 addendum — the pane overlay is the focus indication, not a ring inside the pane · built

Reported from a screenshot after R106 landed: F6 into Detail draws a blue box around the pane's
*content*, which reads as a sub-region being highlighted rather than as "this pane has focus." The
expected indication is the quiet grey border around the whole pane that Tree and Raw already show.

R106 §2 had decided the opposite, and the reasoning was wrong in a specific way worth recording: it
argued that list mode has no active item (no selected row, no active cell), so the container ring is
the only signal of where the arrow keys go. True in isolation — and answering a question the app had
already answered elsewhere. `.pane:focus-within::after` (`Layout.css`) exists to say which pane has
focus, for every pane, and F6 is a pane-level operation. The second ring did not add precision; it
competed with the existing indication and pulled the apparent boundary of the focused region inward,
past the pane header. **Chosen from a rendered screenshot both times, and the second look overruled
the first** — the argument for the ring was sound on paper and obviously wrong on screen.

`.detail:focus-visible` deleted. `.detail` keeps `outline: none`, which is what actually fixed the
originally reported defect (the user-agent `outline: auto` ring whose clipped sliver was the ~1px
white line); `.tree` has had exactly this shape all along. Stated rather than glossed: list mode now
has no indication of which element within the pane takes the arrow keys — the same position Tree and
Raw are in, acceptable because the arrows scroll the pane as a whole there, so a ring would mark a
target that does not exist.

`test/detailFocusRing.test.tsx` rewritten to assert the new contract: `outlineStyle` is `none`
(neither `auto` nor a replacement ring), and `.pane::after`'s border colour becomes
`--pane-focus-ring` on focus, in grid and list mode alike. The token has to be resolved through a
probe element — `getPropertyValue('--pane-focus-ring')` returns the literal `var(--gray-300)` it is
declared as, not the colour, so the comparison would never match. The test file now renders Detail
inside a real `.pane` element, since the rule under test lives there. 5 tests; full browser suite
(40 files, 201 tests) and lint clean.

**Left open deliberately**: `.grid-scroll:focus-visible` (`Grid.css:36-39`) draws the identical inset
box, so grid mode still shows the sub-pane highlight this removed from list mode. Not reported, and
predates R106, so reported rather than quietly changed — with the recommendation to drop
`.grid-scroll` from that selector and keep `.grid-quick-filter` (a text input needs its own ring; a
scroll container with an already-ringed active cell does not).

## R104–R105 addendum — only the name is clickable, and the spacing rebalanced · built

Two follow-up reports against R104/R105 as built, from a screenshot. The whole-row button (R105's
own tradeoff for a larger hit target) read as broken: a row that looks like a link but responds to a
click anywhere in its own whitespace is surprising, not generous. Reversed — only
`.document-area-recent-name` is a `<button>` now, wrapping just the file name; the row is a plain
`<div>` with no hover background or cursor. `title={entry.path}` moved from the row onto the name
link. The link keeps `--accent` at rest and gains an underline on hover/focus instead of reverting to
`--surface-fg` — that reversion existed only to dodge a contrast failure against the row's own
`--row-hover-bg`, which is gone. One specificity trap along the way: the pre-existing
`.document-area button` rule (element + class) outranked the name's own single-class selector,
silently falling back to `--surface-fg` — fixed by scoping to
`.document-area-recent-row .document-area-recent-name`, caught by a failing test rather than
inspection.

Second report: the Open File… button read as closer to "Recent" than to its own heading/hint, since
the column's internal gap (`--space-2`) and the between-section gap (`--space-4`) were too close in
value for the section boundary to read as one. `.document-area-columns`' gap grew to
`calc(var(--space-4) + var(--space-2))`; a new `.document-area-open-column` rule narrows that
section's own internal gap to `--space-1`.

Full browser suite (40 files, 201 tests) passes; lint clean. `docs/plans/R104-start-pane-polish.md`
§6.1 has the full account.

## R108–R110 — Replace All is quadratic, and so is undoing it · built ⚠

A ~65,000-match Replace All on a 10 MB file froze the app — not hung, working: `applyReplaceAll`'s
`for (patch of patchesDescending) bytes = applyPatch(bytes, patch)` allocates a whole new
`Uint8Array` of the entire document per match, making the loop O(document × matches). Measured at
~3.0 ms/match, dead linear; the reported case extrapolates to ~196 s. R108: `applyPatchesAscending`
(`documentEdits.ts`), a single-allocation ascending pass — every match is non-overlapping and
already valid against the original buffer, so the whole result can be sized and filled once. 5 MB /
20,000 matches: 28.9 s → 7.5 ms.

R109 (undo/redo of a large Replace All) is where the round found more than it went looking for.
`applyUndoEntry` has the identical per-patch loop, and the plan's own analysis of how to fix it
(§4) implicitly assumed every `UndoEntry` it might see was shaped like a Replace All's own —
patches built as one batch against a single baseline, hence non-overlapping. That's true for
Replace All and for a Transform (always one patch), but `applyUndoEntry` is also the *general*
undo/redo machinery for ordinary typing, where entries are built **incrementally** — each patch
valid only once the previous ones in the same burst have already been applied — and can touch the
*same* byte range more than once (correcting a character three times in a row is exactly this).
Applying the single-pass primitive there isn't slower, it's wrong: caught not by reasoning about it
but by `test/documentSession.test.ts`'s own "a burst of many edits is one undo entry" test failing
loudly (`applyPatchesAscending: invalid or out-of-order range`) the first time the fast path was
tried unconditionally.

Fix: `UndoEntry` gains `independent: boolean` (`undoStack.ts`) — `true` only for a Replace All or a
Transform's own push, `false` for an ordinary typing burst. `applyUndoEntry` takes an explicit
`fast` flag; `undo()`/`redo()` decide it from the entry, rebasing (`rebaseSequentialPatches`,
verified by a real shrinking- and growing-replacement round-trip test) only in the branch where
that's sound, and falling back to the original, unconditionally-correct per-patch loop otherwise.
Marked `built ⚠` rather than `built` — R109 does not literally use "the same primitive for all
three callers" the plan asked for, and that's recorded as owed context rather than silently
narrowed (`docs/TASKS.md`'s Owed table).

Full node suite (101 files, 1432 tests, including new `applyPatchesAscending`/
`rebaseSequentialPatches` unit tests and the R110 5 MB / 20,000-match timing test) and full browser
suite (40 files, 201 tests) pass; lint clean.

## R106–R107 — the Detail pane's focus ring is the browser's, not the app's · built

Reported against R94 as built: F6 into Detail in list mode drew a ~1px white line across the top of
the pane. Cause: R94 made `.detail` focusable (`tabIndex={-1}`, for arrow-key scrolling) but gave it
no focus style, so Chromium's own `outline: auto` ring applied — and because `.detail`'s border box
is exactly `.pane-body`'s, that ring straddles the boundary `.pane-body`'s `overflow: auto` clips,
leaving only a sliver on the top edge (the other three edges sit against chrome that hides the
same sliver). Fix: `.detail:focus-visible { outline: 2px solid var(--focus-ring); outline-offset:
-2px }`, matching `.grid-scroll`'s existing rule exactly, since it's the same pane and list mode has
no active item of its own to indicate where the arrow keys are going.

R107, found while explaining why the grid route never showed the line: pressing Enter on a grid row
for a node with no repeating children unmounts `Grid`, taking the focused `.grid-scroll` with it —
focus falls to `<body>` even though the user never left the pane. The natural fix
(`document.activeElement`, read during render, the last point before React removes `Grid`'s DOM)
hit two walls: `DetailContent`'s own `document` prop shadows the DOM global of the same name, and
reading a ref during render trips this project's `react-hooks/refs` lint rule. Replaced with a new
`wasLastFocusedPane` export on `focus.ts`, driven by `focusin` on the pane's *shell* (which doesn't
unmount when `Grid` does) rather than by DOM state the unmount race destroys before any effect can
read it — and deliberately not cleared by an ordinary blur, only by the shell unregistering, which
is exactly what lets it answer "was focus inside this pane" after the fact. `DetailContent` reads
and writes its tracking ref only inside `useEffect`, keeping render itself pure.

`test/detailFocusRing.test.tsx` (5 tests, real Chromium) — including a caught-during-review bug in
its own first draft: comparing two elements' `getComputedStyle()` objects *after* one had been
unmounted silently compared against the post-unmount default, since `CSSStyleDeclaration` is a live
view, not a snapshot. Full browser suite (40 files, 201 tests) and lint clean.

## R104–R105 — the start pane, after looking at it · built

Follow-up to R95–R97 (`R95-recent-files.md`), against four reports that were all downstream of one
cause: the two-column block was too narrow. At the ~341px column R96's 720px split produced, the
file name box got 72.2px while wanting 84px (clipped) and the directory got 216.8px — the less
important half had three times the space. Fix: `.document-area-columns` becomes `flex-direction:
column`, `.document-area-start`'s `max-width` drops 720→560, and `.document-area-column` becomes
`flex: none` (a column flex container treats `flex-basis` as a height, so the naive
`flex-direction` swap alone stretched Open and Recent to opposite ends of a tall empty box).

The `No document open.` heading is gone — `StartColumns`'s `heading` prop is now optional, used
only for R97's error banner — and two accessibility issues that came with it are fixed in the same
pass: the `empty` phase's `role="status"` wrapper (which would have re-announced the whole file
list on every open, not just one sentence) is deleted, and `role="alert"` in the `error` phase now
wraps just the banner `<p>` instead of the whole start pane. The `kbd` key-cap overlap in the Open
hint (measured: `line-height: normal` gives a 17px line box against a 19px `kbd` border box, and
padding/border on an inline element never grows its own line box) is fixed with `line-height: 1.9`
on the paragraph, not padding on the caps.

Recent rows get `gap: var(--space-1)` (there was none at all) and a shrink-priority fix:
`.document-area-recent-name` and `-dir` were both `flex: 1 1 auto`, so shrink was proportional to
content width and the long directory kept more absolute space while the short filename got
squeezed to nothing — the exact inversion the report described. `flex-shrink: 1` on the name and
`100` on the directory, plus `overflow: hidden` on the row (middle truncation gives each field an
incompressible floor, so without this the row overflowed rather than clipped). The file name now
renders in `--accent` at rest and reverts to `--surface-fg` on hover — `--accent` on
`--row-hover-bg` measures 4.29:1 in the light theme, under WCAG AA, and the row's own hover
highlight already signals "actionable" so the accent color has no work left to do there.

`test/recentFilesUi.test.tsx` gained ten tests, several needing `userEvent.hover`
(`@vitest/browser/context`) rather than a dispatched `mouseover` — a synthetic event doesn't move
the real cursor real Chromium's `:hover` tracks. Full browser suite (39 files, 196 tests) and lint
clean.

## R102–R103 — the find field goes back to a single line · built

Reverts the multi-line half of R89 (`R86-find-as-query-surface.md` §5) — deliberately deferred until
R100 landed, so the revert never competed with a live display bug in the same files. The `<textarea
rows={1}>` with `autoGrow` (capped at 6 rows, measured from `scrollHeight`) is back to a plain
`<input type="text">`; `Find.css` loses every rule that existed only for a growing textarea
(`max-height`, `resize`, `overflow-y`, `scrollbar-width`, the `::-webkit-scrollbar` rule);
`test/findAutoGrow.test.tsx` is deleted. Two concrete reasons, not taste: the growing field made
Replace structurally inconsistent (a `<textarea>` and an `<input type="text">` sharing one CSS
class, one of the two ignoring half its own properties), and the manual-drag follow-up had to be
pulled after landing because a dragged height and `autoGrow`'s own computed height disagreed the
moment the next keystroke arrived.

**What stays, kept in the same commit rather than found missing later**: the narrow-width fix
(`.find-input`'s `width: 200px; flex: 1 1 auto; min-width: 0`, `test/r8Layout.test.tsx`'s three R89
tests, updated only at the selector) and `Raw.css`'s 3px left-edge current-match mark, now with a
comment saying it outlived the feature that prompted it. Four other test files needed only a
selector change (`HTMLTextAreaElement` → `HTMLInputElement`), confirming the plan's own prediction
that a behavioural change in any of them would be a signal something went wrong.

R103: the one thing the revert genuinely loses. Measured, not assumed — assigning `'a\nb'` to an
`<input type="text">` yields `'ab'`, the newline dropped and the two lines concatenated with no
separator, so a needle copied across two lines becomes a string that matches nothing with no
explanation on screen. Fixed by intercepting `onPaste`: a clipboard text containing a line break is
stripped explicitly and a footnote says so (the same row the ASCII-folding note and R87's path
diagnostic already use); an ordinary paste is left untouched. `test/findPasteLineBreak.test.tsx`
covers both cases plus the notice clearing on the next edit. Full account:
`docs/plans/R102-find-single-line.md`.

---

## R100–R101 — the Raw view follows a buffer rewritten outside it · built

Reported against R90 (Replace runs, Raw pane keeps showing old text) — investigated, and it is not
an R90 defect. Measured in real Chromium against a real session: Replace All, Format, Minify, Undo,
Redo and Reload all leave `.cm-content` showing stale text while `sourceBuffer`, the dirty flag, and
every other pane are correct. **The regression point is R41, and it is five days old, not months** —
before `a50ceff` (R41, 2026-08-16) the mount effect was keyed on `store`, so every reparse tore the
`EditorView` down and rebuilt it from the current buffer, which is what made these five paths
display correctly *by accident*. R41 correctly stopped that remount (it was destroying the caret on
every keystroke's debounced reparse) but left nothing else to carry an externally-rewritten buffer
to the view — `Raw.tsx:530`'s own comment stated the false assumption plainly: "the view's own
document is already the live, correct text," true for typing and false for everything else.

Fixed via `OpenDocument.externalRewrites` (R100), a counter incremented by the four call sites that
replace `sourceBuffer` outside the Raw editor's own path (`applyReplaceAll`, `applyTransform`,
`applyUndoEntry`, `reloadFromDisk`) and checked by `Raw.tsx`'s live-update effect — unchanged means
today's in-place refresh, changed means a full reslice around the caret. A text-comparison
alternative was rejected on cost (a ~1 MB allocation every ~200ms of typing). Building the per-path
regression test surfaced a second, sharper bug: `applyReslice`'s incremental path assumed old and
new windows described the *same* buffer just scrolled, so it kept stale decoded text for whatever
byte range the two windows shared — wrong whenever the rewrite changed the buffer's *content*, not
just its length (a Format spliced old and new text together at the overlap). Fixed with a
`forceReplace` parameter that skips the incremental path entirely for an external rewrite. R101 adds
a static enumeration guard (`test/externalRewritesEnumeration.test.ts`) over `documentSession.ts`'s
own source, so a sixth rewriting method added later fails the guard if it forgets to mark the
counter, rather than shipping the same stale-view bug again undetected — verified to actually catch
a regression by temporarily breaking one call site. `test/rawEditCaretSurvival.test.tsx` (R41's own
regression test) passes unmodified. `docs/FINDINGS.md` gains both the general finding and the
`planReslice` trap. Full account: `docs/plans/R100-raw-external-rewrite.md`.

---

## R98–R99 — the font follows the glyph, not the surface · built

A report against R83 as built: the XML element marker (`<>`) renders as a filled diamond, not two
angle brackets. Cause measured, not guessed — canvas advance at 11px showed the `--font-mono` stack
resolves to Cascadia (identical to naming it directly), whose `<` and `>` carry almost no side
bearing inside a 6.45px advance, so the two chevrons meet at a point; the same string in Consolas
renders open. One font's letterform, not a property of monospace fonts in general — R83's own
width measurement was correct and still shipped the defect, because width says nothing about
shape. `glyphFont.ts`'s `glyphFontClass(glyph)` keys the fix on the glyph string itself (`<>` alone
gets `--font-ui`, everything else keeps `--font-mono`), applied at `.tab-icon`/`.tree-row-glyph`
(R98) and `.detail-node-glyph`/`.detail-child-glyph` (R99, its own id since Detail already rendered
`<>` correctly and only `{}`/`[]` change there).

Superseded both predecessors' own generalisation: R71 removed monospace from every marker on a
width theory its own follow-up work falsified; R83 restored monospace everywhere, measured
correctly against R71's complaint and still wrong about `<>` specifically. `docs/DECISIONS.md`
D-084 records the correction; `docs/FINDINGS.md` gains a "Fonts" section (`ui-monospace` is not
actually monospace in Chromium on Windows; Cascadia's `<>` diamond is a letterform property, not
fixable by size or weight). Full account: `docs/plans/R98-glyph-font-per-glyph.md`.

---

## R95–R97 — a recent files list on the start pane · built

New `recentFiles.ts` (`nodepad.recentFiles`, cap 6, paths only) — a genuine history, unlike
`sessionRestore.ts`'s `nodepad.sessionRestore`, which is a snapshot of the currently open tab set
and loses an entry the instant its tab closes. Recorded from the one place a document transitions
*into* `ready` (covers the dialog, drag-drop, session restore and a recent-file click itself in one
line) plus Save As. The start pane's `empty` phase splits into two `flex-wrap` columns — Open, then
Recent — and R97 found the same layout belonged in the `error` phase too: `cancel()` has no path
back from `error` to `empty`, so a bad open used to strand the user on a lone Open File… button with
the recent list gone until something else opened successfully. A stale entry (deleted, renamed,
unmounted drive) removes itself after the failed open that reports it, so the list doesn't keep
offering a file that just failed.

Also amends `docs/plans/R84-settings-group.md` §R85 in place: its still-open "turning session
restore off clears the key" decision had argued that off means the app keeps no list of recent
paths at all, which this round makes false. Conclusion unchanged; the reasoning is corrected to
scope the claim to session restore specifically, since the two stores now answer different
questions and a dormant `sessionRestore` key recording invisibly is a different failure mode from a
recent-files list that's on screen with a Clear button beside it.

Full account: `docs/plans/R95-recent-files.md`.

---

## R91–R94 — F6 lands on the pane's own content, not its shell · built

Cause was exact and short: `PaneShell` registered its `tabIndex={-1}` wrapper with the focus model,
and every pane's arrow-key handling lives on an element *inside* that wrapper — a `keydown` on the
wrapper bubbles up, never down, so F6 selected a pane but left the keyboard nothing to drive. `focus.ts`
gained `registerPaneContent(pane, () => boolean)`, tried between the shell-registered check (a
hidden pane still no-ops) and the shell's own `focus()` (the floor). Tree registers `.tree` directly
(R91); Raw registers `.cm-content`, focusing it without moving the caret — already at the selected
node's span start — but making it visible via `jumpTo` when the window had scrolled past it (R92);
Detail delegates to a new `GridController.focusGrid()` in grid mode, or focuses `.detail` itself
(already the pane's own scroller) in list mode (R94). R93, found while checking R94 would actually
work: the grid had no scroll-into-view at all, so arrowing past the last rendered row moved the
active cell to one the virtualizer had never mounted and the highlight vanished — fixed by mirroring
`Tree.tsx`'s own `scrollToIndex` effect for rows, and a hand-computed scroll target for columns
(the sticky/pinned columns' width has to be folded in as a right-edge inset, or the target lands
underneath them).

**Behaviour change worth knowing about**: opening a file or jumping via the palette now focuses
*inside* the Tree rather than on its wrapper, and the Tree consumes bare printable keys for
type-ahead — a stray keystroke right after opening a file now navigates the tree instead of doing
nothing. Standard tree-widget behaviour, but it's the kind of thing that gets filed as a bug weeks
later if nobody remembers why. Full account: `docs/plans/R91-focus-into-content.md`.

---

## R89 — find textarea drops manual resize · built ⚠

The `resize: vertical` handle added alongside auto-grow let a manual drag and `autoGrow`'s own
measurement disagree: a drag pinned a height that persisted even after the text that justified it
was gone, since `manualResizedRef` made auto-grow yield permanently once set. Removed entirely
(`resize: none`) rather than reconciled — the field now tracks only what's typed into it.
`manualResizedRef`, `suppressNextResizeRef` and the `ResizeObserver` effect that supported the
override are gone with it; `autoGrow` is back to measure-clamp-set. Two manual-resize tests in
`test/findAutoGrow.test.tsx` replaced with a `resize: none` assertion and a fresh-open check. Full
account in `docs/plans/R86-find-as-query-surface.md`'s own Results section.

---

## R89/R90 — find bar polish from direct use · built ⚠

Four small corrections against the just-shipped R86–R90 bar, filed against the rounds they touch:
`.find-input` narrows from 320px back to 200px (R89 — the pre-round field had no explicit width,
but `min-width: 200px` governed it at every size measured, so that's what "same width as before"
actually means), its scrollbar is hidden without losing scroll (`scrollbar-width: none` plus the
`-webkit-` pseudo-element), Replace/Replace All become icon buttons (`arrow-swap`/`arrow-repeat-all`,
R90), and the replace row now sits directly under the find row with its input genuinely aligned
under the find textarea — a spacer standing in for the disclosure button's width, and the input's
own `flex-grow` dropped so it doesn't stretch past that alignment just because its row has fewer
competing buttons. Both new geometry assertions initially failed for an unrelated reason first:
`.find-bar`'s `max-width` is a percentage of its positioned ancestor (D-080), and a bare test
container with none resolves it far too narrow — `test/r8Layout.test.tsx`'s own wide wrapper
pattern fixed both. Full account in `docs/plans/R86-find-as-query-surface.md`'s own Results section.

---

## R86–R90 — the Find bar becomes the document's query surface · built ⚠

Path joined text as a second `SearchQuery` mode (`mode: 'text' | 'path'`) rather than staying the
palette's `setDirectResult` snapshot, which closed the real bug motivating the round: a path result
used to go stale permanently the moment the document changed, because there was no `SearchQuery` to
re-run. `findJobFor` now branches into `pathJobFor`, which parses fresh against the live store on
every evaluation (a parsed path is bound to the interner that produced it, so caching one would
reintroduce the staleness this round exists to fix) and adapts `evaluatePathChunked`'s node list
into the same ascending-span shape a text scan already produces.

`.*` and `/` became one `role="radiogroup"` segment with `Aa` a separate, composable toggle — path
mode runs only on Enter, never live, since a path mid-typed is usually a parse error. The palette's
own `/` confirm stopped publishing a result and started handing off instead: `openFindWithQuery`
prefills Find with the text and mode, Find re-evaluates it itself, and the same auto-select machinery
R79 built for text search lands on the first match for free. `setDirectResult`,
`getDirectResultOrigin`, `hasDirectResult` and the `.find-origin` chip are gone entirely —
`test/searchStore.test.ts`'s 21 references to them converted into path-mode equivalents rather than
dropped, and `test/findBarOrigin.test.tsx` (about the retired chip specifically) deleted in favor of
`test/findPathMode.test.tsx` and a new handoff test in `test/palettePathQuery.test.tsx`.

The Find input became a `<textarea>`, auto-growing to 6 rows measured from `scrollHeight` (capped in
JS, not CSS `max-height` — `resize: vertical` respects the latter, which would have capped a
deliberate drag along with the auto-grow). Manual-resize detection needed a real fix mid-round:
comparing the `ResizeObserver`'s reported height against the height `autoGrow` last set
false-positived in this environment (font metrics settling after mount), permanently disabling
auto-grow before any drag happened; replaced with a suppress-flag the observer clears on its next
firing regardless of the reported height. A second bug — the observer and the auto-grow effect both
needed `findState.isOpen` in their dependency arrays, not `[text]`/`[]` alone, since `<FindBar>`
never unmounts but its `<textarea>` does on every close — was caught by a dedicated close/reopen
test before it shipped. The layout rewrite this round required (`.find-input` the row's only
shrinkable item, everything else `flex: none`, `overflow-x: auto` as the fallback) also fixed a
pre-existing defect: below ~530px of layout width the row painted outside the bar and the window
entirely, close button included — asserted geometrically now, not eyeballed.

Replace and Replace All landed as one undo entry applied back-to-front, `estimateReplaceAllUndoBytes`
shared between the caller's pre-confirmation preview and the session's own re-check so the two can
never disagree about whether an entry will fit the memory budget. A read-only or unsupported-encoding
document refuses with a clear notification, never a silent no-op — which falsified one sentence in
`DECISIONS.md`'s "no read-only badge" entry (Raw stopped being "the one pane where an edit could be
attempted at all" the moment Replace could run from a hoisted Find bar with Raw hidden); the entry's
conclusion stands, its reasoning is amended in the same commit. Review caught one real bug before
commit: `applyReplaceAll` documented that matches must arrive ascending but never enforced it, which
would have silently corrupted the buffer for any caller that didn't — now sorts internally.

Two things owed, both disclosed rather than discovered later: the multi-line current-match ring (a
3px left edge now, not a full box-shadow ring, matching R57's own severity language) was reasoned
correctly from the decoration code but never screenshot-verified — no running Electron instance in
this environment. And the 50,000-match confirmation threshold was exercised through the undo-budget
branch of the same code path, not the literal match count, since building 50,001 real matches wasn't
judged worth the fixture cost. Full account: `docs/plans/R86-find-as-query-surface.md`'s own Results
section.

---

## R82–R83 — what R67 and R71 moved rather than fixed · built

R82: the palette's option list gained a hover gate — `useHoverGate`, one instance shared by both
lists — so `ArrowDown`/`ArrowUp` suppress hover-activation until the pointer genuinely moves again.
Without it, R67's `scrollIntoView` moved rows under a pointer that never itself moved, and the
browser's own real `mouseover` on whichever row slid underneath it snapped the keyboard-driven
selection back to wherever the mouse happened to rest. The coordinate check lives inside the
`mouseenter` handler itself (`activateOnHover`), not a separate `mousemove` listener — an earlier
version with a separate listener had a real ordering bug (`mouseover` fires before the accompanying
`mousemove` for the same pointer transition), caught by the guard test's own re-enable case before
it shipped. `test/paletteHoverGuard.test.tsx` uses real Playwright pointer automation
(`userEvent.hover`), since a dispatched `MouseEvent` never moves the OS-level cursor Chromium
tracks and cannot reproduce the bug at all.

R83: `.tab-icon` and `.tree-row-glyph` both regained `font-family: var(--font-mono)`, which R71 had
removed on an argument (the three format markers weren't the same character count) that its own
§5a invalidated in the same round by changing TOML's marker to two characters. `<>`'s width in the
UI font measured more than twice `{}`/`[]`'s against the same 20px box — a real size defect, not
just the reported angle. `docs/plans/R71-text-as-icons.md` §1 gained a correction block rather than
being left to contradict this round; the U+2329→U+3008 canonical-decomposition trap (which ruled
out an angle-bracket glyph candidate) is now in `docs/FINDINGS.md`.

Full account: `docs/plans/R82-hover-and-glyphs.md`'s own Results section.

---

## R78–R81 — the Find bar after a path query, and the current-match ring · built

R78: the path-query origin moved out of the Find input into a non-editable `.find-origin` chip with
its own dismiss control; the input is always empty and typeable, so typing over it is no longer a
special case, and `Aa`/`.*` disable while a direct result is live instead of silently discarding it.
R79: both a path query and a plain text search now select a match — caret-anchored via
`matchIndexAtOrAfter`, not pinned to index 0 — the instant their result lands, instead of reading
"0 of N" until the first `F3`. The guard test for "an edit-driven re-run must not move the caret"
found a real pre-existing bug while being written: `searchStore.ts` publishes a transient,
*incomplete* empty result the instant any re-run starts, and the old clamp effect reacted to that
by nulling `currentIndex` on every single edit with nothing to restore it — fixed by gating the
folded effect on `result.complete`. Measured on a synthetic 1,000,000-match/30 MB document:
`moveTo`'s own cost is sub-millisecond (p90 0.019 ms), three orders of magnitude under the 150 ms
debounce.

R80/R81: the current-match highlight was a fill measured down to 1.04:1 for text over it — no fill
between the already-passing dim one and the old value is both legible and distinct, so it became an
inset ring (`--find-match-current-border`) instead. The retired token's other two meanings
(Tree/Grid/Scrubber's "this row has a match" marker) split out as `--find-match-marker`, a pure
rename. `test/findMatchContrast.test.tsx` guards the fill and ring at 3:1 in both themes, verified
failing against the old value first.

Full account: `docs/plans/R78-find-affordances.md`'s own Results section.

---

## R72–R76 — the path query, and the seams it shows · built

R73: `core/path/parse.ts`'s `consumeSeparator` now treats a single leading `/` at position 0 as
descendant, not child — fixes `//name` (which arrives at the parser as `/name`, one slash already
consumed as the palette's own mode prefix) silently returning nothing. R74: `SearchStore` gained
`getDirectResultOrigin()`; the Find bar now shows a path query's own text (`/garage//name`) instead
of an empty input over a live count, and typing over it is the escape into an ordinary search. R72:
the `/` mode's empty state shows the grammar itself instead of one line leading with the hardest
form; a malformed query gets a caret under the offending character instead of a byte offset; the
`@`/`:`/`/`/`>` prefixes were fed to R65's shortcuts panel as a fourth curated group. R75: a new
`toNodePadPath` replaces `copyPathFor`'s XPath/JSON-Pointer choice — always the grammar every format
can be queried with, which also fixed a `toXPath` defect the JSON case exposed (an array element's
own position was never captured for a null name). §6/R76: the footnote's condition moved from
"almost every search" to "almost none" (keyed on `!caseSensitive && !isAsciiOnly(needle)`); the
underlying byte/decoded case-fold divergence is accepted as-is, recorded as D-082 together with R76
rather than as two separate calls, since fixing either one first turns out to require the other.

Review found one thing worth fixing before commit: two real-Chromium test files needed a longer
post-paint wait (50ms, not one tick) specifically on their very first render in the file — the same
first-paint margin `grid.test.tsx` already uses. Full account: `docs/plans/R72-path-query.md`'s own
Results section.

---

## R71 — the glyphs that are still text · built

`.tab-icon` dropped its monospace font (the only thing it actually bought was the bracket angle the
report flagged, not label alignment — `<>`/`{}`/`[]` aren't the same character count) for
`.tree-row-glyph`'s own fixed-width/centred mechanism; `tabDisplay.ts`'s `'[ ]'` became `'[]'`. Six
symbol-block glyphs iconified — the status bar's `⊗`/`⚠`/`ⓘ`, the Find bar's `↑`/`↓`/`✕` — via six new
entries in `commands/icons.ts`. The format markers (`<>`/`{}`/`[]`) and node-kind glyphs stay text, by
the round's own rule: ASCII/Latin-1/General Punctuation may be a mark, a symbol-block codepoint may
not.

Building the acceptance-2 scanner (`test/textAsIcons.test.ts`, a 116-file source scan) found two more
violations of that same rule that R71's own plan predates: R65's `Shortcuts.tsx` used Arrow-block
characters in its curated key-name table and the same `✕` in its own close button. Both fixed in this
round rather than left for a future one, since they're this session's own code.

Full account: `docs/plans/R71-text-as-icons.md`'s own Results section.

---

## R69–R70 — where focus lands, and where Find lives · built

R69: `focus.ts` gained `focusPaneOrFirstAvailable` (preferred pane, or the first registered one in
canonical order); `Layout.tsx` calls it with Tree on a genuine phase transition into `ready` (a
`useRef`-compared previous value, not "phase is ready," so a restored-`ready` session at startup
doesn't steal focus). Palette jumps (`@`/`:`/`/`) now focus a pane instead of restoring — a new
`paneForPaletteJump` in `paletteLogic.ts` resolves Tree for `@`/`/`, Raw for `:`.

R70: `<FindBar />` moved out of `Raw.tsx` to a direct child of `Layout.tsx`'s `.layout` (which gained
`position: relative` for it), unconditional on Raw's own visibility — `Ctrl+F` no longer does nothing
with Raw hidden. Anchored to `.layout`, not the viewport `App.tsx` the plan named, since that keeps
R8e's own caption-button fix without a pixel offset (D-080). The plan's step-2 recommendation — select
the node containing a match when Raw is hidden — turned out to already be built (`FindBar.tsx`'s
`moveTo` was never gated on Raw's visibility); verified, not written. The `@`/`:`/`/`/`>` palette
prefixes were also added to R65's shortcuts panel, per this round's own closing note.

Full account: `docs/plans/R69-focus-and-find.md`'s own Results section.

---

## R66–R68 — the palette: labels, scrolling, and toggle state · built

Built R68 first (`Command.state?: () => boolean`, all six toggle commands retitled to the noun they
describe — `Dark Theme`, `Tree/Detail/Raw Pane`, `Soft Wrap`, `Format Minified Files on Open` — and
wired to their existing getters), since R66's `tooltipFor` refinement needs `state` to exist before it
can key off it. Then R66 (`paletteLabel` — `Category: Title`, matched and rendered as one string via
a new `RankedCommand.label`; the separate category span removed; `tooltipFor` prefixes `Toggle ` when
`state` is set). Then R67 (a `useEffect` calling `scrollIntoView({ block: 'nearest' })` on the active
option, covering both the command list and the `@`-mode node-match list).

Review found nothing — each of the three changes was checked against its own stated risk (the
highlight-index/label mismatch R66's own plan warns about, the verb-moves-to-the-surface contract
R68 sets up) while writing it. Full account: `docs/plans/R66-palette-polish.md`'s own Results section.

---

## R65 — the keyboard shortcuts panel · built

`keybindings.ts` gained a subscribable effective-bindings store (`getKeybindings`/`setKeybindings`/
`subscribeKeybindings`, `theme.ts`'s own shape) plus `effectiveChordFor`, replacing every *display*
surface's use of `defaultChordFor` — `App.tsx`'s `useKeymap`, `uiHelpers.ts`'s `tooltipFor`,
`Palette.tsx`'s chord hint, `Grid.tsx`'s quick-filter label — so a user-overridden chord shows
correctly everywhere, not just in the effective keymap itself. New `components/Help/` (mirroring
`components/Palette/`): `Shortcuts.tsx`/`shortcutsStore.ts`/`commands.ts`/`Shortcuts.css`, opened by
`nodepad.help.shortcuts` (category `Help`, bound to `F1`) or the palette. Two sections: derived
(every palette-surfaced command with a chord, by category) and curated (`Tree.tsx`/`Grid.tsx`/
`components/Raw/rawKeymap.ts`'s own in-pane keys, hand-maintained by design, per the plan's own
§3b). It is the first new elevated surface since R60 and gets the tier's hairline (D-077).

Review found one thing worth fixing before commit, not a defect so much as a wrong call: the derived
half's first draft read `commandsForSurface('palette', context)` — the palette's own live-`when`-
filtered view — which would have made bound commands disappear from a *reference* panel exactly when
they're momentarily disabled. Switched to an unfiltered `getAllCommands()` scan (D-079), the same
"disabled, not hidden" reasoning D-055 already applies to the title bar.

Full account: `docs/plans/R65-shortcuts-help.md`'s own Results section.

---

## R61–R64 — the keyboard workflow, and making it discoverable · built

Built in plan order: R63 (the palette's title-bar button, `text-bullet-list-square` icon, discovered
via its existing `Ctrl+Shift+P` tooltip), then R61+R64 together (`components/Raw/rawKeymap.ts` — Tab
indents/dedents, Enter auto-indents, Escape arms a one-shot Tab-lets-focus-through hatch, no new
dependency), then R62 (a shared `rovingTabIndex.ts` for the breadcrumb and grid toolbar; the grid
header's Pin/sort controls dropped to `tabIndex={-1}` and became reachable via a header "row" —
`active.row === -1` — in the grid's own arrow-key handler, D-078). Detail's non-grid list mode gained
no arrow navigation, per the plan's own "lowest-value, fine to defer."

Review pass found one issue, fixed before commit: two keyboard-nav tests dispatched `ArrowUp` then
`Enter`/`p` in the same synchronous burst, so the second event read a pre-update React closure —
fixed by awaiting a render between them. Full account, including what §3's Tab-stop-count acceptance
criterion means now that it's satisfied by construction rather than re-measured: `docs/plans/R61-keyboard-workflow.md`'s own Results section.

---

## R60 — dark elevation gets a border · built

Two-part fix, in the order `docs/plans/R60-dark-elevation.md` §5 specified. First, the `--elev-2-bg`
hairline that R57 gave only `.notification` moved to the whole tier — `Find.css`,
`CommandPalette.css`, `StatisticsPanel.css`, `TabStrip.css`'s overflow menu, and both of
`Grid.css`'s dropdowns each gained `border: var(--border-width) solid var(--surface-border)`.
Then, and only then, `themes/dark.css`'s `--elev-2-bg` moved from `--gray-700` to `--gray-850` —
the lightest value that still sits below `--elev-1-bg` (`--gray-800`), so `.notification-action`'s
pills keep a real fill rather than collapsing into the panel behind them. `CONCEPT.md` §9.3 amended
to name the border as a third elevation mechanism, recorded as D-077.

Three new/changed assertions: `test/notifications.test.tsx` now expects dark's `info`-severity
hairline (no severity colour, so it's the plain `--surface-border` case) at ≥1.5:1 instead of the
old disclosed exact 1:1 — light is untouched by this round and stays at its own known 1.31:1; a new
test pins the panel-vs-pane ratio in dark below 1.2:1, confirming it now reads as a tint rather than
a separate surface; `test/elevationBorders.test.ts` (new file) reads the five other components'
source CSS directly and fails if any `--elev-2-bg` rule block doesn't also declare the
`--surface-border` hairline, so a future elevated surface added without one fails here instead of
joining a silent majority.

Review pass: none. The change is two CSS token edits plus a mechanical border addition to six
selectors already following the one working example (`.notification`); nothing turned up worth a
fix-then-recommit cycle.

---

## R77 — the docs restructure, and a single source of truth for status · built

R32 split `CLAUDE.md` by lifecycle and stopped it growing. It did not stop status being recorded
in **four** places — `CLAUDE.md`'s status table, `CLAUDE.md`'s doc map, `docs/TASKS.md`, and each
plan document's own prose header. Four updates per landing round, so one was always missed: M5
read "partly open" for months after every one of its tasks shipped, and R60 was stale one commit
after it landed.

Measured before changing anything. `CLAUDE.md` was **47% round bookkeeping** (169 of 357 lines);
`docs/TASKS.md`'s register rows ran to **3,083 characters** — a plan document inside a table
cell; and an attempt to verify status automatically returned **80% false positives**, because
"open" appears in ordinary prose. That last number is the whole argument for the marker: what
cannot be checked will drift, and this project had already corrected eleven such contradictions by
hand at R50.

**Structure.** All 53 plan and results documents moved to `docs/plans/`. `docs/` root is now five
files — `CONCEPT`, `DECISIONS`, `FINDINGS`, `LOG`, `TASKS` — plus that folder.

Three files were handled individually rather than by rule, and each for a measured reason:

- **`docs/ICONS.md` → `assets/README.md`.** The proposal was to fold it into `DECISIONS.md`.
  Reading it first showed why not: most of it is a build spec (the regeneration command, the
  `assets/*.svg` inventory, the output table, the macOS squircle caveat), and `DECISIONS.md`
  already **references it 11 times** *as the place the detail lives*. It belongs next to
  `tools/generate.py`, which is what it documents.
- **`docs/issues.md` deleted**, its nine items appended verbatim to `docs/plans/M5c-PLAN.md` —
  the plan that triaged them — because four `DECISIONS.md` entries quote it by name. Two items
  ("Document" root node, the always-`Element` column) were traced to M5c's own triage table
  before deleting, so nothing live left with the file.
- **`UI-FEEDBACK.md` moved, not deleted.** It has **33 inbound references, ~20 of them source
  comments citing it as rationale** ("A filter that is set must never be hidden…"). Deleting it
  would have left twenty dangling citations, which is worse than no comment: the claim becomes
  uncheckable. It is a plan document in everything but name — the round record for M2b–M5b — so
  it moved with the rest.

**Status.** Every plan document carries `<!-- status: … -->` on line 3
(`built` / `built-caveat` / `open` / `closed` / `superseded`). `docs/TASKS.md` gained a board
derived from those markers, and an **Owed** table listing every unmet acceptance criterion and
found-not-fixed gap — ten of them, previously scattered across eight documents with no list
anywhere. That table is the one genuinely new capability here; the rest is reorganization.

`test/docsStatus.test.ts` asserts every plan document has a marker, that the board agrees with
it, that every `built-caveat` names what it owes, and that no pre-restructure path survives.
**Verified to fail on a deliberately drifted marker** before being trusted.

Three stale headers turned up in the act of making them checkable: `M5c-PLAN.md` and
`M5d-PLAN.md` still said "Status: planned" while both were built, and `M5g-PLAN.md` still
carried a deferred item R41 had closed.

**663 path references rewritten across 192 files.** Inside `docs/` they became
`docs/plans/…`; in `src/`, `test/` and `spike/` the `docs/` prefix was **dropped entirely** —
a new rule that source comments cite a document *by name, not path*, so the next move costs
nothing outside `docs/`. `CLAUDE.md` ends at 236 lines, down from 357, and now contains no
round-by-round bookkeeping at all.

---

## M5 status correction — H2b/H2c/H2d/H11 were never open · docs only

No code changed. `CLAUDE.md` listed M5 as "partly open — H2b, H2c, H2d, H11" while
`docs/plans/M5-PLAN.md`'s own definition of done already read `[x]` for three of them and `[~]` for the
fourth, and H12 — explicitly out of M5's scope — had been built too (D-048). Verified against the
code rather than either document: `incrementalRowIndex` (H2b), `exportBuffers`'s per-column
release (H2c), `graftChunked` (H2d), the `nodepad-file://` token protocol (H11→H12); 168 tests
across the five relevant files pass.

**Why it went unnoticed for months:** `M5-PLAN.md` carried no status line at all, so R50's sweep
of eleven plan headers — which flipped headers that said "Open" — had nothing to correct here. It
has one now.

**The `[~]` criterion is closed as a units mismatch, not a shortfall.** Re-ran
`spike/m5-bench.ts h2c-worker` and reproduced 2.84× exactly. §8's budget sums *resident*
components; 2.84× is a *peak* including `exportBuffers`'s +49.5 MB transfer transient. Resident is
2.56×, at both 200 and 500 MB, and §8's "~1.25 GB at 500 MB" is exact.

Two things fell out of checking it. `CONCEPT.md` §8's table was missing the name index —
`M4-RESULTS.md` §1 measured it at 25.1 MB and published a corrected ~528 MB total that never made
it back into §8; amended now, with the line index confirmed genuinely negligible (0.03 MB, strided
at 1024) rather than assumed so. And a trap worth the entry it got in `FINDINGS.md`: this pass
first derived those component sizes by subtracting RSS readings, which undercounts by 26% because
freed parse scratch is reused rather than returned to the OS. `byteLength` reproduced M4's
independent figure to three significant figures; the subtraction did not.

`FINDINGS.md`'s "two known-open costs, both owned by `M5-PLAN.md`" entry — still quoting the
pre-fix 888 ms row-index rebuild and 4.11× open path as live problems — is replaced. That was the
item with real cost if left: FINDINGS is read before implementing anything.

---

## R57 — the notification's severity edge · built

`docs/plans/R57-notification-emphasis.md`. The full-fill amber/red background on a warning/error
notification is gone; `.notification` now keeps the same neutral `--elev-2-bg` for every severity,
with a 1px `--surface-border` hairline (necessary in light theme, where `--elev-2-bg` and the pane
behind it are the same colour) plus a 3px left edge carrying the severity colour. Measuring the
plan's own acceptance criteria rather than assuming them found two it had gotten ahead of the actual
tokens: `info`'s plain hairline (no severity colour) fails 3:1 contrast in both themes — exactly 1:1
in dark, where `--surface-border` and `--elev-2-bg` are the literal same token — and the "background
differs from the pane" criterion isn't achievable at all without a broader token change, since light
theme's `--elev-2-bg` *is* `--surface-bg`. Both disclosed and tested as known cases rather than
silently fixed or quietly dropped from the test suite.

---

## R59 — zoom as a real command · built

`docs/plans/R58-zoom.md`. Three palette commands (`nodepad.view.zoomIn`/`zoomOut`/`resetZoom`), bound to
`Ctrl+=`/`Ctrl+-`/`Ctrl+0`, persisted in `localStorage` (`settings.ts`, clamped 50–200%) and applied
through a new preload seam (`view.setZoomFactor`) since `webContents` zoom is main-process-only.
`main/index.ts`'s R58-era `did-finish-load` handler is gone, replaced by the renderer's own eager
apply on boot — exactly what R58's own plan anticipated, since keeping both would race. Checked all
three of §4's "what was measured once" traps rather than assuming: `gridColumnWidth.ts`'s width and
`Grid`/`Tree`/`Detail`'s `ROW_HEIGHT` are both hardcoded CSS-pixel constants, not live measurements —
zoom scales the whole layout together, so neither was ever actually at risk. `Raw.tsx`'s
`defaultLineHeight`, though, measured as genuinely stale after a zoom change until an explicit
`requestMeasure()` — CodeMirror doesn't remeasure it on its own on this timescale. Fixed by
subscribing `Raw.tsx` to zoom changes and nudging the mounted `EditorView` directly.

---

## R42 addendum — the one-keystroke decoration lag · built

`docs/plans/R42-stale-spans.md`. Two fixes, both necessary (confirmed by reverting each in isolation):
`Raw.tsx`'s `useLayoutEffect` now dispatches `bumpDecorationsEffect` a second time whenever
`document.pendingSpanDeltas` actually changed since the last dispatch — closing the ref-timing gap
the addendum's own plan diagnosed. But that alone didn't fix the addendum's actual reported symptom
(typing inside a tag name): `decorations.ts`'s tag-name `nameEnd` was derived from an already-
translated `nameStart` plus the *interned* name's stale byte length, never itself passed through
`shiftedOffset` — wrong for an in-name edit regardless of timing. Now both ends of the name's span
are computed in original coordinates and translated together. New browser-project test
(`test/rawDecorationTiming.test.tsx`) pins both down.

---

## R53 — `Interner.lookup` encodes queries in the document's own encoding · built

`docs/plans/R53-interner-encoding.md`. `lookup` hashed every query as UTF-8 regardless of the document's
own encoding, so a non-ASCII element name in, say, a windows-1252 document silently resolved as
absent — the only silently-wrong entry on `docs/FINDINGS.md`'s known-wrong list. `src/core/textEncode.ts`
(new) is the inverse of `TextDecoder`: UTF-8 and UTF-16LE/BE natively, every other declared encoding
via probing `TextDecoder` across all 256 bytes and inverting the map — no new dependency (D-074).
`lookup` gained a third return state, `'unrepresentable'`, distinct from `null`, threaded one layer
out through `NameResolver`/`parsePath` as a real diagnostic instead of a silently-empty result.
Found and reported rather than fixed here: the query grammar itself (`NAME_CHAR`) is ASCII-only, so
the Palette can't yet type the query that would exercise this fix — a separate, adjacent gap, now in
`docs/FINDINGS.md`.

---

## R52 — the file watcher is per-tab now · built

`docs/plans/R51-main-process.md`. `document:watch` used to replace one module-level watcher app-wide;
opening two files in two tabs meant only the most recently opened one's external-change notification
ever fired. `src/core/documentWatchers.ts` (new, no Electron import) keys watch registrations by the
renderer's own tab identity while keeping exactly one real OS watcher per unique path underneath,
refcounted — two tabs on the same file share a watcher rather than duplicating it. The IPC contract
(`document:watch`/`unwatch`/`onExternalChange`) now carries that key through, and
`documentSession.ts`'s `dispose()` gained a call it never needed before: under the old shared
watcher a closed tab's registration was harmless to leave; under per-key registration, skipping it
would leak forever. 10 new unit tests against fake `stat`/`watch`; three existing
`documentSession.test.ts` tests updated to thread a fixed key through.

---

## R51, R58 — main-process tests, and the built app's zoom · built

`docs/plans/R51-main-process.md`, `docs/plans/R58-zoom.md`. `src/main`/`src/preload` (666 lines) had no test of
their own; extracted the testable logic into three new plain modules —
`src/core/mainDocumentIO.ts` (stat/write), `src/core/readTokenProtocol.ts` (the `nodepad-file://`
handler), `src/core/mainQuitFlow.ts` (R26's `close`-interception guard, not in the original plan —
added after Playwright's `_electron` turned out unable to test that behaviour at all: a
`BrowserWindow.close()` under its automation tears the window down regardless of
`event.preventDefault()`, confirmed against a standalone non-Playwright script running the identical
logic). 15 new unit tests against those modules, plus `test/mainElectron.test.ts` for the two things
only a real Electron process can show (the preload bridge's exact exposed surface, and R58's zoom
acceptance). R58 itself: `createWindow` now sets zoom level 0 on first `did-finish-load`, closing the
built app's unexplained 1.25-vs-1.0 startup gap — the cause is still not identified, and the fix
doesn't need it to be.

---

## R56 — two R47 findings were recorded where nobody would look for them · built

Last of the R54–R56 batch (`docs/plans/R54-signal-followups.md`) — all three now built, including this
document's own header. R48's addendum did the right investigative work and recorded it in the right
*document* (`docs/plans/R47-repo-hygiene.md`), but not where the working agreement says a trap that bites
someone working on something unrelated belongs: `docs/FINDINGS.md`. One line added to each of two
sections there — `test:large`'s worker-RPC-timeout failure under "Known-wrong, not yet fixed," the
`grep -c $'\r'` false-zero trap (this environment's shell lies about byte-level content; verify with
`node -e` instead) under "Environment and tooling" — each pointing back at R47's results for the
full account rather than duplicating it. Nothing pruned to make room; two one-line additions don't
cross `FINDINGS.md`'s own "roughly the length it is now" budget.

---

## R54 — the lint gate couldn't fail on a warning, so R47's problem could recur · built

From reviewing R47–R50 (`docs/plans/R54-signal-followups.md`, D-072). `npm run lint` had no
`--max-warnings`, and `prettier/prettier` comes in as `warn`, so it exited 0 at any warning count —
green at 37 warnings, and it would have been green at 370. The same failure mode R47 existed to fix:
a signal accumulates noise until nobody reads it. R47 removed the noise; it never closed the
mechanism that let it accumulate.

Landed after R55 on purpose (R55's own fix is what step 1 here would otherwise have triggered).
Cleared the 34 fixable Prettier warnings (`eslint --fix .`, 15 files, all pure reformatting —
diff-reviewed, not just trusted); confirmed the remaining 3 are all `react-hooks/incompatible-
library` on `useVirtualizer` in `Detail.tsx`/`Grid.tsx`/`Tree.tsx`, nothing to fix in this codebase;
added `--max-warnings 3` to the `lint` script, with the reasoning recorded in `eslint.config.mjs`
next to where the ratchet is exercised. Verified both directions: exits 0 at 3, exits 1 (with
ESLint's own "too many warnings" message) at a temporary 4th.

---

## R55 — `npm run format` would have rewritten 51 documentation files · built

From reviewing R47–R50 (`docs/plans/R54-signal-followups.md`). Landed before R54 on purpose — R54's own
first step is "clear the fixable Prettier warnings," which is exactly the situation where someone
reaches for `npm run format`, and until this round that command rewrote every markdown document in
the repository (Prettier normalizing `*emphasis*` to `_emphasis_`, reflowing hand-wrapped prose) for
zero benefit. `.prettierignore` gained one `*.md` entry, with the reasoning — this repo's docs are
deliberately hand-structured, not auto-wrapped, and Prettier's markdown style is a different house
style, not a more correct one — stated inline so reversing it later is a decision, not a discovery.
Verified: `npx prettier --list-different .` went from 67 files (52 `.md` + 15 code) to exactly the
15 code files. `npm run lint` unaffected — checked, not assumed: ESLint's own config never matched
`.md` files at all, so markdown was never part of its surface either way.

---

## R50 — eleven plan documents still said "Open" for work that shipped · built

Last of the repo-hygiene batch (`docs/plans/R47-repo-hygiene.md`) — R47–R50 now all built, including this
document's own header. Two structural leaks, not carelessness: the working agreement said to put a
landed round's story in `docs/LOG.md` and give it a status-table row, but never said to flip the
plan document's own header, so nobody had — eleven documents (R21, R24, R31, R33, R34, R35, R38,
R39, R41, R42, R43) still opened `**Open.**` under their own finished Results sections. Fixed, and
the missing clause added to the working agreement so it doesn't recur. The two genuinely-partial
ones (R24's per-tab view state, R43–R46's unmet R46 acceptance criterion) say so in their own
headers rather than flattening to "built."

Separately, `docs/plans/UI-FEEDBACK.md`'s doc-map row — still in the Active-work tier, unreferenced by any
round since R33 — moved to Historical. Not deleted (29 files still reference it). Checked its three
non-`done` entries before retiring the row: all read as superseded by since-built features
(`Icon.tsx`, the `paneHeader` command surface), not live feedback, so nothing needed folding into
`docs/FINDINGS.md`.

---

## R49 — no CI, no hooks · built

Third of the repo-hygiene batch (`docs/plans/R47-repo-hygiene.md`). `.github/workflows/ci.yml`: checkout,
Node 22, `npm ci`, typecheck, lint, `playwright install --with-deps chromium`, `npm test` (both
projects, R48a) — on push to `main` and every pull request. R47 was the prerequisite: adding CI while
lint exited non-zero would have meant a red badge from day one. No git hooks, per the plan's own
recommendation to skip them for now (a pre-commit hook slow enough to matter gets bypassed with
`--no-verify`; a fast one duplicates CI). Fixture generation deliberately excluded from the workflow
— `spike/fixtures/` (~1 GB) is gitignored and local-only, and `invariants.test.ts` already skips
gracefully when it's absent, so CI runs everything else rather than spending minutes regenerating a
gigabyte fixture set no other test needs. Not verified against a live GitHub Actions run — this
environment has no configured remote — every command the workflow runs was otherwise run directly
here and passed.

---

## R48 — `npm test` skipped the browser project, and one of its own tests was order-dependent · built

Second of the repo-hygiene batch (`docs/plans/R47-repo-hygiene.md`). `npm test` ran only the node project
(1122 tests); the browser project (94 tests, essentially all of the last ten rounds' real-layout
coverage — R33's contrast, R34's wide-grid guards, R41's caret survival, R44's scrollbar geometry,
R46's coalescing) never ran under the command anyone actually types. Now `vitest run` with no
project filter, covering both; the old behavior survives as `npm run test:node`.

`tabStrip.test.tsx`'s "clicking the right chevron" test failed standalone but passed in the full
suite — traced to a real cause, not the one first suspected: the container width *was* already
pinned, but `TabStrip.tsx`'s `ResizeObserver`-backed overflow effect hadn't flushed by assertion
time on a cold browser instance, which a fixed two-`requestAnimationFrame` wait doesn't reliably
outlast. Fixed with a bounded poll for the actual condition (matching R35's own `scrollend`-wait
shape in the same file), plus `expect(...).toHaveLength(...)` before every `!`-asserted
`querySelectorAll` destructure in the file.

`invariants.test.ts`'s truncation-fuzz test (a *full* parse per sampled offset, unlike the other two
fuzz tests) now samples 20 offsets by default and the full 200 under `test:large`, reading the same
`NODEPAD_TEST_LARGE` flag the fixture-size filter already used. `npm run test:node`: ~85–99s → ~26–28s.
`npm test` (both projects, previously not runnable together): ~33–35s for 1216 tests.

---

## R47 — the lint signal was buried, hiding four real errors · built

Prompted by a pre-publication audit (`docs/plans/R47-repo-hygiene.md`). `core.autocrlf=true` with no
`.gitattributes` meant every checked-out text file was CRLF, and Prettier is LF-configured — 5,363
of 5,366 warnings were `Delete ␍`, and `npm run lint` had exited non-zero for long enough that
several results documents record "lint clean — CRLF warnings only" as the accepted baseline. That
sentence is how the four real `@typescript-eslint/explicit-function-return-type` errors survived
under it.

`.gitattributes` (`* text=auto eol=lf`, plus explicit `binary` for `.ico`/`.icns`/`.png`) landed as
its own commit, as the plan requires. The expected follow-up — `git add --renormalize .`, staging a
sweep across every text file — turned out to have nothing to stage: the repository's blobs were
already LF (`core.autocrlf` only affects checkout), so the only thing actually wrong was the working
tree, and neither `--renormalize` nor `checkout-index -f -a` would rewrite it (both compare through
the same clean filter the fix itself specifies, so a working tree that already reads as "normalized"
under that filter is left alone). Deleting every tracked file and `git checkout HEAD -- .` was what
actually worked, having no filtered comparison to short-circuit. `npm run lint`: **5,370 → 37
problems, 4 → 0 errors, exit 0.**

---

## R46 — the thumb-drag frame cost · built, acceptance criterion not met

Last of the sizing/scrollbar batch. Full writeup and results: `docs/plans/R43-grid-sizing-and-scroll.md`.

The plan's own acceptance was a number — p90 frame time during a thumb drag, compared against a
measured 33 ms — and that number could not be produced here: no display, no real Electron window,
headless Chromium has no compositor/vsync to measure against. Built the plan's own lead anyway
(`Scrollbar.tsx`'s `MutationObserver`-driven forced layout, now coalesced to at most one read per
`requestAnimationFrame` instead of one per `scroll`/resize/mutation event), verified what *is*
measurable headless — forced-layout read count during a simulated multi-source drag, 13 → ≤6 across
six frames (`test/scrollbarCoalescing.test.tsx`, spying the `scrollHeight` getter directly since
React's own render batching would hide the difference) — and flagged, not silently substituted, that
this confirms the mechanism without confirming it was the dominant cost of the original number. A
real Electron measurement is still owed.

---

## R45 — the wheel did nothing over a horizontal scrollbar track · built

Third of the sizing/scrollbar batch. Full writeup and results: `docs/plans/R43-grid-sizing-and-scroll.md`.

`Scrollbar.tsx`'s horizontal `onWheel` read `event.deltaX` alone, which an ordinary mouse wheel
never reports (only trackpads/tilt wheels do) — so it did nothing. Fixed with the same
deltaX-falls-back-to-deltaY idiom `TabStrip.tsx`'s own `onWheel` already used (R36 §3c), now
factored into a shared `horizontalWheelDelta` (`src/renderer/wheelDelta.ts`) both call, rather than
carrying a second hand-copied line of it.

---

## R44 — the horizontal scrollbar overlapped content at both edges · built

Second of the sizing/scrollbar batch. Full writeup and results: `docs/plans/R43-grid-sizing-and-scroll.md`.

Two separate overlaps, both fixed. The track ran underneath the sticky row header and pinned
columns (`left: 0; right: 0` spanned the whole viewport, and sticky content's `z-index` painted over
it) — `Scrollbar` gained a `horizontalInset` prop, a stated inset rather than a Grid-specific
stylesheet override, and the Grid passes its existing `bodyLeft` straight through; the thumb-drag and
track-click math needed no changes since both already read the track's own measured rect. The track
also covered the last row (`.grid-scroll` reserved a right gutter for the vertical track but none at
the bottom) — fixed with a conditional `margin-bottom`, gated on the Grid's own overflow check so a
narrow table that never scrolls horizontally doesn't lose the space for nothing.

---

## R43 — the grid's column widths and container height stop being fixed constants · built

The first half of the sizing/scrollbar batch (R43–R46). Full writeup and results:
`docs/plans/R43-grid-sizing-and-scroll.md`, decision: D-071.

`CELL_WIDTH = 160` for every column, regardless of content, is gone — `gridColumnWidth.ts`'s
`sampleColumnStats` derives a per-column default from a bounded sample, reusing `isNumericColumn`'s
own scan rather than a second pass, though with its own independent (much smaller) sample size for
width, found necessary after an initial version that shared `isNumericColumn`'s 200-value sample
reproduced M2's "more than half the grid's time to first paint" cost on every non-numeric column —
caught by `test/tabSwitchMeasurement.test.tsx`'s R30 benchmark going from 63 ms to 6.8 s. Column
resize (drag the header edge, double-click to reset) landed alongside it, using the same
`window`-level pointer-listener pattern `Scrollbar.tsx`'s thumb drag already established, and forcing
`@tanstack/virtual-core`'s own measurement cache to actually pick up a resize via its `.measure()`
escape hatch.

`.detail-grid-container`'s fixed `height: 480px` is now `flex: 1` with a `min-height` floor, removing
the two-nested-scrollbars problem on a short pane. This also reproduced the exact hazard the plan's
own text predicted: a `flex: 1` height against an *indefinite* ancestor falls back to content-sized,
so a virtualizer under it renders unbounded instead of a viewport — hit for real in
`test/tabSwitchMeasurement.test.tsx`, whose `DetailContent` render never previously needed an explicit
ancestor height because the old fixed pixel height didn't care. Fixed at the test (an explicit-height
wrapper, matching what the same file already gives Raw); the real app's `Layout.tsx` always gives
Detail a genuine flexed height, so this never reaches production.

---

## R42 — every view read stale spans in the window between an edit and its reparse · built

The other half of what typing in Raw looks like, and the one with weight — it reversed a standing
"flagged, not fixed" decision (`applyEdit`'s own doc comment, since F3) whose stated premise
("has not been reported as a visible problem in practice") had failed. Full writeup and results:
`docs/plans/R42-stale-spans.md`, decision: D-070.

Plumbing, not new machinery: `core/deltaList.ts`'s `shiftedOffset` already existed and was already
tested, just never wired into a UI read path. Landed at one seam — `session/spanTranslation.ts`'s
`translateSpan` — rather than at every `spanOf`/`ownValueOf` call site, with a new
`OpenDocument.pendingSpanDeltas` field `applyEdit` accumulates into and every successful reparse
commit (including `reloadAndDiscard`'s own, and `applyUndoEntry`'s — found in review, not planned)
resets to empty. Every read path that decodes a `NodeStore` span into display text now translates
through it first: Tree/Detail previews (`nodeDisplay.ts`'s `previewOf`), Detail's Value/facets/
children list (`detailModel.ts`), the Grid's whole cell chain (`gridCell.ts`), and Raw's syntax/
selection decorations (`Raw/decorations.ts`, `rawDecorations.ts`).

Scoped deliberately narrower than "every UI read path" sounds: only node spans, never the row or
line index, since `deltaList.ts`'s own `fold` can't add or remove entries for a row-count-changing
edit and nothing this round fixed reads either index. A replacement (paste, type-over-selection)
still degrades to briefly stale rather than resolving exactly — `shiftedOffset`'s own documented
limit, accepted rather than solved. New regression coverage in
`test/documentSession.test.ts`'s `pendingSpanDeltas (R42/D-070)` suite reproduces the original
report's own measured symptoms synchronously, inside the debounce window, rather than against one
arbitrary sampled instant.

---

## R41 — typing in Raw loses the caret · built

The largest of the R38–R41 batch, and the one with a fully specified fix shape going in
(`M5g-PLAN.md`'s deferred O4 Raw half). Two distinct symptoms, ~280ms apart in the original
measurement, needing two separate fixes:

**Symptom A — the `EditorView` was destroyed and rebuilt on every reparse.** `Raw.tsx`'s mount
effect was keyed on `store` identity, and a reparse — including the debounced one every keystroke
schedules — always produces a new `NodeStore`. Fixed by re-keying the mount effect on the active
tab's own identity (`getActiveTabId()`, falling back to `filePath` for the no-tab-registered
case) instead, so only switching to a genuinely different document remounts. A second effect,
keyed on `[store, sourceBuffer, rowIndex, lineIndex]`, handles what a same-document reparse still
needs: refreshing the window's `text`/`map` bookkeeping (stale since only `applyReslice` used to
update them, and a plain edit never re-slices) and forcing a decoration rebuild via a new
`bumpDecorationsEffect` (`rawDecorations.ts`) — needed because re-dispatching the same
`selectedNode` value doesn't itself register as a state change CodeMirror's `update()` would
otherwise notice.

Four extension-constructing functions (`rawDecorationsExtension`, `rawCaretSyncExtension`,
`rawLineNumbersExtension`, `rawEditExtension`) were converted from closed-over
`store`/`sourceBuffer`/`rowIndex`/`lineIndex`/`encoding` values to live getters reading through
refs kept current by a `useLayoutEffect` (a plain render-body assignment trips this project's own
`react-hooks/refs` lint rule) — the same pattern `getWindow: () => RawWindowSnapshot` already used.
Several closures *inside* the mount effect itself (`handleScrollFrame`, `scrubTo`, `publishViewport`)
turned out to have the identical staleness problem one level down, since the effect that creates
them is no longer re-run per reparse either — caught only by tracing every remaining plain
`sourceBuffer`/`rowIndex` reference through the file after the initial pass looked complete.

**Symptom B — the pane scrolled away while the edit was still landing.** Traced (not just inferred)
to `Raw.tsx`'s own `caretOffset` effect: `rawEditExtension` calls `session.setCaretOffset` after
every edit, which the effect couldn't distinguish from an external "Locate in source" jump — so
it called `jumpTo` (selection + `scrollIntoView`) on every keystroke. Fixed via a new
`onCaretMoved` callback on `rawEditExtension`, invoked before `session.setCaretOffset`, that marks
the offset as already-applied so the subsequent re-render's effect recognizes it and skips the jump.

Symptom C (a reported transient `>` glyph) was not reproduced, as the plan anticipated, and needed
no code change.

Verified in real Chromium against a real (fake-parse-backed) `DocumentSession`, dispatching
`changes` transactions directly on the `EditorView` recovered via `EditorView.findFromDOM` — the
same mechanism a real keystroke produces internally, exercising `rawEditExtension`'s update
listener exactly as typing would. `.cm-content` identity survives a reparse, focus/selection/
scrollTop are all unperturbed, and a third keystroke appends where the first two landed. Every
pre-existing Raw suite (D10, J1–J3, R8) passed unmodified — no test needed changing, which is the
signal the conversion changed plumbing rather than behaviour.

---

## R38–R40 — three small corrections from using the app · built

**R38 — the tab strip's icons and scroll feel.** The `‹`/`›`/`⌄`/`+` overflow/new-tab buttons were
Unicode text glyphs, the only ones left in the chrome — swapped for Fluent icons
(`chevron_left/right/down_20_regular`, `add_20_regular`) through the existing `icons.ts` map.
Both scroll paths (`scrollBy` for the chevrons, `scrollIntoView` for R35's activation-follows)
gained `behavior: 'smooth'`, gated on `prefers-reduced-motion` via a small `scrollBehavior()`
helper. Also fixed, found reading the code rather than reported: `readOverflowState` returned a
fresh object every `scroll` event, so the whole strip re-rendered on every scroll frame —
`setOverflow`'s updater now returns the *previous* state when the three booleans are unchanged,
which smooth scrolling would otherwise have made ~30× worse.

**R39 — grid export collapsed a presence marker into the same blank as `Absent`.** A tick-mark
column (`<sunroof/>`, no value, no children) exported as nothing, indistinguishable from the field
not existing on that row at all — D-068. Fixed in two layers: per-cell, a marker now exports a
token (`true` for CSV/TSV, `✓` for Markdown) instead of blank; per-column, `gridExport.ts` now
classifies exactly (not sampled, unlike `isNumericColumn` — export already walks every row it
emits) whether every *present* cell in a column is a marker, and if so exports `Absent` as `false`
rather than blank. Built as one pass — `decodeExportRow` calls `rowFields` (R34's own
O(rowFanOut) primitive) once per row rather than `cellOf` once per (row, column), avoiding the
doubled store access a naive "classify then serialize" split would have cost.

**R40 — the row-number column was taller than the cells beside it.** `.grid-row`'s virtualized body
cells are `position: absolute; top: 0` with no explicit height, so they shrink to their own content
(18.4px, or 20px for an italic derived cell) while the sticky row-header and pinned cells — still
in flex flow — stretch to the row's real 23px (`ROW_HEIGHT`). The header row and filter row's own
virtualized cells already had `height: '100%'` for this exact reason; the body cell (`Grid.tsx`)
was the one place missing it.

---

## R33 addendum — four scrollbar follow-ups from using the app · three fixed, one open

Reported from a screenshot of `cars-10mb.xml`'s Detail pane after R33 shipped. Folded into
`docs/plans/R33-scrollbars-and-selection.md` rather than allocated a new `R` id.

Three real bugs, all in the overlay-scrollbar work R33/D-051 landed: (1) the track had no reserved
gutter in Detail/Tree/Grid (only Raw's `.raw` had `margin-right: var(--scrubber-width)`), so the
track sat on top of the breadcrumb's copy-path button and the grid's rightmost column instead of
beside them — fixed by giving each pane the same reservation, in its own idiom (`padding-right` for
Detail/its children-list, since their content is positioned against the padding edge;
`margin-right` for Tree/Grid, matching Raw exactly). (2) The Raw scrubber's track used an elevation
*surface* token (`--elev-1-bg`) instead of the real control token every other pane's track already
used (`--scrollbar-track-bg`) — invisible in dark mode because the two tokens happen to coincide
there, visible in light mode because they don't — fixed by the same token swap 1b already used for
the thumb.

The fourth is real but unresolved: the scrubber thumb's rounded corners vanish when it sits at
`top: 0`. Chased with a scratch Playwright/Electron script (screenshots plus `elementsFromPoint`,
not guesswork) to a fractional-device-pixel rendering artifact that reproduces on a completely
unrelated fixed-position div at the same Y and does *not* reproduce away from a pane boundary —
not a `Scrubber.css` authoring bug. Two fixes tried and ruled out (`translateZ(0)`, a few-pixel
inset). Left open; recorded in `docs/FINDINGS.md`'s "Known-wrong, not yet fixed."

---

## R31 — the CSV quoted-newline spike · built

Timeboxed spike (`docs/plans/R31-csv-spike.md`), not a milestone: one question — a quoted CSV field can
contain a raw newline, so record boundaries and the row index disagree, and `subtreeSplice.ts`'s
`resumeContextFor` walks an ancestor chain that "am I inside a quoted field" isn't a property of.

**Answer: the problem is architecturally free.** Built a spike-only `FormatModule`
(`spike/csv-quoted-newline/csvSpikeParser.ts`, `Document -> Row -> Field`) and a seeded corpus
generator, then ran 1,757 edits — targeted at quote boundaries, embedded newlines, and commas inside
quoted fields, plus a broad sweep — through the real `spliceSubtree` production path and compared
every result against a fresh full parse. Zero mismatches. The existing generic
`bytesConsumed !== newSpanEnd` safety net in `decideSplice` (already there for every format, not
added for this spike) turns every case where stale resume state *would* matter into a safe fallback
to full reparse, never silent corruption.

Also measured, not just argued: Option 1 (a cheap local backward scan to a safe resume point) was
rejected on two grounds. Its first draft was outright **unsound**, not just slow — it judged safety
by quotes crossed only during the scan itself, so it reported a false-safe point after one byte when
the resume point started inside a quoted field. The corrected version needs an O(document-position)
forward pre-scan to bootstrap real parity, measured at 1.1M bytes touched on a 1MB adversarial
fixture — the same order as a full reparse, not a bounded local scan. Option 2 (a record index) was
priced (0.76MB / 9.2% on a 200k-record fixture) but is unnecessary now that Option 4 holds.

Recommendation for CSV proper: the parser/incremental-reparse layer is de-risked and can reuse the
existing pipeline unchanged. The real remaining cost is everything the spike's own §4 already named
and none of it touches what this spike checked — dialect sniffing, header-row detection, what the
Tree view shows for an all-records format, the spreadsheet-expectations mismatch, and wide-table grid
rendering. A UI/UX-sized milestone, not a parser-risk one.

---

## R26 addendum — the consolidated quit flow · built

`docs/plans/R24-tabs.md`'s own addendum, appended after R30 once the project lead settled the design
question R26 had left open: Notepad++'s shape (one dirty tab asked about at a time, plus a
"Discard All" bulk action) rather than a single list-view modal. Only the UI shape changed from
the plan's original idea — the main-process/IPC work R26's own results section already scoped out
as separate is exactly what got built.

`main/index.ts` now intercepts the window's `close` event (`WeakSet<BrowserWindow>` tracks which
window's quit is actually confirmed, so a second window never inherits the first one's answer) and
holds it open until the renderer answers over a new `app` IPC namespace (`preload/api.ts`).
`session/tabs.ts` gained the flow itself (`startQuitFlow`/`advanceQuitQueue`/`discardAllAndQuit`/
`cancelQuitFlow`), reusing the existing per-tab dirty-close notification rather than a new
component; `session/quitFlow.ts` is the small orchestrator wiring the two together, mirroring
`sessionRestore.ts`'s own split between session logic and IPC glue.

**Two real bugs, both caught in review before committing, not by manual use.** A manual close
click on a *different* dirty tab while a quit-flow prompt was up would silently steal
`pendingCloseTabId`, orphaning the tab the flow was actually waiting on — the flow would then
finish and the app would quit with that tab's edits genuinely lost, the exact failure this whole
mechanism exists to prevent. Fixed by splitting the guarded, external-facing `requestCloseTab` from
an internal `promptOrSkip` the flow drives itself with. That fix's own first draft then broke the
flow's *own* first prompt (the guard tripped on `quitQueue` already being a non-null array before
the first tab was ever prompted) — caught immediately by the existing test suite going red across
the board.

Full suite green (99 files, 1167 tests, up from 96/1149). A scratch (uncommitted) Playwright script
confirmed the real packaged app actually closes after the quit flow resolves with nothing dirty —
the full `close` → IPC → `confirmQuit` → real close round trip, not just its pieces.

---

## R30 — the measurement pass · built (no production code changed)

`docs/plans/R24-tabs.md`'s own Results section for R30.

Numbers, per §8's own framing — nothing in `src/` changed. **Tab-switch remount** between two real
~2 MB/30k-node documents: ~60–75ms wall time, ~29ms of it React's own profiled render (almost all
`DetailContent`'s virtualized-list layout), the rest Raw's `EditorView` teardown/rebuild
(`M5g-RESULTS.md`'s deferred O4, confirmed still the dominant non-React cost). **Worker pool
queueing**: six concurrent parses against the 3-worker pool show two clear timing bands in
isolation (~104–125ms vs ~121–129ms), confirming the queue queues. **Context-key resolution per
switch**: ~0.0024ms — effectively free. **Peak RSS with three/six tabs**: not produced as real
process RSS — `performance.memory` (the only heap figure reachable from the browser project) is
too coarse to show a delta; real numbers need main-process `app.getAppMetrics()` instrumentation,
left for later.

**The measurement infrastructure itself hit a real defect first**: the first attempt hung for
three minutes and crashed Chromium with an OOM — not a tab-switch finding, but R19's own
`devPerformanceTracks` gap, reproduced because this new test file doesn't go through `main.tsx`
and its ~30,000-node document was large enough to make the undisabled walk catastrophic (every
prior render-cost test used a ~45-byte fixture, too small to ever hit it). Fixed by importing
`devPerformanceTracks` first in the new test, and by pretty-printing the synthetic fixture (a
minified single 2 MB line is a separate, real CodeMirror pathology). Added to `docs/FINDINGS.md`
for the next test that profiles a real-sized document. A third issue — a worker-pool timing
assertion that inverted once under full-suite load — was loosened to assert the structural
invariant (pool size holds) rather than a noisy comparative timing.

---

## R29 — session restore · built

`docs/plans/R24-tabs.md`'s own Results section for R29.

`session/sessionRestore.ts` is new: `persistSessionState()` captures every ready tab's own
`filePath` (never content) plus the active index to `localStorage`; `beginSessionRestore()` reads
it back, creates a tab per path (synchronously — `main.tsx` calls this *before*
`createRoot(...).render(...)`, since any React render would already have lazily minted an empty
tab by the time an effect could run), opens each independently, and pushes one application-scoped
notification if any failed rather than one per tab. Persistence keeps running afterward, subscribed
to both the tab set and every individual session, so a fresh app starts recording from its first
tab.

A real bug caught in review: the first version leaked a `subscribeTabs` listener on every restore
(never unsubscribed, and `resetTabsForTests` doesn't clear that set) — fixed before committing by
capturing and tearing down the handle.

Per-tab view state (scroll, layout) is explicitly not restored — disclosed, not silently dropped;
nothing durable currently holds it to restore from.

Full suite green (96 files, 1149 tests, up from 95/1143); `npm run typecheck`/`npm run lint` clean;
a real Electron screenshot confirms the app still boots cleanly with nothing persisted.

---

## R28 — the cross-tab memory budget · built

`docs/plans/R24-tabs.md`'s own Results section for R28.

`settings.ts` gained a persisted, configurable total-memory-budget setting (4 GiB default).
`session/tabs.ts`'s new `getCrossTabMemoryBytes(excludeId?)` sums `computeMemoryBudget(...)
.totalBytes` across every *ready* tab. `documentSession.ts`'s `openPath` runs a second confirm
check, after the existing per-file `SOFT_CAP_BYTES` one: a file under its own cap can still push
the cross-tab total over budget, and now confirms instead of silently degrading — the
`confirmSize` phase gained `reason: 'size' | 'budget'` to say which. `createTab` injects the real
cross-tab estimator so a session never has to know about `tabs.ts` directly. The statistics
panel gained the "All tabs (N)" row D-060 already promised, shown only once a second tab exists.

Full suite green (95 files, 1143 tests, up from 94/1132); `npm run typecheck`/`npm run lint`/
`npx stylelint` clean; `npm run build` confirms the production bundle still builds. No settings UI
for the numeric budget yet — the codebase has no numeric-setting UI pattern to reuse, and building
one for a single number wasn't judged worth it here; the setting itself is real and tested.

---

## R27 — the shared worker pool · built

`docs/plans/R24-tabs.md`'s own Results section for R27.

`core/workerPool.ts` is new: `POOL_SIZE = 3` long-lived workers (spawned lazily, on first
`acquireWorker()`, not at module load), a FIFO queue for callers when all three are busy,
`releaseWorker()` for a clean finish and `replaceWorker()` (terminate + respawn into the same pool
slot) for cancellation or a crash. `parseInWorker`/`parseFromUrlInWorker`
(`core/parseClient.ts`) and `transformInWorker` (`core/transformClient.ts`) all moved from
spawn-then-terminate-per-call onto the pool — a resource-lifecycle change, not a protocol change;
each function's own `claimed`/`settled` dedup logic is unchanged.

**This also produced the first real test coverage of the worker-client path itself** —
previously exactly one test existed (`test/parseClient.test.ts`'s already-aborted-signal check,
which deliberately never constructs a `Worker`), and everything else drove `runParseJob` directly.
`test/workerPool.test.tsx` is new — real Chromium, real `Worker`s: a single parse, seven concurrent
parses against the 3-worker pool all resolving (proving the queue runs queued jobs, not drops
them), a mid-parse cancellation that self-heals the pool for the next caller, and a transform
through the same pool.

Full suite green (94 files, 1132 tests, up from 93/1128); `npm run typecheck`/`npm run lint` clean;
`npm run build` confirms the production bundle still builds.

---

## R26 — tab lifecycle: dirty-close prompts, keyboard switching, open-into-new-tab · mostly built

`docs/plans/R24-tabs.md`'s own Results section for R26.

`session/tabs.ts`'s `requestCloseTab`/`cancelCloseTab`/`discardAndCloseTab`/`saveAndCloseTab`
implement §11.4's "closing a dirty tab prompts Save/Discard/Cancel" as a *derived* choice
notification (R21-notifications.md §3a — a new `hasPendingCloseTab` context key, not a pushed
one-shot dialog), resolved by three new commands in `components/TabStrip/commands.ts`.
`nodepad.document.open` and `Layout.tsx`'s drag-drop now both open into a **new** tab via
`tabs.ts`'s `openNewTab`/`openPathInNewTab` — they used to replace the active tab's document,
R24's own "no tabs in M1" — which made R25's separate `nodepad.tabs.new` command redundant; removed.
Keyboard switching (`Ctrl+Tab`/`Ctrl+Shift+Tab`) and closing (`Ctrl+W`) round out "switch with
keyboard and pointer."

**A real bug, caught in review**: the pending-close notification was originally pushed *first* in
`derivedNotifications.ts`, reasoning it should be "most prominent" — backwards, since
`Notifications.tsx` keeps the *last* three under its visible cap, so first-pushed is first-dropped.
Moved to last, matching the module's own existing rule.

**The consolidated quit-time list is explicitly not built** — real, separable main-process/IPC/modal
work the plan itself flags as the round's one genuinely risky piece, and building it shallow and
unverifiable (no display, no way to drive a multi-step quit confirmation the way the Electron
screenshot script drives a static render) was judged worse than reporting it. Disclosed in
`docs/plans/R24-tabs.md`'s own Results section, not silently dropped.

Full suite green (93 files, 1128 tests, up from 92/1116); `npm run typecheck`, `npm run lint`,
`npx stylelint` all clean. Re-verified visually with a fresh real-Electron screenshot.

---

## R25 — the tab strip · built

`docs/plans/R24-tabs.md`'s own Results section (appended, not a separate document — same convention R24
used).

`components/TabStrip/` is new: `TabStrip.tsx` renders one `[role="tab"]` per `session/tabs.ts`
entry plus a "+" (`nodepad.tabs.new`, `commands.ts`), `tabDisplay.ts` is the pure logic (format
glyph per `capabilities.id`, same-name disambiguation by parent directory, phase-agnostic display
info). Mounted between `TitleBar` and `Layout` in the row R4 already reserved. The active tab's
marker reuses the brand mark's `--mark-fg`, not `--accent`, per §11.4's own wording; format icons
reuse existing syntax-hue tokens rather than a new palette.

Building the strip — the first real UI consumer of `session/tabs.ts` — found a real bug in that
module: `getTabIds()` built a fresh array every call, which broke `useSyncExternalStore`'s
stability contract and produced an immediate infinite-render loop, caught by a real-Chromium
component test rather than reasoned about. Fixed with a cached array, recomputed only where the
tab set actually changes. A second, narrower staleness gap (same-name labels not reacting to a
background tab's own document changing) was fixed in the same pass.

Dirty-close prompts, keyboard switching, "open into a new tab," and the consolidated quit list stay
R26, deliberately not attempted here. Verified with a real Playwright-driven screenshot of the
packaged app (`docs/screenshots/title-bar.png`) in addition to the test suite (92 files, 1116
tests, up from 1106); `npm run typecheck`, `npm run lint`, and `npx stylelint` all clean.

---

## R33 — scrollbars, and the selection that disagrees with the display · built

`docs/plans/R33-scrollbars-and-selection.md`, D-051 addendum, D-065.

**Scrollbars (D-051 fully carried out).** Detail's outer pane gained the `Scrollbar` component it
was missing — wrapped in `.detail-viewport`, the same positioning-context pattern `.tree-viewport`
already used — with `overscroll-behavior: contain` on the nested children list so wheeling past its
edge no longer chains the scroll to the pane around it. The thumb and track moved off elevation
tokens (`--elev-2-bg`, near-white in light mode) onto real control tokens
(`--scrollbar-track-bg`/`-thumb-bg`/`-hover-bg`/`-active-bg`) with a stated >= 3:1 thumb-vs-track
contrast minimum, checked in both themes by a new browser-project test
(`test/scrollbarContrast.test.tsx`) rather than eyeballed. Scrubber.css adopted the same tokens.
The track went from `transparent` to visible, per the project lead's call.

**Selection (D-065).** The initial selection is now `resolveWrapperTarget(store, 0).destination`
instead of the raw root — Tree, Detail, the breadcrumb and Raw agree on what's selected from the
first frame. `transparentWrapper.ts` moved to `src/renderer/wrapperDescent.ts` (a peer of
`nodeDisplay.ts`) since `documentSession.ts`, which now calls it, isn't a component. One existing
test's expectation changed to match the corrected behaviour
(`test/documentSession.test.ts`'s "opens a well-formed document end to end").

Full suite green (one `documentSession.test.ts` timing test flaked once under load, passed on
isolated and full re-runs — the same load-sensitive class R24 already documented, not a
regression). `npm run typecheck`, `npm run lint`, and `npx stylelint` all clean.

---

## R24 — the renderer spine is per-tab · built

`docs/plans/R24-tabs.md`, D-064. R25–R30 remain open.

`session/tabs.ts` is new: a registry bundling, per tab, a `DocumentSession`, `SearchStore`,
`FindStore` and `NavigationStore`, with one active-tab pointer. `activeSession.ts`,
`activeSearchStore.ts`, `findStore.ts` and `navigationStore.ts` all became **lookups against the
active tab** rather than module-level singletons, each keeping its exact public call shape so panes
and commands still don't know tabs exist — `useDocumentSession.ts` itself needed zero changes.

**`commands/context` turned out to need a third shape** the plan's own "per tab / global / derived"
table didn't quite name: `documentSession`/`navigationStore` write into it from deep inside their
own control flow, so each gained a `setCtx` wrapper gated on a new `isActive()` dependency
(default always-true — every existing test is unaffected) plus a `resyncContext()` method
`tabs.ts` calls the instant a tab becomes active, so a background tab's own state changes can never
clobber what the active tab's panes are reading, and the newly active tab's own context is never
stale.

**Checked rather than assumed**: the four "controllers"
(`treeController`/`gridController`/`rawController`/`rawViewportStore`) needed no changes at all —
all four already re-register (or, for `rawViewportStore`, explicitly clear) on the same
`[store]`-keyed effect that already fires on any document change, so a tab switch is
indistinguishable from today's in-place reparse to that code. `layoutStore` stays global (put to
the project lead per the plan's own "report rather than guess," not decided unilaterally) and
`paletteStore` needed nothing — neither ever referenced document state.

**R20's own measurement ran first**, as `docs/plans/R19-document-props.md`'s redirect required: the extra
re-renders an unsliced `OpenDocument` causes turned out to cost ~3.3 ms of render time, summed
across all five panes, for a ten-keystroke burst — cheap, so R20's slice split was never built and
R24 inherited a number, not an obligation (D-063).

New: `test/tabs.test.ts`, ten tests against the real factories (not mocks) proving actual cross-tab
isolation — independent documents, context resolving only to the active tab, undo/search/find/
navigation staying separate, close-activates-a-neighbour. Full suite (1057 tests) passes
unmodified. Disclosed for R25+: no tab strip yet, and **the main process's own file watcher is
still single-document** (`document:watch` replaces whatever it was watching, confirmed by reading
`main/documents.ts`, not assumed) — a real gap once a second tab can actually be opened.

---

## R21–R23 — notifications · built

`docs/plans/R21-notifications.md`, D-062.

Notifications replaced the alert strip entirely rather than shrinking it (it was a row in normal
flow, so every message reflowed the panes; `<Notifications />` is `position: fixed`, mounted as a
sibling of `StatusBar`, and never in `.layout-body`, asserted directly against real Chromium layout
in `test/notifications.test.tsx`). Events and pending choices became notifications; standing
conditions stayed put (Raw's read-only banner), and the partial-parse warning was *dropped* rather
than moved — R12's status-bar counters already render that fact.

The finding that made it more than a layout fix: **`CONCEPT.md` §11.3's external-change prompt was
never built because there was nowhere to put it** — `externalChangeDetected` was set,
`hasExternalChange` was a context key, and `keepMine` had **no caller anywhere outside
`documentSession.ts`**, so a file changing on disk under unsaved edits told the user nothing. R23
closed this with a derived choice notification, no change needed to
`keepMine`/`externalChangeDetected` themselves — the gap really was only "no UI reads it."

One context key genuinely didn't exist and had to be added: `hasPendingTransform`
(`commands/context.ts`), mirroring `pendingTransform !== null` so
`confirmTransformAnyway`/`cancelTransform` have a real `when` gate. `dismissMinifiedBanner`
deliberately did **not** get an equivalent key — whether the banner is showing is a live
computation, never stored; its `when` is the same loose `canFormat` that
`nodepad.edit.clearUndoHistory` already accepts.

The partial-parse and no-op-Format events don't fit the derived/pushed split cleanly despite
reading document fields — `document.complete`/`lastTransformWasNoOp` don't self-clear, so rendering
them as *derived* would make them permanent rather than transient; `Notifications.tsx`'s own
`useTransientDocumentEvents` diffs consecutive session snapshots and pushes exactly on the
transition instead.

---

## R19 — React's dev performance tracks disabled · built · R20 closed

`docs/plans/R19-document-props.md`, D-061, D-063. First work under the per-topic document convention.

**Under `npm run dev` only, any in-place store replacement — Format, Minify, an edit's reparse,
undo/redo, reload — wedged the renderer within a second and grew it past 12.6 GB.** Not the
formatter (`format()` runs the same file in 385 ms; the packaged app does that Format in ~1 s with
flat memory): a DEV `react-dom` builds a readable prop diff for Chrome's "Components ⚛" track on
every re-render whose props object isn't referentially identical — which is every re-render — and
that walk recurses three levels and enumerates with `for...in`, which over an `Int32Array` yields
**one entry per element**. Every pane takes `document` as a prop, so it reached the `NodeStore`'s
parallel typed arrays and the row/line/name indexes.

It cannot fire on a first open (a mount has no `alternate` to diff), and it is stripped from
production builds — so `npm start` and the packaged executable can neither reproduce it nor verify
the fix. R19 deletes `console.timeStamp` before `react-dom` evaluates
(`src/renderer/devPerformanceTracks.ts`, which must stay the first import in `main.tsx`;
`test/devPerformanceTracks.test.ts` guards exactly that). The production bundle is byte-identical.

R20 — splitting `OpenDocument` into model/file/status slices — was hygiene on its own merits,
gated on a measurement. That measurement ran as part of R24: ~3.3 ms of render time across all five
panes for a ten-keystroke burst. Cheap, so R20 was closed and the slice split never built (D-063).

---

## R18 — the formatters made iterative · built

`docs/plans/M5h-PLAN.md`, `docs/plans/M5h-RESULTS.md`. The invariant violation found reviewing M5g's results.

**XML's `emitChild`/`formatElement` mutual recursion — which used to overflow the stack at nesting
depth ~5 000, well inside `DEFAULT_MAX_DEPTH = 10_000` — is now one explicit `ElementFrame`
stack**, the same shape `runParser` already used for pass 1's own tree-building walk. Pass 1's own
depth limit is now `DEFAULT_MAX_DEPTH`, not the old, ten-times-too-permissive `100_000`; and a
document past that limit degrades to the input **unchanged** rather than throwing (invariant 5),
for any pass-1 fatal, not only the depth case — indistinguishable from M5g's own no-op fast path
end to end. `runTransformJob` also gained a defensive `try`/`catch` around `format.format(...)`, so
any future formatter bug surfaces as an ordinary `transformError` rather than an escaped
`RangeError` that `worker.onerror` turns generic.

**§4's own check found JSON shares the identical defect**
(`formatValue`/`formatContainer`/`formatObjectBody`/`formatArrayBody`, confirmed throwing at the
same depth 5 000) — fixed here too, per the plan's own instruction that a shared defect belongs in
R18 rather than a follow-up, reusing the parser's own `ObjectState`/`ArrayState` enums since the
state machine is genuinely the same shape. **TOML does not share it** — R16's formatter was already
iterative. `test/xmlFormat.test.ts`'s 300-sample corpus and `test/jsonParser.test.ts`'s 23
exact-byte format tests both pass **unmodified**.

---

## M6 — TOML · built (R14–R17)

`docs/plans/M6-PLAN.md`, `docs/plans/M6-RESULTS.md`. The architecture-validation format `core/types.ts`'s own
header names outright.

**The verdict holds**: zero lines changed anywhere except `src/formats/toml/index.ts` and the two
registration points the plan named in advance (`registry.ts`, the open-dialog filter in
`src/main/documents.ts`). No new `NodeKind`; tables map to `Object`, array-of-tables to `Array`,
key-value pairs fold their own scalar onto `Property` directly (D-030's rule, already true for
JSON). The one genuinely new piece of design work is dotted keys creating implicit nested tables
that must unify with `[table]`/`[[array]]` headers naming the same path —
`StackFrame`/`navigateToTablePath`/`navigateToArrayPath` exist for exactly that, and it is where
every real bug in this milestone lived.

**R17's own exhaustive check — every real node of a real fixture run through `resumeContextFor` +
`parseRange`, the actual `subtreeSplice.ts` production path, not a synthetic re-derivation — found
two more bugs that hand-written examples and a 300-sample generated corpus had both missed**: a
close-offset computed *after* the next key's own text had already been scanned, silently letting an
implicit table's span swallow that key's leading bytes (invisible to every tree-shape assertion —
parent/child/value all still resolved correctly, only the exact span boundary was wrong), and
`resumeContextFor`'s ancestor-only vantage point misreading a standalone `Comment` node as an
implicit table's first key statement (both can have an identical ancestor chain). Both fixed, both
regression-tested against the exact span boundary, not just tree shape.

**A disclosed, deliberate limitation, not a bug**: TOML legally permits non-contiguous table
extension (`[x.y.z]` then later, past unrelated content, `[x]`) — incompatible with this project's
contiguous-span tree model every other parser here relies on; a later `[x]` opens a second,
separate `Object`, never corrupting spans. Believed unreachable in real-world TOML.

What *was* verified without a GUI: `npm run inspect` recognizing and parsing a real
Cargo.toml-style fixture through the real registry path, and `detectGrid` correctly identifying
both a plain and a dotted `[[array of tables]]` as grid-eligible using the exact same
format-agnostic function XML/JSON already use — zero TOML-specific code in `gridDetection.ts`.

---

## M5g — Transform performance · built, one item deferred (R13)

`docs/plans/M5g-PLAN.md`, `docs/plans/M5g-RESULTS.md`.

Pressing pretty-print on an already-formatted document was doing ~826 ms of real work — a worker
round trip, a full reparse, an undo entry — to reproduce the exact document already open. **O1 now
detects this in the worker itself** (it already holds both the input and `format()`'s output) and
resolves `null` instead of transferring the result back, so a no-op skips the buffer swap, the
reparse and the undo entry entirely — moved there mid-task from an earlier renderer-side check,
specifically so a large no-op never pays for the transfer just to discard it. The comparison is a
`BigUint64Array` word compare with a byte-wise tail, not a byte loop.

**O0** fixed a related but *not* Transform-specific bug found in the same investigation:
`shouldRecenter` fired on every scroll event in the first/last 20% of a window already clamped at a
document edge, re-slicing onto the window already in place — indefinitely, and on every document
ever opened.

**O2** replaced the XML formatter's own `Map<Offset, FormatInfo>` (329,573 entries plus 329,573
heap objects on `cars-10mb.xml`) with parallel typed arrays read by an ascending cursor — invariant
2 applied where the formatter itself had been breaking it; **467.5 ms → 200.2 ms** on
`mixed-10mb.xml`. **O3** hoisted the hot loop's per-child indent-string allocation into a
depth-indexed byte cache. Combined, **9.6 MB/s → 17.9 MB/s**.

**O4 split**: `Tree.tsx` no longer collapses all expansion state on a same-document reparse (it was
keying the reset on `store` identity, which changes on every reparse, not just a new file) — fixed
and verified against real Chromium layout, confirmed to actually fail without the fix. The other
half — not remounting the Raw view's `EditorView` on every reparse — is **deferred rather than
attempted**: it needs four CodeMirror extension modules converted from closed-over values to live
getters plus a second non-remounting reparse effect in `Raw.tsx`, real surgery on the most heavily
hardened part of this codebase, with no live GUI in the building session.

---

## M5f — the status bar · built (R12)

`docs/plans/M5f-PLAN.md`, `docs/plans/M5f-RESULTS.md`.

A left group for document *state* (error/warning counters, both clickable to
`nodepad.navigate.nextDiagnostic` and disabled rather than hidden at zero — D-056's model, applied
outside the title bar for the first time) and a right group for document *facts* (caret position —
`Ln n, Col n` or `Byte n`, `hasMeaningfulLines` deciding which — clickable into the palette's `:`
mode; encoding; format; size on disk). Every item is unconditional, so the strip never reflows
across dirty/read-only/diagnostic states — asserted directly, not just designed that way.

The memory figure moved off the strip into a new statistics panel (`ⓘ`, also
`nodepad.document.statistics` per invariant 10) — `role="status"` is gone from the container with
it, closing a live-region defect where a screen reader announced a recomputed memory figure on
every render.

**Undo history is now a real line in that panel's memory table, not a gap**: `computeMemoryBudget`
had never summed the undo stack at all, so the total NodePad reported was wrong by up to ~2× the
document right after a Format — `OpenDocument.undoBytes`/`undoEntryCount`, kept current by
`syncUndoContext` at exactly the points the stack changes, preserving `computeMemoryBudget`'s O(1)
property. Two `CONCEPT.md` amendments recorded in D-060: §8's memory-in-the-status-bar language,
and §11.2's read-only badge (dropped).

---

## M5e — test tooling, six fixes, the XML formatter · built (R10, R8, R11, R9)

`docs/plans/M5e-PLAN.md`, `docs/plans/M5e-RESULTS.md`, in the plan's own order.

**R10** gave this project the renderer-level test tooling it had never had: two Vitest projects
(`vitest.config.ts`'s `test.projects`) — the existing node suite unchanged, plus a new `browser`
project running real Chromium via `@vitest/browser` + Playwright, since `M2-RESULTS.md`'s own
flagged gap needs real layout, which jsdom fakes. `scripts/electron-screenshot.mjs` drives the
actual built app via Playwright's `_electron` and writes a PNG a coding agent can read back.

**R8** fixed six defects from the first real session with the M5d title bar — the highest-value one
(8f) turned out to be `DocumentSession.setSelectedNode` silently never moving the caret on a
Tree/Detail selection, so Raw's scroll-to-caret effect never fired; fixed by moving the caret to
the selected node's span start by default, with a `moveCaret: false` opt-out for the one caller
(`rawCaretSync`) whose own selection *is* the caret moving. Three of the six are verified with
real-Chromium layout assertions confirmed failing before the fix and passing after.

**R11 reopened D-045** (D-058): a real, working, invariant-tested XML formatter. Its two supposed
hard blockers — mixed-content detection and inherited `xml:space="preserve"` scope — turned out to
already be built and load-bearing for M3's subtree splicing; the one genuinely new piece is a
two-pass design (`format()` receives bytes, not the `NodeStore`) built entirely from the real
parser's own tokenizer primitives, not a second parser. A real bug — the Document root's span
colliding with its first child's at byte 0, silently clobbering the child's verdict in a naively
keyed map — was caught by a 300-sample generated-corpus invariant test, not a hand-written example.
Surfacing a skip count was left open: `format()`'s signature is fixed by `core/types.ts`.

**R9**, the pretty-print button, needed no component changes at all once R11 made XML formattable:
`PaneShell` already renders whatever's registered for a pane's `paneHeader` surface.

---

## M5d — NodePad draws its own title bar · built (R1–R7)

`docs/plans/M5d-PLAN.md`, `docs/plans/M5d-RESULTS.md`. First milestone under the `R` scheme.

`titleBarOverlay` on Windows (keeping Snap Layouts, D-055's whole justification), `hiddenInset` on
macOS, Linux's native frame untouched — with the command bar fully retired: pane toggles and
Save/Undo/Redo/Open File now live in the title bar by scope (D-055), and the window title tracks
the open document with middle truncation and an unsaved-changes dot.

**Building R7 found a real registry gap the plan had named as possible rather than assumed away**:
"disabled, not hidden" needed a second, independent enablement gate (`Command.enabledWhen`)
alongside the existing `when` visibility gate — D-056, along with a smaller icon-collision fix (R4).

**Not verified**: the actual Electron window-chrome behaviour (drag, Snap Layouts, live overlay
recolouring, the macOS fullscreen transition) on any platform.

---

## M5c — Raw scroll performance, icons, polish · built (J1–J9)

`docs/plans/M5c-PLAN.md`, `docs/plans/M5c-RESULTS.md`, from the project lead's list (`docs/plans/M5c-PLAN.md`'s appendix). Two items left open rather than
silently dropped.

**J7's rasterization** (D-054a): getting there found `tools/generate.py` **could never have run on
Windows** — `cairosvg` needs a system libcairo that pip cannot supply — so it now uses `resvg-py`
through `uv`, and it had two silent bugs: it wrote to `build/` rather than `assets/build/`, and its
`.ico` call resampled one image into every frame, which is what actually caused the blur J7 was
written to fix.

**D-054b then reverted J7's central choice**: every OS-facing raster is the tile again, at every
size. **Windows picks an `.ico` frame by pixel size, not by which surface is asking** — the title
bar takes ~16px at 100% scaling and ~24px at 150%, the taskbar ~32px and ~48px — so J7's 48px split
ran through the taskbar's own range, and the same build showed a bare mark in the taskbar at 100%
scaling and the tile at 150%. Found by running the app, after the plan had **named that exact side
effect and dismissed it in the same sentence**; predicting a consequence is not evaluating it.

**J1** fixed the measured regression M5b introduced: `buildDecorationSet` ran on every viewport
change and, since the byte/UTF-16 fix in `30f1737`, called `byteOffsetToLocalUnits` **twice per
decoration mark** — a function that walks the window's text one code point at a time from position
0. One rebuild cost **313 ms at 10% into a 1 MB window, 1 368 ms at 50%, 2 479 ms at 90%**.
`c2fae60`'s `publishViewport` re-encoded the window twice per `scroll` event alongside it. Both the
same mistake — an O(n) conversion dropped where an O(1) one was, then called from a hot loop — and
the fix was a per-window offset map built once per re-slice, with an ASCII fast path. `30f1737`
was kept: the two axes really are different and the drift on non-ASCII content is real; what it
lacked was a data structure.

**J9's in-app measurement pass is unmeasured**: the `requestAnimationFrame` frame-time pass and the
window-crossing cost before/after J3 both need a running Electron window under load. J1's own
regression is confirmed fixed twice over regardless (a `node`-harness re-run of §1.1's methodology,
and a call-count regression guard against `rawOffsetMap.ts`'s checkpoint walk), just not through
the live app.

---

## M5 planning — what scale was scoped to, and what was refused

**`CONCEPT.md` §3.4's streaming parse will not be built — deferred at M5 (D-043).** The project
lead's call: a user opening a large file can expect to wait a few seconds, so time-to-first-row is
the weakest of the three problems M5 could address, and streaming would have made the memory figure
worse rather than better. Read §3.4 as an intention, not a description.
`NodeFlags.SubtreeComplete` and `SearchResult.provisional` stay as unused seams for a reversal.

**The architecture was reconsidered at the same point and deliberately kept (D-044).** Two more
ambitious routes were evaluated and are recorded there so they aren't re-proposed cold —
`SharedArrayBuffer` (**it does not cross OS processes**, so it cannot touch the larger of the two
copies at all, and it trades platform-enforced ownership for discipline), and worker-owns-
everything (the right v2 direction, rejected on sequencing: it puts an async boundary in front of a
structure designed for synchronous integer-compare reads, which rewrites every view).

**M5 is therefore memory and responsiveness only:** H2b (row index rebuild), H2c (the two copies),
H2d (chunk the splice), H4–H8 (Transforms), H9, H10, then **H11** — a timeboxed end-of-milestone
spike having the *worker* `fetch` the document over a custom protocol, so it materializes once in
the process that parses it. Gated on whether `Response.arrayBuffer()` peaks at 1× or 2×, and on the
handler being token-scoped rather than path-addressable.

---

## The M3+M4 review — two findings that reframed earlier numbers

**The "incremental" reparse is dominated by work that has nothing to do with the splice.**
`trySpliceReparse` rebuilds the **row index, line index and name index over the whole document,
synchronously, on the main thread**, right after `spliceSubtree` returns. M3-RESULTS §1 timed the
splice in isolation, so none of that is in its table. Measured: **200 MB — 1476 ms total, of which
the splice is 502 ms (34%) and `buildRowIndex` 888 ms (60%); 500 MB — 3822 ms total, splice
1299 ms, row index 2315 ms.** D-036 records the trade as "~1.2 s at 500 MB," which is the splice
column only; its correction addendum now carries the real figures. The row index does not need
rebuilding — rows before an edit are unchanged, rows after shift by a constant (`deltaList.ts`'s
`fold`, still unwired per D-037), and only overlapping rows need recomputation. **`M5-PLAN.md`'s
H2b owns this.**

**The open pipeline holds the document up to four times over.** Peak RSS is **822 MB at 200 MB
(4.11×)** and **1922 MB at 500 MB (3.84×)**, against §8's ~2.5× budget, from two independent
double-holds each inside one process: `document:read` does `readFile` then `.buffer.slice()` with
both live (main process alone hits 1055 MB on a 500 MB file), and `NodeStore.exportBuffers()`
slices all fifteen columns in one object literal so every copy coexists with its original (+643 MB
at 500 MB). Both fixes are small and both are `M5-PLAN.md`'s H2c. This also reframes
`M2-RESULTS.md`'s 554.2 MB peak and `M1-RESULTS.md`'s 776.1 MB: neither was wrong about what it
measured, but both stopped before the export step.

---

## M4 — search · built (G1–G10), plus two addenda

`docs/plans/M4-PLAN.md`, `docs/plans/M4-RESULTS.md`. The name index (`nameId → node refs`, G1), text find over
the byte buffer with a byte and a decoded path (G2), a chunked/cancellable job scheduler (G3) that
G4's search state and G8's path evaluation both run through, the Find UI (G5 — `Ctrl+F`, D-038),
filter-to-matches in the Tree (G6), the NodePad path parser and evaluator (G7/G8), and the
palette's `/` query mode (G9).

**M4's own measurement pass found two things §6 didn't predict**: an **unscoped** `//name` from the
document root is not meaningfully faster than a full scan (the index prunes refs outside a
context's span, and an unscoped query's context is the whole document — nothing to prune), and a
**predicate step collects its full candidate set before filtering**, so a query that looks scoped
through a predicate-selected ancestor (`car[1]//type`) doesn't reduce work the way it looks like it
should. Neither is fixed; an early-exit positional predicate is the concrete next step.

**A separate milestone-level review found and fixed six more issues**: wrong decoded-path byte
offsets for single-byte non-UTF-8 encodings (windows-1252 and relatives), duplicate descendant
matches under nested contexts (`//d//t` double-counting), an infinite loop in `decodedWindowsFor`
for a pathological `targetBytes`, unbounded work in `findNodesByName` before its own 50-result cap
applied, an unclamped "current match" index after a result set shrank, and — the most significant —
path evaluation never actually running through G3's scheduler (fixed via a new
`evaluatePathStep`/`pathQueryJob.ts`; a single expensive step still isn't preemptible mid-step).
Left open: `evaluate.ts`'s intermediate node sets are plain `number[]`, not the reused-scratch
`Int32Array` shape hard rule 2 specifies.

**A second addendum records five further findings**, all left for the fine-tuning pass: a
case-insensitive non-ASCII find path that costs 3.2× the regex it could delegate to,
filter-to-matches spending its row budget testing nodes rather than producing rows, a one-match
look-back in the Raw view's match decorations that can drop the current-match highlight, and — the
only silently-wrong one — `Interner.lookup` encoding query names as UTF-8, so a non-ASCII element
name in a windows-1252 document resolves as "absent from the document" and the query returns an
empty result with no diagnostic.

---

## M3 — editing · built (F1–F10)

`docs/plans/M3-PLAN.md`, `docs/plans/M3-RESULTS.md`. Patches, the delta list, debounced reparse, subtree
splicing wired into the live reparse path (D-036), selection re-resolution, undo/redo, save, and
F10's own measurement pass.

---

## M2 — grid mode · built (E1–E10), plus a review addendum

`docs/plans/M2-PLAN.md`, `docs/plans/M2-RESULTS.md`. A node with repeating composite children renders as a
virtualized, sortable, filterable table through one code path for XML and JSON alike; transparent
wrappers are descended through; copy as CSV/TSV/Markdown and a manual grid/list override are both
palette-reachable.

**M2's "open decision" turned out not to need making, and is closed.** E10 reported column
collection at 1.03 s / 200 MB and framed a choice between accepting the wait and sampling with a
frozen column order. Review found the largest component unmeasured — `isNumericColumn` decoded
every member of every numeric column to pick text alignment (**1522 ms**, absent from E10's table)
— making real first-paint cost **~2644 ms**, not 1.03 s. Both causes were implementation, not
algorithm: **grid first paint is now 417 ms at 200 MB and 985 ms at 500 MB**, output identical, and
E3's ten existing tests unmodified. Grid export above 50,000 rows now asks first rather than
silently spending ~8 s and ~97 MB.

**M2's own measurement pass is partial**, flagged rather than smoothed over: grid and Tree scroll
frame time and wrap's first-paint cost need a real `requestAnimationFrame` loop driving real
rendered React components. What *was* measured cleanly: E1 detection stays inside a frame budget at
every fixture size up to 500 MB, and peak RSS at 200 MB is **554.2 MB** through a single-read
harness — closing `M1-RESULTS.md`'s own flagged gap (its 776.1 MB figure held the source bytes
twice) and corroborating `M0-RESULTS.md`'s in-process 589 MB figure. (R10 later built the missing
harness.)

**M2b reversed one thing:** the Tree no longer compacts single-child chains (M2-PLAN E2,
§4.3/D-015). Every level is its own selectable row; expanding a node also expands a chain of
single-child descendants, so the click count is unchanged but nothing is hidden. See
`treeModel.ts`'s `autoExpandChain` and `docs/plans/UI-FEEDBACK.md`.

---

## M0, M0c, M1 — the data layer and the UI · built

`docs/plans/M0-PLAN.md`, `docs/plans/M0c-PLAN.md`, `docs/plans/M0-RESULTS.md`, `docs/plans/M1-PLAN.md`,
`docs/plans/M1-RESULTS.md`. Source buffer, row index, flat node store, XML and JSON parsers with spans,
the worker pipeline, then the three views and D15's measurement pass.

---

## M0a — the spike

`spike/RESULTS.md`. Benchmarked CodeMirror 6 at 10–500 MB and a throwaway byte-scanning XML parser
on the same files. It changed the design in five places, which is what it was for — all five are in
`docs/FINDINGS.md` because they are still load-bearing.

A3 measured **200 MB/s** for the throwaway spike parser; the production parser, carrying interning,
the `NodeSink` contract and §3.2's text rules, runs at **~65 MB/s**. The conclusion survives —
§10.1's WASM escape hatch stays unused — but the spike figure is not the shipping one and should
not be quoted as if it were.
