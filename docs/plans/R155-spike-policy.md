# R155 — spikes leave a document, not a directory

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Results in §6.

A policy and its retrofit: **a spike runs on its own branch, and only its document merges.**
`docs/spikes/` is the new home; the apparatus that produced the two existing spike documents is
deleted.

---

## 1. What prompted it

Enabling Dependabot produced **25 open alerts**, and grouping them by manifest showed where they
came from:

| Manifest | Package | Alerts |
|---|---|---|
| `spike/codemirror-harness/package-lock.json` | electron | **18** |
| `spike/codemirror-harness/package-lock.json` | extract-zip | 1 |
| `package-lock.json` | fast-uri | 4 |
| `package-lock.json` | extract-zip | 1 |
| `package-lock.json` | @xmldom/xmldom | 1 |

**Nineteen of twenty-five came from a completed M0a spike**, pinning `electron ^38.2.0` in a
throwaway harness. The application's own lockfile already resolves Electron to 39.8.10 — the
highest version any of those advisories asks for — so none of it affected the shipped binaries.
The six real alerts are all build tooling (`extract-zip` under electron, `fast-uri` and
`@xmldom/xmldom` under electron-builder); the eight runtime `dependencies` are untouched.

**This is R47's finding in a new place.** That round exists because `npm run lint` exited
non-zero on four real errors buried under 5,363 CRLF warnings, and the results documents of the
time had written that off as "clean, CRLF only, the existing baseline" — which is how a tool gets
switched off. Six actionable alerts under nineteen permanent false ones is the same shape, and
Dependabot has no `.gitattributes` fix waiting: nobody is ever going to update a dead spike's
lockfile, so the noise is permanent by construction.

## 2. The rule

Recorded in `CLAUDE.md` under **Spikes**. A spike runs on its own branch; the only thing that
merges is a document in `docs/spikes/`, written for someone who cannot run the code — question,
environment, method *and why that method*, every number, and the mistakes made getting there.

**The last of those is the load-bearing one**, and it is what makes deleting the code defensible
rather than merely tidy: the code contains the fix, and only the document can contain the error.
`docs/spikes/M0a-codemirror-and-parsers.md`'s three harness bugs — a fractional byte offset that
made CodeMirror throw `"No tile at position 52428.8"` *off an internal async pass*, so the failure
surfaced nowhere near its cause; a stale `scrollTop` after a document swap; a self-inflicted hang
from fixed-pixel scroll steps — are worth more than the harness ever was. The first is generalised
in the document into a rule for any real implementation.

**Re-runnable tooling is not a spike.** The test is whether anyone will run it again.

## 3. What was verified before deleting anything

The question this round had to answer was whether the documents are sufficient on their own. Each
was checked against the apparatus it describes rather than judged by length.

**`M0a-codemirror-and-parsers.md` (905 lines)** records the environment (CPU, RAM, OS build, Node
`v24.15.0`, Electron `38.8.6`, CodeMirror `6.5.x`/`6.38.x`, 60 Hz display); the method and its
reasoning (Electron rather than a Vite page *because a browser cannot report renderer RSS*; one
process per fixture so memory is not contaminated; `lineNumbers()` only, no highlighting, history
or wrapping); the measurement's own trap (`dispatch()` → next `rAF`, so 16.7 ms is a vsync floor
and not a latency); A6's windowing primitives by name (`snapForward`, `sliceWindow`,
`buildLineIndex`, `computeOrigin`), its window sizes and its `Buffer.indexOf(0x0a)` line index; and
full result tables including the scrolling data that A5's decision table did not cover.

**`M5-H11-protocol-fetch.md`** names every scheme privilege flag, `protocol.handle`,
`stream.Readable.toWeb`, `app.getAppMetrics()`, the exact run command and all five measurements.

**`docs/plans/R31-csv-spike.md`** names each file of `spike/csv-quoted-newline/`, the seeded PRNG
(`mulberry32`), the seed (`0xc5f`), the corpus size and every edit class behind its 1,757-edit
result.

