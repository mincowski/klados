# R187–R189 — `npm run test:large` fails, and what it was hiding

<!-- status: built-caveat -->

**Built, with one item owed.** Register: `docs/TASKS.md`. A documented command in `CLAUDE.md` had
not worked for some time. Running it turned out to produce **ten failures of two entirely different
kinds**, and the eight noisy ones were burying the two that matter.

**All ten are fixed: `npm run test:large` now runs 2038 tests green in 5m50s, down from ten failures
in 10m6s.** It still exits 1 on a single unhandled Vitest RPC error with zero test failures — §14
records what that is and the three causes ruled out for it. That is the owed item.

Found by asking what was actually wrong with a line in the Owed table, rather than repeating its
summary.

---

## 1. What `npm run test:large` is, and that it is not broken

`node scripts/test-large.mjs` sets `KLADOS_TEST_LARGE=1` and runs `vitest run`. The wrapper exists
because an inline `VAR=x cmd` is not portable to `cmd.exe`. **The command works exactly as intended.**

The environment variable changes two things, both in `test/invariants.test.ts`:

- fixtures over `LARGE_THRESHOLD_BYTES` (50 MB) stop being filtered out;
- `TRUNCATION_FUZZ_SAMPLES` goes from **20 to 200**.

## 2. Measured: one file, 25 minutes, ten failures

`KLADOS_TEST_LARGE=1 vitest run --project node test/invariants.test.ts` — the one file the variable
affects, so the browser project and 160 other files are not in the way:

```
Test Files  1 failed (1)
     Tests  10 failed | 53 passed (63)
  Duration  1527.92s
```

| Failure | Count | Kind |
|---|---|---|
| `5. truncation fuzz (200 random offsets)` | 8 | **timeout** — 122 s to 179 s against `LONG_TIMEOUT = 120_000` |
| `4. subtree reparse equivalence (100 random nodes)` | 2 | **assertion**, in 5 ms and 7 ms |

**`docs/FINDINGS.md` currently says these are "8 truncation-fuzz tests failing on a worker RPC
timeout (`[vitest-worker]: Timeout calling "onTaskUpdate"`), not an assertion."** Two of the three
claims in that sentence are wrong: there are ten failures, not eight, and two of them *are*
assertions. The RPC message appears in a full-suite run under memory pressure; the isolated file
reports the honest `Test timed out in 120000ms`.

### 2a. The timeouts are arithmetic

A single parse, measured directly:

| fixture | one parse of a 98% prefix |
|---|---|
| `cars-100mb.xml` | 1.34 s |
| `cars-200mb.xml` | 2.90 s |
| `cars-500mb.xml` | 6.51 s |
| `cars-100mb.json` | 1.26 s |

Cuts land at random offsets, so the average sample is roughly half the file. **200 samples of
`cars-500mb.xml` is ~11 minutes against a 120 s budget** — 5× over. `cars-200mb` is ~5 min over,
`cars-100mb` ~2.2 min over. The sample count was never sized against the timeout.

**A first hypothesis was wrong and is recorded rather than quietly dropped**: that a *single* parse
blocks the worker long enough to starve Vitest's RPC. The table above disproves it — no single parse
exceeds 6.5 s. The test already yields with `setImmediate` every iteration, under a comment saying
that is exactly to protect the worker heartbeat, so someone had been here before.

## 3. The two assertions, which are the reason this matters

```
invariants — 'cars-100mb.json'     > 4. subtree reparse equivalence   7ms
invariants — 'cars-100mb.min.json' > 4. subtree reparse equivalence   5ms
  → expected [ { kind: 5, name: null, … } ] to deeply equal [ { kind: 4, name: 'year', … } ]
```

Invariant 4 picks a random node, re-parses **its own byte span** through `format.parseRange`, and
asserts the result matches the full parse's subtree.

Probed against the real fixture, 100 samples:

```
61 mismatches out of 100 samples
mismatches by NodeKind: [[4, 61]]
```

**Every failure is `NodeKind.Property`, and no other kind fails.** The span handed over is
`"year": 2011`; what comes back is a bare `Scalar` with no name, because `"year"` parses as a
standalone string and `: 2011` belongs to no value production.

