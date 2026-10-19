# R239 — a regex Find that can be stopped, and the `u` flag

<!-- status: built -->

**Built** (§6), except the `u` flag.
- **Part A, the terminable worker, is built as planned.** Regex Find no longer freezes the window, and
  it is faster than before: 0.68× and 0.73× at 200 MB.
- **Criterion 1's probe was wrong.** `page.evaluate` answers while the renderer is frozen, so the
  test measures the gap between frames instead (§6.1).
- **Part B, the `u` flag, is measured and not turned on.** It changed a test result (`ß` now
  finds `ẞ`), and it would make plain and regex mode disagree on four ASCII pairs. The project lead
  chose to take it up separately, as a change to D-097 (§6.4).

Planned from the review of 2026-10-16, finding 10 (low). Lowest priority of the review's
rounds: the pattern is the user's own, so this is a usability defect rather than an exploit. A
hostile document can still make an innocent-looking pattern slow.

**Partly reverses D-041** ("search and query run chunked on the main thread, not in the worker"), for
regex matching only, and needs a `DECISIONS.md` entry saying so (§2, criterion 8). The per-window
deadline was **decided by the project lead on 2026-10-17: 2 s**.

## 1. The defect

Regex Find runs `regex.exec` on the renderer's main thread (`src/core/textFind.ts:582`), one decoded
window at a time. Windows are `DECODED_WINDOW_BYTES = 64 * 1024`, sliced by `runChunkedJob`
(`searchJob.ts`). Slicing bounds the time **between** windows, not **within** one. A pattern with
catastrophic backtracking, such as `(a+)+$` against a line of thirty `a` followed by `b`, runs one
`exec` for an exponential number of steps:
- **The window freezes.** No paint, no input.
- **Cancelling cannot help**: a new keystroke or Escape is an event the blocked thread never
  processes.
- The only way out is killing the process, **losing unsaved edits in every tab**.

**First, measure (PLANNING.md §2).** Time that pattern on a 64 KB window in the built app's
renderer. Also time a normal regex Find (`\d{4}-\d{2}`) over the 200 MB fixture end to end, which
becomes §3's baseline. Both numbers go in Results.

Separately, the regex is compiled with `g`/`gi` and never `u`, so `\p{L}` and other Unicode property
escapes are rejected as syntax errors, and `.` matches half a surrogate pair.

## 2. The change — A: regex matching moves to a killable worker

**Only regex mode moves.** The case-sensitive `indexOf` path and the escaped-literal path for
case-insensitive plain search stay where they are, because neither can backtrack.

1. A search in regex mode starts **one dedicated worker** for that search. It is not the parse
   worker pool, since terminating a pool worker would cost a parse.
2. **The worker replaces one call, `decodedTextMatches`, and nothing around it.** For each window,
   the renderer still decodes (`decodeWindow`) and still applies R204's normalization: for a needle
   that is not pure ASCII, the window goes through `normalizeWindowForSearch` and the needle through
   `normalize('NFC')`; otherwise both stay as they are (`identityWindow`). **It posts that
   normalized text and that needle** to the worker, never the raw decoded text, and awaits
   `{ index, length }[]` in the normalized text's UTF-16 coordinates. Mapping back stays on the
   renderer, unchanged and in the same order: `originalIndexOf` through the normalization map, then
   `byteOffsetOf`. Invariant 1 holds as today: at most one 64 KB window of text exists at a time,
   now with one copy in flight to the worker.
3. **Per-window deadline: 2 s**, decided by the project lead on 2026-10-17. R205 measured an ordinary
   escaped regex at about 0.18 ms per 64 KB window (35.5 ms for 200 passes), so 2 s is roughly
   10,000× that. Since the worker keeps the window responsive whatever the pattern does, the deadline
   no longer protects the UI; it only decides when Klados gives up without being asked. On expiry,
   and on any cancel (a new query, Escape, a document switch), the worker is **terminated**, not
   messaged. Termination is the only thing that stops a running `exec`.
4. On a deadline, the search ends with a notification: *"This pattern takes too long to search
   with."* Matches found in earlier windows are kept and shown, and labelled as partial in Find's
   counter.

**Cost, stated because the obvious version is slower** (PLANNING.md §3):
- At 64 KB, a 200 MB document is about 3,200 windows, so about 3,200 round trips. Each window is
  posted as a **string**: 128 KB UTF-16 at most, structured-cloned, with nothing transferred.
- **The budget is ≤ 1.25× §1's baseline** on the 200 MB fixture. If it is missed, the fix is
  **batching several windows per message**, under the same deadline, not raising the budget.

**Rejected:**
- *Detecting dangerous patterns before running them* (nested quantifiers and the like). The detection
  is incomplete in both directions, and a refusal the user cannot predict is worse than a slow search
  they can stop.
