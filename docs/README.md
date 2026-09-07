# The Klados documentation

This directory is the project's engineering record: what was decided, why, what it cost, and what
is still owed. It is unusually complete for a project this size, for a reason worth stating up
front — **Klados was written by AI under human supervision**, and these documents are what that
supervision consisted of. They are not a tidy retrospective written afterwards; they are the
working record, including the parts where a plan turned out to be wrong.

If you are here to *use* Klados, the top-level [`README.md`](../README.md) is the right place.
This one is for people reading the code.

## Where to start

**Read [`CONCEPT.md`](CONCEPT.md) first**, or at least §1–§3. It is the design: what the tool is,
the flat node model everything hangs off, and the constraints the rest obeys. It is long (~1,750
lines) and meant to be read by section, not end to end. §13 lists the questions still open, each
with the milestone that closes it.

Then, depending on what you came for:

| You want to know | Read |
|---|---|
| Why the code is shaped this way | [`DECISIONS.md`](DECISIONS.md) — 90 entries, each recording what was **rejected** as well as what was chosen |
| What will bite you before it bites you | [`FINDINGS.md`](FINDINGS.md) — measured facts and traps, pruned rather than appended |
| What is built, what is open, what is owed | [`TASKS.md`](TASKS.md) — the status board, and the register of every task ever allocated |
| Why a particular thing happened when it did | [`LOG.md`](LOG.md) — newest first; archaeology, not narrative |
| How a plan earns its claims | [`PLANNING.md`](PLANNING.md) — the standard a plan document is held to |

`../CLAUDE.md` is the working agreement the implementing agent follows. It is addressed to the
agent rather than to you, but it explains the conventions below better than a summary would.

## The conventions, briefly

**Every task is `R<n>`**, numbered in one continuous sequence across the whole project — not per
milestone. The letter stands for *request*. A task keeps its number forever, even if it moves
between milestones or is dropped, so `R133` in a commit message still resolves years later.
[`TASKS.md`](TASKS.md) is the register of what has been allocated.

**Plan documents live in [`plans/`](plans/)**, one per topic, named for the lowest `R` id they
cover — `R145-csv.md` covers R145–R150. The filename never changes when the range grows, so links
stay valid. Plan and results live in the same file: results are appended as a section when the work
lands, which is what stops a results document quietly contradicting its own plan.

**Two naming schemes coexist**, and this is deliberate. Milestones M0–M5c used per-milestone letters
(`M3-PLAN.md`, task ids like `F10`); everything after uses the `R` scheme above. Renaming the old
ones would invalidate every cross-reference in these files and in the commit history, for no gain.

**Each plan carries a machine-readable status marker** on line 3 — `built`, `built-caveat`, `open`,
`closed`, `superseded` — and [`TASKS.md`](TASKS.md)'s board is derived from it.
`test/docsStatus.test.ts` fails if the two disagree, if a plan has no marker, or if a
`built-caveat` has no entry in the Owed table. Status used to live in four places and one was
always stale; now it lives in one and a test enforces it.

## What "built-caveat" means, and why the Owed table exists

A round marked `built-caveat` shipped with something it owes: an acceptance criterion it could not
meet, a measurement it could not take, a gap it found and did not fix. Those are collected in
[`TASKS.md`](TASKS.md)'s **Owed** table.

That table is the most useful page here if you are evaluating whether to trust this code. It is a
list of the project's known shortcomings, written by the people who introduced them, at the moment
they decided not to fix them. Nothing hides in a `built` badge.

## A note on the history

The published repository begins at a single commit. The development history that preceded it was
removed before publication, so **short commit hashes quoted in these documents no longer resolve**
— they point into an archive that was not published. The reasoning they support is
unaffected; only the ability to run `git show` on it is gone.

You will also find phrases like *"not verified in this environment"* or *"a deliberate scope cut for
this session"*. They mean what they say: a specific working session with specific limits, recorded
rather than papered over.

## Also here

[`screenshots/`](screenshots/) holds images referenced by the documents.
[`spikes/`](spikes/) holds spike results — the document a spike leaves behind once its apparatus is
gone (R155). `M0a-codemirror-and-parsers.md` is the CodeMirror windowing work D-030 and D-031 rest
on, and `raw-measurements.md` transcribes every figure the harnesses wrote, because a decision
citing a number should let you check the number.

[`../spike/`](../spike/) is now only re-runnable measurement tooling — the fixture generator and the
per-milestone benches. It is not where spikes live.
