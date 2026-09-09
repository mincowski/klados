# Klados — findings

**Read this before implementing anything.** It is the short list of things that would otherwise
cost a day to rediscover — measured facts, load-bearing design consequences, and traps this project
has already fallen into at least once.

**This file is curated, not appended.** It has a budget: if it grows past roughly the length it is
now, something has stopped earning its place. Two rules keep it honest:

- **A finding leaves when it stops being true.** Fixed defects, closed questions and superseded
  measurements move to `docs/LOG.md` — history, not guidance.
- **Most rounds add nothing here.** A round earns an entry only if it produced a trap that will
  bite someone working on something *unrelated*. What a round built belongs in `docs/LOG.md`; why a
  decision went the way it did belongs in `docs/DECISIONS.md`.

Numbers are quoted with a pointer to the document that measured them. Do not re-derive them; do
check them if you are about to depend on one.

---

## The data model

**Node density is ~5× what the design assumed** (D-030). Insignificant whitespace is not modelled;
a leaf element holds its own text rather than owning a `Text` child; a JSON property holds its own
scalar rather than owning a `Scalar` child. Load-bearing for the memory budget — read
`CONCEPT.md` §3.2 before touching the data layer.

**The pending-delta list is mandatory** (D-010), not an optimization.

**Everything above `src/formats/` is format-agnostic, and it holds.** M6 proved it: TOML needed
zero lines changed outside its own file plus two registration points, no new `NodeKind`, and
`detectGrid` identified TOML arrays-of-tables as grid-eligible with no TOML-specific code. If a
format seems to need a change above the parser layer, that is a design signal, not a blocker.

---

## The Raw view

**It is windowed** (D-031). CodeMirror never receives more than ~1 MB of the document. There is no
large-file threshold, no second Raw View implementation, no large-file mode.

**Soft wrap is load-bearing, not a preference** (`CONCEPT.md` §3.1). A single-line window has no
scroll surface, so without wrap the window can never advance.

**Wrapping that single line costs ~2.1 s, and it is paid on every tab switch into a minified
document.** Measured in real Electron: activating a minified 10 MB document's tab takes ~2.5 s
against ~100 ms for the same document formatted; hiding the Raw pane removes all of it. The window
is the same 1 MB either way — what changes is that it is *one* `.cm-line`, so wrap is forced on and
CodeMirror must measure the whole line. It virtualizes across lines, not within one. Toggling wrap
on an already-open minified document isolates it exactly: **off 165 ms, on 2143 ms**.

**The cost tracks the window, not the file — so it is bounded and never grows.** `cars-mid.min.xml`
(0.95 MB) costs 2248–2675 ms and `cars-10mb.min.xml` (6.67 MB) costs 2481–2801 ms — the same, because
both fill the same 1 MB window. `cars-small.min.xml` (0.25 MB, so its whole file *is* the window)
costs 632–695 ms, roughly linear in window size. Two consequences worth having before anyone
re-measures this: a 200 MB minified file is no worse than a 1 MB one, and shrinking `WINDOW_BYTES`
for single-line windows is the cheap lever if it ever needs to be faster (~4× smaller window, ~4×
cheaper) — at the price of re-slicing more often on scroll, and against `WINDOW_BYTES`'s own A6b
memory justification, so it would have to be a single-line override rather than a global change.

**CodeMirror positions are UTF-16 code units; spans are bytes.** The two axes genuinely differ, and
drift on non-ASCII content is real. Converting between them is O(n) unless you use the per-window
offset map — dropping an O(n) conversion into a hot loop is how J1's regression happened
(`docs/LOG.md`, M5c).

**The editor's document is byte-faithful only because `EditorState.lineSeparator.of('\n')` says so**
(R168). CodeMirror's default split is `/\r\n?|\n/`, which treats a CRLF as one line break and
**drops the `\r` from the document entirely** — so on a Windows file its text is one unit shorter
per line break than the window text every offset map in `Raw/` is built from, and every unit→byte
conversion undercounts by the number of breaks before it. That shipped as silent corruption: edits
landed one byte early per preceding CRLF, visible only in the saved bytes, because the user sees
CodeMirror's own rendering. **Do not remove that facet, and set it on any new editor surface.** The
retained `\r` is invisible (nothing renders it; `highlightSpecialChars` is not installed) and the
caret does not land inside the pair on the keyboard path — but a lone `\r` is no longer a line
break, which is the deliberate price.