- *A per-window timeout on the main thread.* JavaScript cannot interrupt a running `exec` from the
  same thread.
- *No automatic deadline, only Escape*: a stuck search the user does not notice would keep a CPU core
  busy indefinitely. A shorter (500 ms) or longer (10 s) deadline was weighed and not chosen.

**Why this does not contradict D-041's reasoning.** D-041 kept search on the main thread because,
after a parse, *"there is no worker-side store for a query to run against"*: the node store is
transferred to the renderer. Regex matching never touches the store. It needs one window of text and
a needle, both of which are copied to the worker. D-041 also anticipated this move: it put every
whole-document search through `runChunkedJob` *"so that moving this work off-thread later is a swap
behind one interface rather than a rewrite of every call site"*. This round is that swap, for regex
mode only. Plain Find, grid filter and path queries stay on the main thread under D-041 as it is.

## 3. The change — B: the `u` flag, measured before decided

Turning on `u` changes behaviour beyond syntax. Under `iu`:
- the engine uses Unicode case folding, so `/s/iu` matches `ſ` and `/k/iu` matches U+212A KELVIN
  SIGN.
- plain case-insensitive search **is** a regex (R205), so plain and `.*` mode agree **by
  construction** (D-097, which superseded D-082). Adding `u` to one mode and not the other
  reintroduces exactly the disagreement D-097 removed.
- R204's NFC normalization sits underneath both modes (D-097: "the order is load-bearing"), so `u`
  is measured on the normalized window, which is what the worker receives (§2.2).
- the byte path's ASCII shortcut accounts for exactly the code points FINDINGS lists (*only two
  non-ASCII code points lower-case to ASCII*), and `iu` folding may add more.

So: **turn `u` on for both regex and escaped-literal compilation in a scratch change, and run
`textFind.test.ts`, `textFindConfusables.test.ts` and `textFindNormalization.test.ts`.**
- **If any assertion changes, stop and report** to the project lead with the list of changed code
  points. This is a `DECISIONS.md`-level change to D-097, not something this round decides.
- If nothing changes, keep `u` on both, and add a pattern that only compiles under `u` as a test.
  With `u`, the zero-length-match advance must step by a **code point**, not a code unit.

## 4. Acceptance criteria

1. **This must not freeze the window.** In `mainElectron.test.ts`, against the built app:
   - Open a fixture with a line of 30 `a` followed by `b`, and run a regex Find for `(a+)+$`.
   - **Before the fix**, show it blocks: `page.evaluate(() => 1)` does not answer within 5 s. Quote
     the result in Results, then end the test.
   - **After**: `page.evaluate(() => 1)` answers within 500 ms of starting the search, and a
     notification naming the pattern as too slow appears within the deadline plus 1 s.
   - Waits are conditions, not sleeps (FINDINGS).
2. **Cancelling stops it**: the same search, then Escape, and the worker is terminated. Asserted by
   a test hook counting live search workers, which returns to 0, not by timing.
3. **Results are identical**: for every regex case already in `textFind.test.ts`, the worker path
   returns the same `starts`/`ends` as the in-thread path. Run as a table over both paths in one
   test, so the in-thread function stays as the reference. The table includes **non-ASCII needles
   over a decomposed window** from `textFindNormalization.test.ts`, so the normalization map is
   exercised through the worker. Mutation: posting the raw decoded text instead of the normalized one
   turns those rows red.
4. **Cost**: §2's budget is met on the 200 MB fixture (`npm run test:large` or a `spike/` bench,
   whichever measures in the real renderer; FINDINGS: *measure in the renderer rather than trusting
   a Node bench*). Both numbers go in Results.
5. Partial results after a deadline are shown and labelled. The counter text is chosen from a
   rendering (PLANNING.md §1).
6. §3's outcome is recorded either way. If `u` landed, `\p{Lu}+` finds `ÄÖÜ` in a UTF-8 fixture, and
   a zero-length pattern over an astral character advances without splitting it.
7. Mutation: with termination removed from cancel, criterion 2 goes red.
8. **`DECISIONS.md` gains an entry amending D-041**: regex matching runs in a terminable worker, with
   §2's reasoning for why that is consistent with D-041, the 2 s deadline and its rejected
   alternatives. D-041 itself gets a one-line pointer to the new entry, and its status stays
   `settled` for everything else it covers.

## 5. Not in scope

- Grid filter and path queries. Neither uses user regexes.
- Matches spanning more than the one-row window overlap. That is unchanged behaviour, and a separate
  question if it is ever raised.

## 6. Results (2026-10-19)

Landed on branch `r239-regex-find`. **Part A is built as §2 describes. Part B, the `u` flag, is not
turned on:** turning it on changed a test result, which is §3's stop condition, and the project lead
chose to build the worker now and take `u` up separately as a change to D-097 (§6.4).

