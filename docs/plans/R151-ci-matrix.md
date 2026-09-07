# R151–R153 — CI on every platform it ships to

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Results in §7. Three tasks, one branch, one pull request: **R151** the
three-OS matrix, **R152** a missing wait in `tabStrip.test.tsx`, **R153** a performance ratio that
CI measured at 2.02× against a 2× ceiling.

**The last two are not padding — they are what makes the first one worth having.** A merge gate
that fails two runs in four for reasons unrelated to the change teaches you to merge past it, and
a check you merge past is not a gate. This is also the first round to land under `CLAUDE.md`'s
branch-and-pull-request agreement, which is the reason a red pipeline stops being cosmetic.

---

## 1. What the pipeline does today, and the hole in it

`ci.yml` runs on `ubuntu-latest` and nothing else. `release.yml` runs four jobs (Windows, macOS ×2,
Linux) and runs the full suite on each — but it only fires on a `v*` tag, which is to say *after*
the code is on `main` and *after* a version has been committed to.

Measured over the published history — every run of both workflows, ten and four respectively:

| Commit | CI (ubuntu only) | Release (four platforms) |
|---|---|---|
| `69aadc2` | ✅ success | ❌ **failure** |
| `d6c6ff0` | ❌ **failure** | ✅ success |
| `87012f9` | ✅ success | ❌ **failure** |
| `1133cb4` | ❌ **failure** | ✅ success |

**The two disagreed on all four commits where both ran** — every time, in both directions. Green CI
carried no information about whether a release would build; red CI carried none about whether the
code was broken. A gate with that record is worse than no gate, because it is believed.

Both Release failures have the same cause, and it is the one the matrix closes: **tests failing on
a platform CI never runs.** Release #1 (`69aadc2`) was three test timeouts on Windows and macOS —
the first time the suite had executed anywhere but Ubuntu. Release #3 (`87012f9`) was a fixed 40 ms
sleep in `documentSession.test.ts` that lost its race on a Windows runner. Both were found by a
tag, at the cost of a deleted draft release and a moved tag apiece.

The two CI failures are §3 and §4 below. Neither is a real regression; both are in tests.

---

## 2. R151 — the matrix