**Verify that a mutation landed where you aimed it before believing what the suite says**
(R169). This project proves tests non-vacuous by breaking the code and watching them go red — R159,
R162, R168 and R169 all turn on it — and the failure mode has now happened once: a two-line
`reloadAbort?.abort()` sequence was edited by text match, the same two lines existed in the
document-close path, and the edit silently landed there instead. The suite stayed green, which reads
as *"the test is vacuous"* when the truth was *"the mutation missed"* — and the two conclusions point
in opposite directions. **A green suite after a mutation is the least trustworthy of the two
readings**: check the diff, or target by line, before drawing anything from it.

**Every Raw edit fixture in this project was LF-only until R168**, which is why the above survived
for the project's whole life. If you are adding a test that drives an edit, vary the line ending —
the units and the bytes agree on LF and only on LF, so an LF fixture cannot see this class of bug
at all.

**CodeMirror does not remeasure `defaultLineHeight` on its own just because the page's zoom
changed** — measured directly (R59, `docs/plans/R58-zoom.md` §4): a bare `EditorView`'s `defaultLineHeight`
stayed completely stale after a CSS `zoom` change, with no auto-remeasure even ~100ms later, until
`view.requestMeasure()` was called explicitly. `Raw.tsx` now does this on every zoom change
(subscribing to `zoom.ts`); any *other* future source of dynamic CSS-geometry change (a font-size
setting, say) reading a CodeMirror-derived measurement needs the same explicit nudge — it will not
arrive for free from CodeMirror's own `ResizeObserver`, at least not on a timescale this project has
observed.

**The `EditorView` is still remounted on every reparse** — `Raw.tsx`'s mount effect is keyed on
`[store]`. `M5g-RESULTS.md` records the shape of the fix precisely enough that it does not need
re-deriving. R30's prediction that this would become the worst tab-switch figure **is confirmed**:
it is what makes the two entries above cost 2.5 s per switch rather than once per open. Note the
fix only helps *returning* to a tab — the first switch still pays — and a live view per tab
multiplies the ~1 MB UTF-16 window by tab count, into R28's budget.

**A buffer rewritten outside CodeMirror does not reach the Raw view on its own, and the Tree/Detail
agreeing is not evidence that it did** (R100, `R100-raw-external-rewrite.md`). `sourceBuffer`
replaced by Replace, Format, Minify, Undo, Redo or Reload updates the model, the dirty flag and
every other pane — the live `EditorView`'s own document is a separate thing nothing tells. R41
(five days earlier) removed the full-remount-on-every-reparse behaviour that used to carry an
externally rewritten buffer to the view *by accident*; nothing replaced that side effect on
purpose. Fixed via `OpenDocument.externalRewrites`, an explicit counter the live-update effect
checks — a text comparison was rejected as the alternative (it would allocate a ~1 MB string every
~200ms of typing to answer "no"). **A related trap found fixing it:** `Raw.tsx`'s own
`applyReslice`/`planReslice` incremental path assumes old and new windows describe the *same*
buffer, just scrolled — it reuses whatever text is already decoded for the byte range the two
windows share. That is correct for a scroll-triggered recentre and silently wrong for a rewrite
that changed the buffer's *content*: an offset range that overlaps between old and new windows can
hold completely different characters (measured: a Format spliced old and new text together at the
overlap). Any future caller re-windowing the Raw view after a wholesale buffer replacement needs
the same `forceReplace` escape hatch, not `planReslice`'s default path.

---

## Performance and memory

**The worker seam costs nothing measurable; the pipeline around the parser does.**
`M1-RESULTS.md`'s "~45 MB/s worker-path vs ~65 MB/s direct" compares different work: 65 MB/s is the
parse function alone, 45 MB/s is parse **plus** row index, line index, `exportBuffers`, transfer
and rehydration. `M0-RESULTS.md` measured that same total in-process at 4.3–4.6 s. **There is no
worker-seam penalty to hunt.**

**Main-thread responsiveness during parse is confirmed clean** at every size from 10 MB to 500 MB:
zero frames over 32 ms, ~56 fps median (`M1-RESULTS.md` §1). D-031's "revisit if" is closed.