**`docs/plans/M1-RESULTS.md`** is titled *"M1 — Results (D15)"* and tabulates that family in full —
parse times, frame counts, p50/p95/max, frames over 32 ms, mean FPS, scrolling with and without
decorations, and end-to-end open times.

What none of them could do is reproduce the harnesses byte-for-byte. That is what the policy
accepts. The inputs remain producible: `spike/generate-fixtures.ts` is kept.

**One real gap, and it was closed rather than argued away.** The raw JSON held statistics the
tables did not — keystroke `min`/`max`, `readMs`, `docChars`, `lines`, `baselineRssMB`,
`finalRssMB`, `gcExposed`. No decision rested on any of them, but "no decision rested on it" is a
claim about questions already asked. All 24 files are therefore transcribed verbatim into
`docs/spikes/raw-measurements.md` before deletion — **2,691 scalar values in, 2,691 table rows
out**, checked by count and by spot value, not by eye.

## 4. What moved, what went, what stayed

**Moved** — `spike/RESULTS.md` → `docs/spikes/M0a-codemirror-and-parsers.md`;
`spike/h11-protocol-fetch/RESULTS.md` → `docs/spikes/M5-H11-protocol-fetch.md`. Both gain a
provenance note.

**Deleted** — `spike/codemirror-harness/` (48 files), `spike/h11-protocol-fetch/`,
`spike/csv-quoted-newline/`, `spike/xml-throughput.ts`, `spike/offset-shift.ts`. The last two label
themselves `THROWAWAY SPIKE CODE` in their own headers.

**Kept** — `generate-fixtures.ts` and the five per-milestone benches, with a new `spike/README.md`
saying what each measures. The directory keeps its name: renaming it would invalidate every path in
`docs/LOG.md`, `M0-PLAN.md`, `M1-RESULTS.md` and a dozen more for no gain, which is the argument
`CLAUDE.md` already makes for never renaming an `R` id.

**`spike/.gitignore` now excludes `package.json` and `package-lock.json`**, at both levels. The
policy says a spike's manifest should never be committed again; this makes a stray `npm install`
unable to reintroduce one.

## 5. References: live documents only

The split follows R144's own precedent, and the measurement made it cheap — of **28 mentions** of
the deleted paths across `docs/`, only **five** are in live documents:

- `docs/DECISIONS.md` ×2 (D-030's D15 harness note, D-047's H11 pointer)
- `docs/README.md`'s "Also here" section
- `docs/TASKS.md`'s historical-ids row for milestone `A`
- `.gitignore`'s rationale for committing `spike/`

The other 23, in `docs/LOG.md`, `M0-PLAN.md`, `M0c-PLAN.md`, `M5-PLAN.md`, `M5-RESULTS.md` and
`R31-csv-spike.md`, are **deliberately left pointing at deleted paths**. They describe what was
true when they were written, exactly as pre-R144 documents keep saying "NodePad". Rewriting settled
history to match the present is the thing this project has repeatedly decided not to do.

One rule change worth noting inside `.gitignore`: the anchored `/out/` stays anchored, but its
stated reason — that `spike/codemirror-harness/out/` had to survive — is gone. The comment now says
the anchoring is right regardless, rather than leaving a rationale that no longer refers to
anything.

## 6. Results

**Built**, exactly as planned above, with no deviations.

Verification: `docsStatus` green; typecheck, lint and the full suite green; the transcription
checked by scalar count (2,691 = 2,691) and by spot value against the original JSON; and a grep
confirming no *live* document still points into a deleted path.

**The Dependabot count is the acceptance criterion**, and it is the one thing this round cannot
verify locally — GitHub recomputes alerts when the branch merges. Expected: 25 → 6, with the
remaining six all build tooling and none of them in the shipped runtime.

**Review pass, per `CLAUDE.md`.** Read as `git diff`. One finding, fixed before commit: the initial
sweep would have deleted `spike/codemirror-harness/out/d15-*.json`, which belongs to **M1**, not
M0a — a different round, a different decision (D-030), and a different results document. It is
covered by `docs/plans/M1-RESULTS.md`, but that was checked rather than assumed, and the
transcription groups it under its own heading naming that document rather than filing it with the
M0a data it sat next to on disk.
