# R192 — a hung job runs for six hours

<!-- status: built -->

**Built.** Neither workflow set `timeout-minutes`, so every job inherited GitHub's default of
**360 minutes**. Observed on PR #30: a Windows job burned **6h00m13s** and was killed by that
ceiling.

**Now 25 minutes for `ci.yml`, 30 for `release.yml`'s matrix, 10 for `checksums`** — every job in
both workflows, none below 2.9× its slowest observed run. **This bounds the cost of the hang and
does not fix it**; § 2 is explicit about that and R187's Owed entry still stands.

## 1. What happened

The job ran the full suite. **All 166 test files reported ✓, zero failures**, including the two
this round's sibling added. Then Vitest never printed its summary line and never exited:

```
2026-09-10T20:14:04  ✓ node test/wheelDelta.test.ts (3 tests) 3ms
2026-09-11T02:06:26  ##[error]The operation was canceled.
```

Five hours and fifty-two minutes of silence between the last line of output and the ceiling. The
same commit passed on `ubuntu-latest` and `macos-latest` in under three minutes each, and passed on
`windows-latest` in **6m48s** when the job was re-run unchanged.

**This is a hang at teardown after a green run, not a test failure**, and R187 already owes a line
about the same shape — `npm run test:large` "exits 1 on one unhandled Vitest RPC error with all
2038 tests passing". Different command, same failure to shut down cleanly. Three hypotheses about
that one were disproved by measurement and it was left in the Owed table rather than guessed at a
fourth time.

## 2. What this round does, and what it explicitly does not

**It bounds the cost. It does not fix the hang.** Saying so plainly because the two are easy to
conflate and the round would otherwise look like it closed R187's owed item, which it does not. The
hang's cause is still unknown, and a timeout makes its *symptom* cheap rather than making it go
away.

What the ceiling costs today, all three of which the timeout fixes:

- **Six hours of a runner slot** per occurrence.
- **Six hours of latency.** The signal that something is wrong arrives after the working day it
  was meant to inform.
- **A misleading label.** `gh pr checks` reports `fail` against a job that measured nothing, which
  reads exactly like a broken branch. That is R182's argument verbatim — a red run that is an
  absence of evidence rather than evidence of a defect.

## 3. The value

Measured across the last 20 runs of each workflow, successful jobs only:

| workflow | job | n | min | median | max |
|---|---|---|---|---|---|
| `ci.yml` | `windows-latest` | 16 | 6.5 | 7.0 | **8.6** |
| `ci.yml` | `macos-latest` | 14 | 1.4 | 2.8 | 3.9 |
| `ci.yml` | `ubuntu-latest` | 16 | 2.0 | 2.5 | 2.9 |
| `release.yml` | `windows` | 1 | — | — | 8.2 |
| `release.yml` | `linux` | 2 | 3.6 | — | 4.2 |
| `release.yml` | `macos-intel` | 2 | 2.6 | — | 4.2 |
| `release.yml` | `macos-apple-silicon` | 2 | 2.8 | — | 3.0 |

**`ci.yml`: 25 minutes. `release.yml`: 30.** That is **2.9×** the slowest job ever observed in
either, and 12–14× below the 360 it replaces.

**Deliberately generous, and the asymmetry is the point.** A cap that is too tight manufactures a
new flake class — the exact thing this project spent R183–R186 removing — and it would arrive
disguised as the failure it was meant to catch. A cap that is too loose merely bounds the damage
less well. The two errors are not symmetric, so the value is sized against the slowest observation
with a wide margin rather than against the median with a tight one.

**One value per workflow, not one per platform**, even though Windows is three times slower than
the other two. `ci.yml` already argues this in its own comments — *"Everything from here to the
test step runs identically on all three, with no `if:`, deliberately: an asymmetric matrix leaves
steps that only ever execute on one OS, which is the exact shape of the problem R151 exists to
close."* A per-platform ceiling is that same asymmetry in a new field, in exchange for nothing: the
purpose is catching a hang, and a hang is unbounded on every platform.

**Job-level rather than step-level.** The hang was in the test step this time, but `npm ci`, a
Playwright download and `electron-builder --dir` can each stall on a network, and a step-level
timeout guards only the step someone thought of. The job is the unit that has a runaway cost.

## 4. Both workflows, not just the one that failed

`release.yml` has the same exposure and a worse consequence: its jobs publish to a draft release,
and the `checksums` job `needs: release`, so one hung matrix leg holds up the assets for all four.
Guarding only `ci.yml` because that is where the failure happened to land is precisely what R182
names — *"the exposure is two steps, not one, so a fix guarding only the Playwright step would be
one reordering away from the same failure."*

`checksums` gets **10 minutes**: it downloads the release assets, hashes them and uploads one file.

## 5. Acceptance

1. Every job in both workflows carries `timeout-minutes`.
2. No value is below 2.5× the slowest successful run of that job observed in § 3.
3. Both workflows parse and run — verified by this branch's own CI, since an invalid workflow file
   fails at the GitHub end rather than in any test.
4. `npm test` unaffected (no source or test file changes).

## 6. Version

**No bump.** CI configuration; nothing shipped changes.

---

## 7. Results

**Landed as planned**, three values across two files and nothing else touched.

| workflow | job | before | after | ratio to slowest observed |
|---|---|---|---|---|
| `ci.yml` | `ci` (×3 platforms) | 360 (inherited) | **25** | 2.9× |
| `release.yml` | `release` (×4) | 360 (inherited) | **30** | 3.7× |
| `release.yml` | `checksums` | 360 (inherited) | **10** | — |

Both files parse, and every job in both carries a value — checked by loading them with the
`js-yaml` already in the dev tree rather than by reading them, since a workflow with a YAML error
fails at the GitHub end and would have been discovered by pushing.

### Review

Found one defect, in a comment rather than in the change: the new block said the matrix-asymmetry
argument it defers to lives "below the checkout", where it actually sits on the
`npm run typecheck` step. Corrected to name the step. A wrong pointer in a comment is the thing
R182 had to fix in this same file when its "exactly two Linux-only steps" count went stale, and it
costs nothing to get right while the change is still open.

Nothing else. No source or test file changed, so `npm test` is untouched.

### Owed

**Nothing by this round** — but it deliberately leaves R187's owed item open, and adds a second
observation to it: a Vitest run that goes green and then fails to exit, now seen in the default
suite on `windows-latest` as well as under `test:large`. What has changed is the cost, not the
diagnosis. A `fail` in `gh pr checks` against a six-hour job that measured nothing is a far more
misleading signal than a confusing exit code, and it is now bounded at 25 minutes.