**Peak RSS and §8's memory budget measure different things**, and comparing them reads as a miss
that is not there. §8's table sums *resident* components; a peak-RSS walk through the open path
also catches `exportBuffers`'s transfer transient (+49.5 MB at 200 MB), which is momentary and
models nothing resident. **2.84× as a peak, 2.56× resident** — and the resident figure is 2.56× at
both 200 and 500 MB, so §8's ~2.5× rule of thumb and its "~1.25 GB at 500 MB" both hold. Say which
of the two a number is before comparing it to the budget (`docs/plans/M5-RESULTS.md` §2, §6).

**An RSS delta bounds a stage; it does not decompose into components.** Freed scratch from an
earlier stage gets reused rather than returned to the OS, so a later stage's delta *understates*
what it allocated — at 200 MB the "indexes" step reads 40.9 MB against components that sum to
54.8 MB, a 26% undercount. Measure a component with `byteLength`, never by subtracting two RSS
readings. (Found writing up M5's reconciliation; the `byteLength` route reproduced M4's
independent name-index figure to three significant figures, the subtraction route did not.)

**The architecture rule** (D-044): **the renderer owns the store and reads it synchronously; any
operation touching the whole document is chunked, never relocated.** `SharedArrayBuffer` does not
cross OS processes and cannot help; worker-owns-everything is the right v2 direction but puts an
async boundary in front of a structure designed for synchronous integer reads.

**A CSV-shaped document costs ~4–7× its file size in the node store**, against XML/JSON's
~2.0–2.8× (measured, `docs/plans/R34-wide-grids.md` §1). Same node count, far fewer source bytes — no
tags, no closing tags. Inherent to modelling every field as a node (D-030), not fixable in the
grid: **CSV's practical ceiling is ~100–200 MB where XML's is 500 MB.**

**Streaming parse will not be built** (D-043). Read `CONCEPT.md` §3.4 as an intention, not a
description.

---

## Recurring mistakes this project actually makes

**The suite tests mechanisms; nobody was testing the application. One 20-minute manual pass against
a real build found three user-visible defects that ~1,860 automated tests did not**, and the three
are worth listing because they fail differently and none of them is an edge case. All three are
**planned and open** at the time of writing — live defects, not history:

- **R168** — a Raw edit on a **CRLF** document lands at the wrong byte. Silent data corruption, on
  the line ending Windows uses by default.
- **R170** — a tree at **depth 10,000** compresses every label out of existence and cannot scroll
  to them.
- **R169** — "Reload and Discard" gives no sign it did anything, so it reads as a dead button.

**Two of those are whole dimensions of the input space that no test ever varied.** Not untested
values within a tested axis — untested *axes*. Every Raw edit fixture in the suite is LF-only, so
the units-to-bytes conversion had never once met a carriage return; every tree fixture is shallow,
so indentation had never been allowed to exceed a viewport. Both were found the first time a person
opened a real file of that shape.

**The third is a property the suite is not shaped to hold at all.** R169 is about *feedback* —
whether the UI acknowledges a click within a frame — and every test here asserts outcomes. A test
that the document reloaded passes identically whether the button felt instant or dead.

The structural cause is the same one the entry below names at module level, one level up:
`mainElectron.test.ts` is the only test that drives the real application, and **it contained two
tests** (zoom, preload surface) until R164–R167 needed it four more times, each of which
immediately caught something a unit test could not reach. Everything else exercises a component
against a harness, and a harness is built from the same assumptions as the code.

Two things follow, and they are cheap:

1. **When adding a fixture, ask what axis it does not vary.** Line endings, encoding, depth, size,
   and whether the file is on the platform's native path shape are the ones that have bitten so
   far. A second fixture differing on one axis is worth more than ten differing on none.
2. **Anything a person perceives — feedback, focus, a native dialog, a drop target — belongs in
   `mainElectron.test.ts` against the real build**, not in a component harness. That file is where
   this project's blind spot ends.

**And that file was launching Electron against the developer's own profile.** `electron.launch`
with no `--user-data-dir` inherits the app's normal `userData` path — the same one an installed
Klados uses — so the suite shared `localStorage`, the recent-files list, persisted keybindings and
the title-bar theme with whoever ran it. Since `main.tsx` calls `beginSessionRestore()` at module
load, **the test app reopened their documents**: a run on the machine where this was found restored
a 10 MB XML fixture and put a real file watcher on it, which is the only reason anyone noticed.
Two problems in one — **a test whose outcome could depend on what someone last had open**, invisible
on CI where the profile is always fresh, which is the worst place for that difference to hide; and
**tests writing to a real user's state**. Fixed with a temp profile per run, which also made that
file **three times faster** (13 s → 2.1 s), since the app no longer parses a 10 MB document on every
launch. **Any future test that launches the real app needs the same switch.**