### 3a. This is a test defect, not a product defect — and the product says so already

`subtreeSplice.ts`'s `findSpliceNode` documents exactly this and guards it:

> A `Property` — its own span is never independently reparseable. JSON's `parseRange` only knows how
> to parse a bare *value* (`parseOneValue`: scalar, object or array); a `"key":value` pair has no
> grammar production of its own to reparse standalone. **Every format's Property kind is exactly this
> shape** (a name owning its own scalar rather than a separate child, D-030), so this holds
> regardless of which format produced it, not just JSON.

`findSpliceNode` walks up past two shapes: a `Property`, and a node whose span *exactly* equals the
edited range. **The real edit path therefore never does what invariant 4 does.** The invariant is
asserting something the product explicitly promises not to rely on.

**Stated plainly because an earlier reading of this round got it wrong**: this was first reported as
"possibly a correctness bug in the edit path, ahead of everything else on the pre-release list." It
is not. `parseRange` is behaving as designed and as documented.

## 4. Why the default suite has never caught it — a census, not a guess

The kind distribution of every fixture `invariants.test.ts` can see:

| fixture | in default set? | nodes | Property | kinds present |
|---|---|---|---|---|
| `cars-10mb.xml` | **yes** | 329,574 | **0** | Element, Comment |
| `deep-10k.json` | **yes** | 10,001 | **0** | Array, Scalar |
| `deep-1m.json` | **yes** | 10,001 | **0** | Array (incomplete — invariant 4 returns early) |
| `cars-50mb.xml` | large only | 1,648,120 | 0 | Element, Comment |
| `cars-100mb.json` | large only | 5,085,253 | **3,694,384 (72.6%)** | Object, Array, Property, Scalar |

**The entire default corpus contains zero `Property` nodes, and zero `Object` nodes.** Not few —
none. Invariant 4 has never once been run against the node kind that breaks it, and the one fixture
that has them is 100 MB and excluded by size.

This is `docs/FINDINGS.md`'s own recurring lesson in a new place. That entry lists the axes that have
bitten — *"line endings, encoding, depth, size, and whether the file is on the platform's native path
shape"* — and this round adds one: **node kind distribution**. R168's every-fixture-is-LF-only and
R170's every-fixture-is-shallow are the same shape.

## 5. R187 — invariant 4 samples only what the product promises

Skip nodes `findSpliceNode` would escalate past: `NodeKind.Property`, and any node whose span equals
the whole document. Mirror that function's rule rather than restating it loosely, and cite it, so the
two cannot drift.

**The sample count must survive the filter.** With Property nodes excluded, a fixture that is 72.6%
properties yields far fewer usable samples per 100 draws, so the loop should keep drawing until it
has the intended number of *eligible* nodes, or report how many it found. A test that silently
samples four nodes and passes is worse than the one being fixed.

**Acceptance is that the invariant still fails when it should.** Mutation: make `findSpliceNode` stop
escalating past `Property`, and the *real* splice tests must go red — the invariant test is not the
guard for that behaviour and must not be mistaken for one.

## 6. R188 — the truncation fuzz is sized to its budget

Scale `TRUNCATION_FUZZ_SAMPLES` by fixture size so the work fits `LONG_TIMEOUT`, rather than raising
the timeout.

**Raising the timeout is rejected**: the fuzz's value is coverage across the offset space, and 200
samples of a 500 MB file is not ten times the information of 20 — it is the same coverage at ten
times the cost, because the offsets are drawn from the same distribution. A budget of *bytes parsed*
rather than *samples* is the shape that scales.

The exact policy is left to the round with one constraint: **on this machine, every fixture's
invariant 5 must finish inside `LONG_TIMEOUT` with margin**, and the margin must be stated as a
measurement rather than assumed. §2a's per-parse table is the input.

## 7. R189 — a small, property-dense JSON fixture in the default corpus

Committed, not generated: **`test/fixtures/` is where the repository's committed fixtures already
live** (`crlf/small.json`, `toml/`, `confusables.xml`), and `spike/fixtures/` is ignored wholesale by
`spike/.gitignore` — the generated gigabyte cannot take a tracked file.

