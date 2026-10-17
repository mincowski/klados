# R239 — a regex Find that can be stopped, and the `u` flag

<!-- status: open -->

**Open.** Planned from the review of 2026-10-16, finding 10 (low). Lowest priority of the review's
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