**Measuring a component cleanly while leaving the pipeline around it unmeasured. Five instances so
far**: M0's row-index pre-scan claim, M2's `isNumericColumn` (1522 ms, absent from its own results
table), the M3 splice timed without its index rebuilds, M5c's J1 — the first where a *review fix*
caused it rather than found it — and R161's `tabSwitchMeasurement.test.tsx`, which zeroed its
counters after two frames and so could charge CodeMirror's late mount commits to the switch it was
measuring. Before quoting a figure, check what it excludes.

**Wait for the condition, never for a duration — and a green test is not evidence the wait worked.**
Six instances: R140, R152, R154 (two), R158, and the 58 sites R159–R163 converted. The tell is
constant: **a helper whose comment describes something asynchronous while its body waits a fixed
number of milliseconds.** The comment usually names the exact reason the duration cannot be right.

The half worth knowing before touching anything unrelated is the *silent* one. A wait that is too
short does not only go red. Where the assertion is negative, or the state is unchanged either way,
the awaited thing never happening produces exactly the expected result — so the test passes, forever,
without exercising what it claims. **`rawCaretSync` had no coverage at all**, behind a 250 ms sleep
commented "past rawCaretSync's debounce"; raising that debounce to `200_000` left the entire browser
project green (239 tests). If a test's value rests on something asynchronous having happened, the
only way to know it does is to break that thing and watch the test fail.

Two traps in writing the replacement, both hit in R160: **stable and not-yet-started are
indistinguishable from outside**, so a condition must prove the work *ran* (a changed snapshot
identity) before believing it *finished*; and **repainting inside a poll remounts the component**,
destroying any pending debounce and typed input, so a wait can prevent the very thing it waits for.
`test/support/wait.ts` holds the vocabulary and an eslint rule blocks new call-site durations.

**A sandboxed preload cannot `require` a node_modules package, and electron-vite externalizes
declared dependencies rather than bundling them.** So `sandbox: true` fails with *"Unable to load
preload script … module not found: <pkg>"*, `window.api` is `undefined`, and the whole application
is inert — not degraded, inert. R166 hit this on `@electron-toolkit/preload`. The preload's imports
must be `electron` (or a genuinely inlined module) and nothing else; anything added to
`src/preload/` needs checking against a real built app under the sandbox, because a `require` that
works in dev and in a normal build fails only there.

**The renderer's `<meta>` CSP blocks `klados-file://` from page context, and that is load-bearing.**
`index.html` declares `default-src 'self'` with no `connect-src`, so a `fetch` of the read-token
scheme from the document is refused outright; the parse worker's bundled script carries no CSP and
is unaffected, which is why the app works. **It is a real second control on the file-read
primitive** — widening that CSP for an unrelated reason would remove it silently, so
`mainElectron.test.ts` pins the refusal. Note the limit: the meta tag does *not* travel with the
`webContents` across a navigation, which is why R164's navigation guard is the primary control and
this is only a secondary one.

**Predicting a consequence is not evaluating it.** D-054's icon split named the exact side effect
that broke it and dismissed it in the same sentence. If a plan says "this might mean X," that is a
thing to test, not a thing already handled.

**A stack overflow is a statement about the code's shape, not about its input.** R18's symptom was
observed once and written up as "confirmed not an app bug" because a known-broken fixture generator
was in front of it. "The input was malformed" explains why a parse fails; it never explains why a
stack ran out.

**Tests that assert shape but not exact values miss whole classes of defect.** R17's TOML span bug
was invisible to every tree-shape assertion — parent, child and value all resolved correctly, and
only the span boundary was wrong. Parser-adjacent code is invariant-tested, not example-tested
(M0-PLAN B12), and the strongest check found so far is running every node of a real fixture through
the actual production path (`resumeContextFor` + `parseRange`), which caught two bugs a 300-sample
generated corpus had missed.