All figures are from Windows 11, Electron 44, the built app (`npx electron-vite build`), driven by
Playwright. `spike/r239-regex-find.ts` re-runs §6.1 and §6.3.

### 6.1 The freeze, measured first

**`(a+)+$` on one 64 KB window, timed by `page.evaluate` in the renderer** (the window's last line is
`n` × `a`, then `b`):

| `n` | 16 | 18 | 20 | 22 | 24 | 26 | 30 |
|---|---|---|---|---|---|---|---|
| ms | 1.3 | 5.6 | 19.1 | 88.0 | 318.5 | 1,216.3 | **18,738.8** |

The time doubles with each extra `a`. Node takes 15.8 s for the same window through `main`'s
`findDecodedInWindow`.

**Through the Find bar, on `main`'s build**, with a 6 KB XML document whose last text line is thirty
`a` and a `b`, measured inside the page: the search ran **17,779 ms**, the longest gap between
animation frames was **17,758 ms** (starting 4 ms after "Searching…"), and there was one long task
of **17,775 ms**. The window painted nothing for the whole search.

**Criterion 1's probe cannot see that freeze.** During those 17.8 s, `page.evaluate(() => 1)`
answered in **5 ms**, and in a second run 34,643 back-to-back pings never took more than 18 ms.
Chromium serves a DevTools evaluation from inside running JavaScript, through a V8 interrupt, which is
how `Debugger.pause` reaches a wedged thread (FINDINGS). So the plan's test would have passed before
the fix. **The test measures the frame gap inside the page instead** (§6.2). On `main`'s build it
fails with *"expected 17788.4 to be less than 500"*.

### 6.2 Part A — the worker

Built as §2 says:
- `textFind.ts`: `findDecodedInWindow` is split into `prepareDecodedWindow` (decode, then R204's
  normalization) and `mapWindowMatches` (normalized index, then original index, then byte offset).
  `decodedTextMatches` sits between them, unchanged and now exported. Plain Find still runs all three
  on the main thread.
- `regexFind.worker.ts` runs `decodedTextMatches` and nothing else. It is posted the normalized text
  and the normalized needle, and returns `{ index, length }[]`.
- `regexFindJob.ts` drives one worker per search, one window at a time. Each window has a 2 s
  deadline. The worker is terminated on the deadline, on cancel (a new query, Escape, a document
  switch) and when the search finishes, so none outlives its search.
- `searchStore.ts` sends regex mode there. `SearchResult` gains `timedOut`. A worker that fails to
  load or crashes ends the search with an empty result, rather than leaving "Searching…" up forever.

**On a deadline** the notification reads *"This pattern takes too long to search with."*, and the
counter reads `No matches (stopped)`, or `3 of 1,204 (stopped)` when earlier windows found matches.

**The counter text was chosen from a rendering** (criterion 5). Four candidates were drawn in the
built app's Find bar, in both themes: `3 of 1,204+`, `… so far`, `… (stopped)` and `… · stopped`.
`+` reads as "there are more", which is not known; `so far` reads as still running. The bar widens to
fit the label, and the input keeps its width.

**Termination does stop a running `exec`.** With the app's own worker stuck in `(a+)+$`, the deadline
fired at 2.0 s. Playwright saw the worker close 1.8 s after that, not after the ~19 s the `exec` would
have taken, and the renderer's CPU was 0% from then on. The 1.8 s from `terminate()` to the close is
longer than `expect.poll`'s 1 s default, so the built-app test polls the worker count with the
suite's 5 s timeout.

**After the fix**, the same document through the Find bar: the search ran **2,011 ms** (the
deadline), the longest gap between frames was **71 ms**, and there were no long tasks over 50 ms.

| # | Criterion | Result |
|---|---|---|
| 1 | No freeze; notification within deadline + 1 s | Pass: longest frame gap under 500 ms, search ended at the 2 s deadline, notification shown. Measured as a frame gap, not with `page.evaluate` (§6.1) |
| 2 | Escape terminates the worker | Pass: Playwright's list of the page's `regexFind` workers returns to 0. Unit tests assert `liveRegexFindWorkers()` and `terminate()` too |
| 3 | Worker path equals in-thread path | Pass: 11 rows in `test/regexFindJob.test.tsx`, real worker in real Chromium, including five non-ASCII needles over decomposed text. Mutation: posting the raw decoded text turns exactly those five red |
| 4 | Cost within 1.25× at 200 MB | Pass, **faster** (§6.3). No batching needed |
| 5 | Partial results shown and labelled | Pass: kept matches, `(stopped)`, chosen from a rendering |
| 6 | §3's outcome recorded | §6.4. `u` did not land, so `\p{Lu}+` and the astral-advance tests do not apply |
| 7 | Mutation: no termination on cancel turns criterion 2 red | Pass: the browser and node cancel tests and the built-app Escape check go red. A third unit test goes red with them, because the leaked worker is still counted |
| 8 | `DECISIONS.md` amends D-041 | D-123; D-041 points to it |