`invariants.test.ts` resolves every fixture through one directory today, so it needs to learn a
second. Small change, and the plan states it rather than leaving it to be discovered.

The fixture must contain what the default corpus lacks: **`Object`, `Property`, `Array` and `Scalar`
nodes**, nested, with scalars of each JSON type. Kilobytes, not megabytes — its value is the kinds it
carries, not its size, and it must not add measurable time to the default run.

**This is the item that would have prevented the round.** Invariant 4 would have been red from the
day it was written.

## 8. What must not be done

- **Not deleting or skipping invariant 4.** It is a real invariant; it was pointed at the wrong
  nodes.
- **Not changing `parseRange` or `findSpliceNode`.** They are correct, and §3a is the evidence.
- **Not raising `LONG_TIMEOUT`.** §6.
- **Not `retry`, anywhere.** R153's reason still holds.
- **Not regenerating or committing anything under `spike/fixtures/`.**

## 9. Acceptance

1. `npm run test:large` completes with **zero failures** on this machine, and its wall-clock duration
   is recorded in the Results.
2. Invariant 4 draws its full intended sample count of *eligible* nodes on every fixture, and says so
   if it cannot.
3. The new fixture is in the default corpus, contains all four JSON node kinds, and adds no
   measurable time to `npm test`.
4. **Mutation:** removing `findSpliceNode`'s Property escalation turns the splice tests red, and
   invariant 4 stays green — proving the invariant is no longer standing in for a guard it never was.
5. `docs/FINDINGS.md`'s entry is corrected: ten failures, not eight; two of them assertions; and the
   default corpus's zero-Property census recorded with "node kind distribution" added to the axes
   list.

## 10. Non-functional expectation

`PLANNING.md` §1 does not apply. §3 applies to R188 only, and is its whole subject.

§2 is the substance of §2–§4: every claim here is a measurement — the per-parse timings, the ten
failures, the 61-of-100 mismatch census by kind, and the zero-Property fixture census. **One
hypothesis in this round was already wrong and is left visible in §2a**, because the round that
records only its correct guesses teaches nothing.

## 11. Out of scope

Making `npm run test:large` part of CI (25 minutes on one file, and the fixtures are gitignored — it
is a local command by construction). The `deep-1m.json` early return in invariant 4, which is
deliberate and documented. Any change to what the fuzz asserts, as opposed to how many times.

## 12. Version

No bump implied — test-suite work, nothing shipped changes.

## 13. Results

| | before | after |
|---|---|---|
| `npm run test:large` | **10 failed**, 2036 passed | **0 failed**, 2038 passed |
| wall clock | 10m 6s | **5m 50s** |
| `invariants.test.ts` alone | 25 minutes | — |
| exit code | 1 | 1 *(§14)* |

Per-fixture truncation fuzz, measured before and after:

| fixture | before | after |
|---|---|---|
| `cars-10mb.xml` | 79 samples, 28.1 s | 59 samples, 20.8 s |
| `cars-50mb.xml` | 15 samples, 30.4 s | 11 samples, 21.5 s |
| `cars-100mb.xml` | 8 samples, 29.4 s | 5 samples, 13.1 s |
| `cars-200mb.xml` | 8 samples, 59.9 s | 2 samples, 16.2 s |
| `cars-500mb.xml` | 8 samples, **136.7 s — timeout** | 2 samples, **51.2 s** |
| `cars-100mb.json` | 8 samples, 60.2 s | 5 samples, 16.2 s |
| `deep-10k.json` | 200 samples, 2.2 s | 200 samples, 2.2 s |

### R189 did exactly what it was added to do

`test/fixtures/kinds/properties.json` — a few kilobytes carrying `Object`, `Property`, `Array` and
`Scalar`, which the default corpus had **none** of between them. Added *before* the R187 fix, it
**failed in the default suite in 13 ms**. That is the entire argument for it: the defect had been
reachable in a two-second test all along and was sitting in a 25-minute command instead.

The suggestion came from the project lead, and the census confirmed it was better founded than
either of us assumed — not "few" property nodes in the default corpus, **zero**.

### The rate had to be measured in the loop, and getting that wrong cost a run