**In the light theme, `--surface-bg` and `--elev-2-bg` are the same colour** (`--gray-0`, `#ffffff`);
in dark they are a real step apart (`--gray-900` vs `--gray-700`). An elevated surface therefore has *no boundary of its own* in
light mode — only `--elev-2-shadow` separates it from the pane behind it. This has now bitten three
times: R33/D-051 §1b (the scrollbar thumb, near-invisible), R57's own plan (the notification, where
a severity fill had been hiding it), and R57's own build (**`--surface-border` and dark's
`--elev-2-bg` are *also* the same token, `--gray-700`** — a hairline drawn in `--surface-border`
against an elevated dark surface is genuinely invisible, contrast exactly 1:1, not merely weak). Any
new elevated surface needs its own boundary treatment verified by actual contrast, not assumed from
"it has a border declared" — and any check must be run in **both** themes, since which pair collides
(`--surface-bg`/`--elev-2-bg` in light, `--surface-border`/`--elev-2-bg` in dark) differs by theme.
**Only one of the seven `--elev-2-bg` surfaces has a border at all** — `.notification`, from R57;
Find, the command palette, the statistics panel, the tab-strip overflow menu and both grid dropdowns
have none. `docs/plans/R60-dark-elevation.md` is the round that moves the hairline to the tier and stops
dark over-stepping the background to compensate.

**A fixture of look-alike characters cannot be authored by typing them.** U+212B ANGSTROM SIGN and
U+2126 OHM SIGN are *canonical singletons*: any NFC-normalising step between writing and disk
replaces them with U+00C5 and U+03A9, silently. `test/fixtures/confusables.xml` was written that way
once and measured no divergence at all — a fixture that passed while testing nothing. Author such
files from `\uXXXX` escapes, and **assert the codepoints are present before asserting behaviour**,
or the test cannot tell a fixed bug from a destroyed fixture. Compatibility mappings (the micro sign,
sharp s) survive, so most of the file still looks correct — which is what makes it hard to spot.
Full account: `docs/plans/R72-path-query.md` §6.

**U+2329/U+232A (the "angle bracket" pair) have a canonical decomposition to U+3008/U+3009, the CJK
angle brackets — invisible until something normalizes.** `'〈'.normalize('NFC')` returns U+3008.
Picked as a glyph, it renders as a narrow angle bracket at whatever size it was authored; any NFC
pass anywhere in the pipeline (source control, an editor, a future normalization step) silently
turns it into full-width CJK punctuation — measured at 22.00px against a 20px box, R83
(`docs/plans/R82-hover-and-glyphs.md` §2). A trap for reaching for an angle-bracket-shaped mark
anywhere in this codebase again; U+27E8/U+27E9 (`⟨⟩`, General Punctuation's mathematical angle
brackets) have no such decomposition but are absent from every font stack this app names, which
ruled them out on font-availability grounds instead.

**A narrow type is not a narrow value.** `TreeContentProps` types `document` as three fields;
`Tree` passes all 26, because structural typing narrows only the compile-time view. If something
must not see a value, do not hand it the object.