### 6.3 Cost (criterion 4)

`spike/r239-regex-find.ts`, `cars-200mb.xml`, median of three. Times run from the counter showing
"Searching…" to it showing the result, so Find's 150 ms debounce is excluded:

| Pattern | Matches | `main` | R239 | Ratio |
|---|---|---|---|---|
| `\d{4}-\d{2}` (§1's baseline) | 0 | 10,033 ms | **6,871 ms** | 0.68× |
| `<year>\d{4}` | 633,268 | 12,475 ms | **9,114 ms** | 0.73× |

`\d{4}-\d{2}` finds nothing in that fixture, so `<year>\d{4}` was added to carry results back across
the worker boundary. **The worker path is faster.** Why was not measured. One difference is that the
next window starts on the worker's reply, where the chunked job waits for a `setTimeout(0)` between
slices. The longest task was 79 ms and 132 ms before, and 65 ms and 71 ms after. `cars-10mb.xml`: 494 → 383 ms
and 646 → 546 ms.

### 6.4 Part B — the `u` flag: measured, not turned on

`u` was turned on in a scratch change, for both the regex and the escaped-literal compilation, with
the zero-length and plain-mode advances stepping by code point. Of the 73 tests in `textFind.test.ts`,
`textFindConfusables.test.ts` and `textFindNormalization.test.ts`, **one changed**: the confusables
row for `ß` expected 1 match and found 2, because `/ß/iu` also finds `ẞ` U+1E9E. That is §3's stop
condition, so it went to the project lead.

**Every changed pair, measured over all 3,037 code points that case mapping or case folding touches**,
through the shipped pipeline: R204's NFC for a non-ASCII needle, and the byte path for a plain ASCII
needle. Every change is a new match; nothing stops matching.

- **Plain mode: 680 ordered pairs.**
  - `ß` ↔ `ẞ`; `ſ` U+017F finds `s` and `S`.
  - `ϴ` U+03F4 ↔ `Θ`, `θ`, `ϑ`.
  - The Greek letters with ypogegrammeni and their prosgegrammeni capitals: U+1F80–U+1FAF in pairs,
    `ᾳ`/`ᾼ`, `ῃ`/`ῌ`, `ῳ`/`ῼ`.
  - `ﬅ` ↔ `ﬆ`.
  - **614 pairs in astral scripts**, because without `u` the engine folds code units, never an astral
    letter. By range: Deseret (U+10400), Osage (U+104B0), Vithkuqi (U+10570), Old Hungarian
    (U+10C80), U+10D50, Warang Citi (U+118A0), Medefaidrin (U+16E40), U+16EA0, and Adlam (U+1E900).
- **Regex mode: the same 680, plus 4 that plain mode does not gain:** `k` and `K` find the Kelvin sign
  U+212A, and `s` and `S` find `ſ` U+017F. A plain search for an ASCII needle takes the byte path,
  which `u` does not touch. **So `u` would re-open a plain-vs-regex disagreement** for those four,
  exactly what D-097 closed, unless the byte path learned those two code points.

**`u` also rejects patterns that work today.** Each of these compiles without `u` and throws with it,
which Find shows as "No matches": `\-`, `\_`, `\:`, `\#`, `\@`, `\%`, `\=`, `\!`, `\,`, `\"`, `\'`,
`\<`, `\ ` (and any other escaped non-syntax character), a lone `]`, `}` or `{`, `a{`, `{,2}`,
`[a-\d]`, `[\w-x]`, `\1` without a group, `\8`, `\c`, `\x4` and `\k`. And `.` over an astral
character counts one match instead of two.

**Decided by the project lead, 2026-10-19:** the worker lands without `u`, and `u` is taken up
separately as a change to D-097. Nothing in this round depends on it.

### 6.5 Review

Each part's diff was read before the commit. Found and fixed:
- **In `searchStore.ts`, the new `FindValue` type had been inserted between `FindJobOutcome` and its
  doc comment**, which then described the wrong type. Moved above it.
- **The deadline test first used fake timers and hung**, leaking a live worker into the next two
  tests' counts. It now uses real timers with a 50 ms deadline; the browser test covers the real 2 s
  path against a real worker.
- **The built-app test's first version used the plan's `page.evaluate(() => 1)` probe**, which the
  measurement in §6.1 showed would pass against `main`'s build too. It was rewritten to measure the
  frame gap, and run against both builds: it fails on `main`'s and passes on this one.