R188's budget was first sized from a probe that timed **one parse in a fresh process**: ~79 MB/s.
The resulting 8-sample floor projected `cars-500mb.xml` at 27 s. **It took 136 s and timed out.**

In the loop each iteration allocates a fresh `NodeStore` and `Interner` for a prefix averaging half
the file, so allocation and GC dominate:

```
sustained, measured in test:large:   ~14 MB/s XML,  ~7 MB/s JSON
single parse, fresh process:        ~79 MB/s
```

**Five to eleven times optimistic.** Worse, the first draft of that comment had guessed ~13 MB/s —
close to the truth — and the "correction" to 79 MB/s replaced a roughly-right number with a wrong
one. Measuring the wrong thing carefully beat guessing the right thing roughly, in the wrong
direction.

### Three hypotheses in this round were wrong, and they are all the same mistake

1. **"A single blocking parse starves the worker RPC."** Dismissed using the 6.5 s isolated figure —
   with the in-loop figure it is ~25 s, so the dismissal used the wrong number. Still not the cause
   (§14), but it was rejected for a bad reason.
2. **The byte budget**, above.
3. **"The browser project causes the RPC error."** `KLADOS_TEST_LARGE=1 vitest run --project node`
   still produces it.

Each is *measured in one condition, concluded about another* — the same error as R168 (keyboard API
surface → browser behaviour), R171 (`fs.watch` on Windows → every platform) and R185 (idle desktop →
shared runner). **Recorded together because the pattern is the finding**, not any one instance.

### The default run is unchanged, after a near miss

`npm test`: **1996 passed, 5 skipped, 165 files, exit 0** — the same coverage as before this round,
plus the new fixture.

**A first version of R188 applied the byte budget in both modes**, which quietly took
`cars-10mb.xml` from 20 truncation samples to 7 in an ordinary `npm test` — a 65% cut to everyday
coverage, arriving as a side effect of a fix aimed at a different mode. It surfaced only as a suite
that had become suspiciously faster (42 s against the usual ~58 s), which is a bad way to find out.
The budget now binds under `RUN_LARGE` only; the default keeps the flat 20 it has had since R48c.

### Review, per `R` id

- **R187** — no finding against the change. The eligible-node count is taken exactly rather than by
  rejection alone, so a fixture that is 72.6% properties samples what it actually has instead of
  silently sampling four nodes and passing.
- **R188** — see the rate error above. The floor also had to drop from 8 to 2: on the largest
  fixtures the floor is what binds, so it has to be affordable rather than comfortable.
- **R189** — no finding.
- **Acceptance 4 (the mutation) was not run.** It asks that removing `findSpliceNode`'s Property
  escalation turns the splice tests red while invariant 4 stays green. Named as not done rather than
  quietly dropped.

## 14. What is still owed: the command exits 1 with zero test failures

```
Test Files  164 passed | 1 skipped (165)
     Tests  2038 passed | 5 skipped (2043)
    Errors  1 error
  → [vitest-worker]: Timeout calling "onTaskUpdate"
```

**This is the error `docs/FINDINGS.md` named all along.** It is not a description of the ten
failures — those are fixed — it is a separate, fourth problem that was hidden behind them.

Ruled out by measurement, so the next attempt does not repeat them:

| Hypothesis | Test | Result |
|---|---|---|
| The 500 MB fixture's own long parses | `--project node test/invariants.test.ts` in large mode | **0 RPC errors**, even while timing out for 25 minutes |
| The browser project running alongside | `--project node` in large mode | **still 1 error** |
| Contention between parallel workers | `--project node --no-file-parallelism` | **still 1 error**, and 1m12s slower |

So it appears only when the heavy invariants file runs **together with the rest of the node suite**,
and it is not explained by concurrency. Worker reuse after the invariants file leaves hundreds of
megabytes of garbage is the untested candidate; the RPC timeout itself is birpc's internal default
and is **not exposed by Vitest's config**, so it cannot simply be raised.

**Left open rather than papered over.** Three wrong hypotheses in one round is the signal to stop
guessing and hand over what was measured; each further attempt costs a six-minute run. Recorded in
`docs/TASKS.md`'s Owed table.