**`applyPatch` allocates the whole document per call, so calling it in a loop is
O(document × patches).** It is the correct primitive for one patch and the wrong one for a batch;
both batch call sites (`applyReplaceAll`, `applyUndoEntry`) had it, and the symptom is a frozen
window with a working scroll wheel (a synchronous main-thread stall, not a crash or deadlock —
Chromium scrolls on the compositor thread independently of a blocked main thread). Fixed by
`applyPatchesAscending` (`documentEdits.ts`, R108), a single-allocation pass — but **only for a
patch list built as one batch against a single baseline** (non-overlapping by construction, like
Find's matches). An *incrementally* recorded list — an ordinary typing burst, where the same byte
range can be touched more than once in one undo entry — breaks it: not slower, silently or loudly
wrong, since overlapping patches are outside the primitive's precondition. `UndoEntry.independent`
(`undoStack.ts`) is the flag that keeps the fast path scoped to where it's sound
(`docs/plans/R108-replace-all-quadratic.md` §8) — found by an existing test failing loudly the one
time the fast path was tried unconditionally, not by inspection.

**A scroller made focusable with `tabIndex={-1}` needs an explicit `outline` rule.** The
user-agent's `outline: auto` ring straddles the border box; a parent's `overflow: auto` clips
everything outside it but a thin sliver, and what survives reads as a stray 1px line rather than a
focus ring — so it gets reported as a rendering artefact, not as a missing style. R91 made three
scrollers focusable (`docs/plans/R91-focus-into-content.md`); `.detail` was the one with no rule,
found by R106 (`docs/plans/R106-detail-focus-ring.md`).

---

## Fonts

**`ui-monospace`, the first entry in `--font-mono`, is not monospace in Chromium on Windows.**
Measured at 11px: `{}` draws 8.67px against `<>`'s 12.54px through that one keyword alone — visibly
proportional, not fixed-width. The stack (`ui-monospace, 'Cascadia Code', Consolas, monospace`)
behaves correctly only because Cascadia is installed and matches second; the first entry does
nothing. Do not trust a stack's *name* to describe what it resolves to — measure the stack as
installed.

**Cascadia (`--font-mono`'s second entry) closes `<>` into a solid diamond at UI sizes, and it is
not fixable by size or weight — `font-weight: 600` makes it worse.** One font's letterform, not a
property of monospace fonts in general: the identical string renders open in Consolas. Verified by
rendering, not inferred from advance width — R83 (`docs/plans/R82-hover-and-glyphs.md`) measured
`<>`'s width correctly and still shipped the diamond, because a correct width measurement says
nothing about shape. R98 (`docs/plans/R98-glyph-font-per-glyph.md`) is the fix: `<>` alone renders
in `--font-ui`, keyed on the glyph string via `glyphFont.ts`'s `glyphFontClass`.

---

## Environment and tooling

**`npm run dev` and the packaged app differ in ways that matter.** React's dev-only performance
tracks are stripped from production builds, so `npm start` and the packaged executable can neither
reproduce nor verify a dev-only defect (R19). When a report says "the app hangs," establish which
one first.

**`src/renderer/devPerformanceTracks.ts` must stay the first import in `main.tsx`.** It deletes
`console.timeStamp` before `react-dom` evaluates, which is the only way to disable a prop-diff walk
that enumerates the `NodeStore`'s typed arrays. `test/devPerformanceTracks.test.ts` guards the
ordering; an import sort is the realistic regression. It also depends on a React internal, so
**re-check it by hand after any React upgrade** — the failure is silent and catastrophic (>12 GB).

**Any test that profiles a realistically large document needs its own `import
'../src/renderer/devPerformanceTracks'` — first, before any React import.** `main.tsx`'s own
placement only protects the packaged app; a standalone test file never goes through `main.tsx` at
all. Every existing render-cost test got away without it because its fixture was tiny (tens of
bytes); R30's ~30,000-node document turned the undisabled walk into a >180-second hang and a
Chromium out-of-memory crash (`docs/plans/R24-tabs.md`'s own R30 Results section). Add the import first
in any new test that mounts real panes against a document past a few hundred nodes.

**Debugging a wedged renderer**: it answers nothing — no `evaluate`, no console output, because a
blocked main thread never flushes. `npm run dev -- --remote-debugging-port=9222` plus Playwright's
`chromium.connectOverCDP` gives a driven app; **`Debugger.pause` interrupts the wedged thread and
returns a stack**, and `Debugger.evaluateOnCallFrame` runs expressions while it is parked.
Non-pausing breakpoints (a condition that increments a global and returns `false`) count call sites
without stopping. In dev the renderer is served as real ES modules, so
`await import('/session/activeSession.ts')` reaches the singleton directly.

**Real layout needs the browser project.** jsdom fakes it; `npm run test:browser` runs real
Chromium. Anything about geometry, reflow or computed style is asserted there or not at all.

**`out/` is not rebuilt by anything you normally run.** Playwright's `_electron` launches
`out/main/index.js`, and neither `npm test` nor `npm run typecheck` touches that directory — so a
real-Electron measurement happily reports the state of whatever was last built. R33's addendum-2
measurement first "found" a bug that had been fixed five hours earlier, because `out/renderer`
predated the commit. **Run `npx electron-vite build` before any `_electron` session**, and check the
asset timestamps if a result contradicts the source you are reading.

**Playwright's `_electron` cannot test the `close`-interception behaviour (R26) at all** — a
`BrowserWindow.close()` issued through its automation tears the window down regardless of
`event.preventDefault()` in the `close` handler, confirmed by isolating the identical
prevent-default logic in a standalone, non-Playwright Electron script (where it correctly holds the
window open). Not a bug in the app; `_electron`'s own limitation, plausibly to keep its automation
lifecycle deterministic. Test this behaviour against extracted plain logic instead
(`src/core/mainQuitFlow.ts`, `test/mainQuitFlow.test.ts`), not through `_electron`. Full account:
`docs/plans/R51-main-process.md`.

**Every past real-Electron measurement in this project's history was taken at zoom factor 1.25,
where `npm run dev` runs at 1.0 — retired as a live concern by R58** (`main/index.ts` now sets the
zoom explicitly on first load), but worth knowing when reading an *old* measurement: an element's
own CSS-pixel size was unaffected, but the viewport was 25% narrower in CSS pixels and a screenshot
was at 1.25 device pixels per CSS pixel. Full account (including the still-unidentified root cause):
`docs/plans/R58-zoom.md`.

**GUI behaviour is largely unverified.** No session building this project has had a display to
drive, so Electron window chrome (drag, Snap Layouts, live overlay recolouring, the macOS
fullscreen transition), Tree/Detail rendering for TOML, and an edit-undo cycle through a live
window have never been exercised end to end. Flagged repeatedly across J9, M5d, M5e, M5g, M6 and
R21 — assume it, don't rediscover it.

**`grep -c $'\r'` returns false zeroes in this environment**, against files independently confirmed
(via `node -e` byte counting) to contain hundreds of `\r` bytes. Verify any byte-level claim
(line endings, encoding, control characters) with `node -e` reading the file as a `Buffer`, not with
the shell's own `grep`/`sed`. Full account: `docs/plans/R47-repo-hygiene.md`.

---

## Known-wrong, not yet fixed

- **The path query grammar (`core/path/parse.ts`'s `NAME_CHAR`) is ASCII-only** — `/[A-Za-z0-9_.:-]/`
  — so a query like `//größe` fails to parse as a name at all, before name resolution is ever
  reached. Found while verifying R53's `Interner.lookup` encoding fix: that fix is real and tested,
  but this separate, one-layer-earlier gap means the Palette still can't reach it by typing a
  non-ASCII query. Widening `NAME_CHAR` to accept Unicode letters is a small, separable follow-up.
  Full account: `docs/plans/R53-interner-encoding.md`.
- **`evaluate.ts`'s intermediate node sets are plain `number[]`**, not the reused-scratch
  `Int32Array` hard rule 2 specifies.
- **An unscoped `//name` is not meaningfully faster than a full scan**, and a **predicate step
  collects its full candidate set before filtering** — so `car[1]//type` does not reduce work the
  way it looks like it should. An early-exit positional predicate is the concrete next step.
- **`npm run test:large` currently fails.** A full run across every fixture takes ~21 minutes and
  ends with 8 truncation-fuzz tests failing on a worker RPC timeout (`[vitest-worker]: Timeout
  calling "onTaskUpdate"`), not an assertion, on the largest fixtures at the full 200-sample count.
  Confirmed pre-existing, not caused by the round that found it. Full account: `docs/plans/R47-repo-hygiene.md`.
- **TOML permits non-contiguous table extension**; this project's contiguous-span tree model does
  not. A later `[x]` opens a second, separate `Object` rather than corrupting spans. Believed
  unreachable in real-world TOML, disclosed rather than left to be rediscovered.
- **`border-radius` silently fails to render on an element whose top edge sits at a fractional
  device-pixel row** (found on the Raw Scrubber's thumb at `top: 0`, R33 addendum) — reproduced on
  a completely unrelated, freshly-injected `position: fixed` div at the same fractional Y with no
  relation to the real component, and *not* reproduced at an arbitrary Y away from any pane
  boundary. `transform: translateZ(0)` (new compositing layer) and a few-pixel inset both failed to
  fix it. This project's pane heights are not integers (flex layout composing `--row-height`,
  banner presence, and a resizable split), so any rounded corner near a pane boundary is at risk.
  Not understood, not fixed — flag it rather than re-debug it from scratch.
- **`focusin` is an event, not a state — a registry that learns focus only by listening will be
  wrong whenever it registers *after* focus arrived.** Cost a dead F6 in `focus.ts`: `StrictMode`'s
  mount → cleanup → mount replay cleared `lastFocusedPane` while the DOM element kept focus (it
  never unmounted), and no second `focusin` was ever fired for the replacement listener. The trap
  that made it permanent rather than transient is worth the same attention: `moveFocus`'s "nowhere
  focused" fallback targeted `PANE_ORDER[0]`, which was *already* focused, so `.focus()` was a
  no-op, no event fired, and **the broken state was also the state that prevented recovery**. Any
  code that pairs "listen for the event" with "fall back to element zero" can deadlock this way.
  `registerPane` now adopts focus already inside the shell it is given.
