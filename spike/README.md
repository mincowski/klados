# `spike/` — measurement tooling

**Despite the name, no spikes live here any more.** R155
(`docs/plans/R155-spike-policy.md`) moved spike *results* to `docs/spikes/` and deleted the
apparatus that produced them. What is left is re-runnable tooling that later rounds still
cite and occasionally still run.

The directory keeps its name deliberately: renaming it would invalidate every path in
`docs/LOG.md`, `M0-PLAN.md`, `M1-RESULTS.md` and a dozen other historical documents for no
gain — the same argument `CLAUDE.md` makes for never renaming an `R` id.

| File | What it is |
|---|---|
| `generate-fixtures.ts` | The fixture generator behind `npm run fixtures:generate`. Writes ~1 GB of deterministic XML/JSON into `spike/fixtures/` (gitignored). Everything below reads from it, and so does `npm run test:large`. |
| `m2-e10-measure.ts` | M2 E10 — grid detection and column collection cost, plus peak RSS through a single read. |
| `m3-bench.ts` | M3 F10 — the measurement pass for that round. |
| `m4-bench.ts` | M4 G10 — likewise. |
| `m5-bench.ts` | M5 H10 — likewise. `docs/LOG.md` cites `m5-bench.ts h2c-worker` as reproducing a 2.84× figure exactly. |
| `csv-bench.ts` | R150 — CSV store-to-file multipliers at several widths, and parse time at scale. |

These are standalone: run them with `npx tsx spike/<file>.ts`. None is wired into
`npm test`, none has tests of its own, and all of them need the generated fixtures to exist
first. They are excluded from ESLint and Prettier (`eslint.config.mjs`, `.prettierignore`).

## Running a spike

Don't add one here. Per `CLAUDE.md`'s **Spikes** section: a spike runs on its own branch,
and the only thing that merges is a document in `docs/spikes/` — because the code is
throwaway by definition and, left in the repository, it goes on generating dependency
alerts and stale references for years afterwards. R155 exists because that had already
happened.

If a spike produces something genuinely re-runnable, it can land here — but that makes it
tooling, and it needs a row in the table above saying what it measures.