`ci.yml` gains a `strategy.matrix` over `[ubuntu-latest, windows-latest, macos-latest]` with
`fail-fast: false` (one platform's failure must not cancel the evidence from the other two), and
`runs-on: ${{ matrix.os }}`.

Two steps become conditional, using the pattern `release.yml` already proves:

- the `apt-get install xvfb` step gets `if: runner.os == 'Linux'`
- the test step becomes a `shell: bash` conditional choosing `xvfb-run -a npm test` on Linux and
  `npm test` elsewhere

**Everything else runs identically on all three, with no `if:` — deliberately.** An asymmetric
matrix leaves steps that only ever execute on one OS, which is the precise shape of the problem
this round exists to close. The value of running `lint` on Windows is narrow but real and worth
stating exactly: `.gitattributes` normalises `* text=auto eol=lf`, so a Windows checkout is already
LF and Prettier sees what Linux sees. The Windows lint run therefore guards *that normalisation* —
which is R47's actual finding — rather than re-finding R47 itself.

**macOS is one job, not two.** `macos-latest` is arm64; `release.yml`'s Intel job exists to produce
a second *binary*, not to exercise different code, and nothing in this suite is
architecture-dependent.

Two additions while the file is open:

- **A `concurrency` group keyed on the ref, with `cancel-in-progress`.** Without it, three pushes to
  a branch under review leave nine jobs racing. This only starts mattering now that branches exist.
- **`actions/checkout` and `actions/setup-node` bumped**, in both workflows. They are pinned at
  `@v4`, which targets Node 20; every run currently carries a deprecation warning saying it is being
  forced onto Node 24. Current major is `v7` for both. Go there and let the pull request's own run
  be the verification — that is what it is for. If a major turns out to break, `v5` is the minimum
  that clears the deprecation.

**Cost.** Actions minutes are free for public repositories, so the 2× Windows and 10× macOS billing
multipliers do not apply. Wall clock is the slowest job, not the sum: Ubuntu measures 117–134 s
across ten runs. Windows will be slower — `npm ci` and the Playwright download dominate — but
Release's entire Windows job, packaging and upload included, ran 364–501 s, so this is minutes and
not tens of minutes.

**Risk is low, and measured rather than assumed: the three-platform run has already happened and
passed.** `release.yml`'s Test step is unconditional, so run #4 at `1133cb4` ran `npm test` to
completion on `windows-latest`, on `macos-latest` twice, and on `ubuntu-latest`, and all four jobs
were green. This round moves a check that already passes; it does not go looking for new failures.

---

## 3. R152 — `tabStrip.test.tsx` is missing a wait

**Not a flake to be retried — a defect in the test, and a reproducible one.** It failed on CI runs
#8 and #10, two of the last four.

`test/tabStrip.test.tsx:199` defines `waitForOverflowButtons()`, whose own comment names the
principle: *wait for what you're actually waiting for*. **Every query of `.tab-strip-scroll-btn` in
the file is preceded by it except one** — line 327, the one that fails. Lines 219, 254, 269 and 301
all wait; line 216 is a deliberate negative assertion that nothing is there yet; line 281 sits later
inside a test that already waited at 269.

The overflow buttons render only once the strip has measured itself as overflowing, which takes a
layout pass and a `ResizeObserver` callback. `openManyTabs(10)` does not wait for that, so the
assertion races it. The observed failure is `expected +0 to be 3` — zero buttons, meaning the
measurement had not happened yet, not that it produced a wrong answer.

The `describe` block holding it (`TabStrip icons and scroll feel (R38)`) was added after the helper
and never picked it up.

**Fix:** `await waitForOverflowButtons()` after `openManyTabs(10)`, matching the other five sites.
Same class as R140's `flushReparse` correction, and the same lesson twice in two rounds.

---

## 4. R153 — a 2× ratio that CI measured at 2.02×

`test/namespaceResolution.test.ts:131`:

```ts
expect(namespaced).toBeLessThan(Math.max(plain * 2, plain + 20))
```

CI run #10: `expected 650.3867979999995 to be less than 642.3825140000008`. The active ceiling is
`plain * 2`, so `plain` was 321.19 ms and the measured ratio was **2.024** — over by 1.2%.

Its own comment calls this *"a generous ratio, not a tight budget… not a precise number CI hardware
variance would make flaky."* On a contended shared runner it is not generous enough. R141 raised the
*timeout* wrapped around this test, in `vitest.config.ts`, and did not revisit the *ratio* inside
it.

**Raising a performance ceiling is exactly the move that hides a real regression**, and `CLAUDE.md`'s
review checklist names that failure mode, so the justification has to be about what a regression
would look like rather than about this run being close. What the assertion guards is that no
per-node namespace resolution leaked into the declaration-free fast path. Per-node work on a
150,000-node document does not cost 2% — it costs a multiple. **A ceiling of 3× still fails loudly
for the defect, and stops failing for runner noise.** The additive `plain + 20` arm stays as it is;
it only governs the small-input case.

**Rejected: Vitest's `retry`.** It would turn both R152 and R153 green in one line, and it would
have hidden R152's missing wait completely — converting a reproducible defect into an intermittent
one is the opposite of what a gate is for.

---

## 5. Acceptance criteria

1. `ci.yml` runs on `ubuntu-latest`, `windows-latest` and `macos-latest`, with `fail-fast: false`.
2. xvfb is installed and wraps the suite on Linux only; the other two run `npm test` directly.
3. All three jobs are green on the pull request that introduces them.
4. `concurrency` cancels superseded runs on the same ref.
5. Both actions are bumped in **both** workflow files, and no Node-20 deprecation warning appears in
   the run.
6. No query of `.tab-strip-scroll-btn` in `test/tabStrip.test.tsx` lacks a preceding
   `waitForOverflowButtons()`, except the negative assertion at line 216.
7. The namespace ratio is 3×, with §4's reasoning recorded in the comment rather than a bare number
   change.
8. `test/tabStrip.test.tsx` passes ten consecutive isolated local runs — the standard R140 applied
   to `flushReparse`, since a race that fails half the time on CI can easily pass once locally.

## 6. Deliberately not in scope

- **Branch protection.** A repository setting rather than a file, so it cannot land in this pull
  request. Recommended separately once the three checks are green and named: require them, and keep
  administrator bypass so a README typo does not need a branch.
- **Caching the Playwright browser download.** It is a real share of the ~120 s, but there is
  nothing to compare against until the matrix exists and Windows and macOS have baselines.
- **Intel macOS in CI** — see §2.
- **`release.yml`'s platform list**, which is already correct; only its action versions change.

---

## 7. Results

**Built.** Also the first round to land under `CLAUDE.md`'s branch-and-pull-request agreement, which
was written in the same branch — `r151-ci-matrix`, two commits, squash-merged.

**R151 — as planned, with one deviation taken deliberately.** `ci.yml` runs a three-entry matrix
(`ubuntu-latest`, `windows-latest`, `macos-latest`), `fail-fast: false`, `name: ${{ matrix.os }}`,
and a `concurrency` group on `github.ref` with `cancel-in-progress`. Exactly two steps are
Linux-only — the xvfb install and the `xvfb-run` wrapper — both keyed on `runner.os`, matching the
pattern `release.yml` already proves on Windows. Everything else runs unconditionally on all three.

The deviation: both actions went to **`@v7`, not the `@v5` §2 named as a floor**, after reading the
breaking changes rather than assuming them. `checkout@v6` moved credentials to a separate file and
`v7` blocks fork checkouts under `pull_request_target`/`workflow_run` — neither mechanism is used
here. `setup-node`'s v5, v6 and v7 breaks are all about *automatic* package-manager cache detection,
which this workflow overrides with an explicit `cache: npm`; v7 additionally migrated to ESM
internally. Both workflow files were bumped. Both parse under `js-yaml`.

**R152 — the plan made an assumption that needed checking, and it held.**
`waitForOverflowButtons()` waits for `length !== 0`, while the assertion it now guards wants
`length === 3`. The fix is therefore only correct if the three buttons can never appear separately.
Verified in `TabStrip.tsx` rather than assumed: all three are gated on the **same**
`overflow.overflowing` boolean within one render (lines 310, 329, 343), so they mount atomically and
no intermediate state of one or two exists. Waiting for any is sufficient for three.

Ten consecutive isolated runs of `tabStrip.test.tsx`: **10/10 pass, 15 tests each**. That is the
acceptance standard rather than proof the race is closed — the test never failed locally, only on
CI, which is the whole of §3's argument.

**R153.** The ratio is 3×, with §4's reasoning in the comment rather than a bare number change. The
guarded case measures 2.2 s locally.

**Review pass, per `CLAUDE.md` — three things checked mechanically rather than by eye**, since all
three are exactly the kind that reads correct and is not:

1. Both workflow files parse, and the parsed matrix is the intended one (`js-yaml`, not inspection).
2. **Every** `.tab-strip-scroll-btn` query in `tabStrip.test.tsx` now has a preceding
   `waitForOverflowButtons()` — enumerated by script, not read. The two that do not are the helper's
   own polling loop (line 201) and the deliberate negative assertion that nothing has appeared yet
   (line 216).
3. `typecheck` and `lint` clean; `lint` sits at its pre-existing 3 warnings against a
   `--max-warnings 3` ceiling, unchanged by this round.

**One thing noted and not fixed.** `cancel-in-progress` applies to `main` as well as to branches, so
two merges landing in quick succession leave the first `main` run showing *cancelled* rather than a
result. Harmless today; it would matter if `main` runs were ever used as release evidence, which
they are not — `release.yml` re-runs the whole suite itself.

**What this round cannot verify locally, by construction.** Criteria 3 and 5 — three green jobs, and
no Node-20 deprecation warning — are properties of the pull request's own run and of nothing else.
That is not a gap in the verification; it is the round's entire point.
