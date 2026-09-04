# R54–R56 — the three things R47–R50 left half-closed

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-072 (R54).

From reviewing R47–R50. That round did what it was asked and its results are accurate — verified
independently: `npm run lint` is 0 errors and exits 0, all 439 tracked files carry zero `0x0D`
bytes, `tabStrip.test.tsx` passes 13/13 alone, and all eleven plan headers are flipped with partial
status preserved.

These three are **not corrections to it.** Two are mechanisms the round cleaned up *around* without
closing, and one is a placement question its own addendum raises.

---

## R54 — the lint gate cannot fail on a warning, so R47's problem can recur

`npm run lint` is `eslint --cache . && npm run lint:css`. There is no `--max-warnings`, and
`prettier/prettier` comes in as **`warn`** from `@electron-toolkit/eslint-config-prettier`. So:

```
✖ 37 problems (0 errors, 37 warnings)      ← exit code 0
```

R49's CI gates on this command. It is green at 37 warnings, and it will be green at 370.

**This is the same failure mode R47 existed to fix.** That round's own diagnosis was that a signal
accumulates noise until people stop reading it, and that *"lint clean — CRLF warnings only, the
repo's existing baseline"* is how a tool gets switched off without anyone deciding to switch it off.
R47 removed the 5,363 warnings that had done it. It did not close the mechanism that let them
accumulate — nothing prevents the next 5,363, and now CI will be green throughout.

### The fix: clear what's clearable, then ratchet

1. **Clear the 34 auto-fixable Prettier warnings** across the 15 affected source/test files —
   `npx eslint --fix` on those files, or targeted `npx prettier --write`. **Not `npm run format`;
   see R55, which must land first or this step causes the damage R55 describes.**
2. **The 3 that remain are not formatting** — `react-hooks/incompatible-library` ("Compilation
   Skipped: Use of incompatible library") in `Detail.tsx`, `Grid.tsx` and one other, all from
   `useVirtualizer`. The React Compiler declines to compile a hook it can't analyse. Nothing to fix
   in this codebase; TanStack Virtual is doing normal things the compiler is conservative about.
3. **Add `--max-warnings 3`** to the `lint` script, so today's known-and-explained residue passes and
   warning number 4 fails.

### Why a ratchet rather than zero or an error severity

**Rejected: raising `prettier/prettier` to `error`.** It reads stricter and is worse in practice — a
formatting nit and a genuine type or hooks violation would then be indistinguishable in the output,
which is the readability problem this round is about, inverted.

**Rejected: `--max-warnings 0` today.** It requires either silencing the three
`incompatible-library` warnings with inline disables — noise added to production files to satisfy a
counter — or waiting on an upstream change nobody controls. A number with a written reason beside it
is more honest than a zero achieved by suppression.

**The ratchet has to be maintained to work.** `--max-warnings 3` is a claim that exactly three
warnings are known and explained. If a later round legitimately adds a fourth, the number moves
*and* the reason is recorded next to it in the `lint` script or `eslint.config.mjs` — that is the
whole mechanism. A silently-bumped number is the baseline problem again.

---

## R54 — Results

Built as planned, all three steps, in order.

**Step 1**: `npx eslint --fix .` cleared the 34 fixable Prettier warnings across exactly the 15
files the plan's own count predicted, with R55 already landed — run today, `npm run format`
(`prettier --write .`) would touch none of the markdown this step could otherwise have caught in the
blast radius. Diff-reviewed, not just trusted: every changed file is a pure reformat (line-wrap
joins, quote/spacing normalization) with no logic change — spot-checked `src/main/index.ts` in full,
skimmed the rest for anything past whitespace and quoting.

**Step 2**: confirmed, not just asserted, that the 3 remaining warnings are what the plan says they
are — `react-hooks/incompatible-library` on `useVirtualizer` in `Detail.tsx`, `Grid.tsx` and
`Tree.tsx` (the plan's own "and one other," named). Nothing changed here; recorded in
`eslint.config.mjs` as a comment directly above where the ratchet is exercised, per the plan's own
"the reason is recorded next to it in the `lint` script or `eslint.config.mjs`."

**Step 3**: `"lint": "eslint --cache --max-warnings 3 . && npm run lint:css"`. Verified both
directions, not just the passing one: `npm run lint` exits 0 at exactly 3 warnings (today's real
state); a temporary 4th warning (a one-line Prettier violation added to a scratch file, reverted
immediately after) made the same command print `ESLint found too many warnings (maximum: 3).` and
exit 1. The gate holds in the direction that matters — R47's own failure mode (noise accumulating
until nobody reads the signal) now fails CI (R49) rather than passing through it silently.

Full suite re-run after all three steps: 1216/1216 passing (one full-suite-only timing flake in
`documentSession.test.ts`, confirmed pre-existing and unrelated — passes standalone — the same class
of parallel-load flake R47/R48's own results already document elsewhere). `npm run typecheck` clean.

---

## R55 — `npm run format` would rewrite 51 documentation files

```
npx prettier --list-different .   →   66 files   (51 .md, 9 .ts, 6 .tsx)
```

`npm run format` is `prettier --write .`. Run today, it rewrites **every markdown document in the
repository** — `CLAUDE.md`, `DECISIONS.md`, `LOG.md`, `CONCEPT.md` and every plan file — because
Prettier normalizes `*emphasis*` to `_emphasis_`. That is 59 changed lines in `docs/LOG.md` alone,
for zero benefit, and it would make `git blame` useless on the files this project most depends on
being readable.

**This got more dangerous, not less, when R47 landed.** Before it, everything differed anyway
because of CRLF, so `npm run format` was obviously not a thing to run. Now the code is nearly clean,
the lint output shows a small tidy number of fixable warnings, and `npm run format` is the obvious
next thing to type. R54's step 1 is exactly the situation where someone reaches for it.

**Fix: a `.prettierignore` covering `*.md`** (or `docs/` plus the root markdown files), so
`npm run format` means "format the code" — which is what anyone running it intends.

State the reasoning in the file itself: **the prose in this repository is hand-wrapped and
deliberately structured**, and Prettier's markdown output is a different house style, not a more
correct one. Anyone who later wants Prettier over the docs should be reversing a stated decision
rather than discovering an unstated one.

**Land this before R54's step 1.**

---

## R55 — Results

Built as scoped. `.prettierignore` gained one `*.md` entry (with the reasoning stated inline, per
the plan) rather than `docs/` plus a root-file list — `CLAUDE.md` and `README.md` at the repo root
use the identical hand-wrapped, `**bold**`-not-`_italic_` house style every `docs/*.md` file does,
so excluding them selectively would have left the same problem at the root. The old standalone
`LICENSE.md` entry is now redundant under the blanket pattern; left in place with a note rather than
removed, so the ignore file's own history isn't rewritten for no behavioral change.

Verified, not assumed: `npx prettier --list-different .` went from **67 files** (52 `.md`, 15
`.ts`/`.tsx` — close enough to the plan's own 66/51/9/6 count that the small drift is just files
that changed in the interim, not a different problem) to exactly the **15 code files**, zero `.md`.
`npm run lint` unaffected (37 problems, 0 errors) — checked, not assumed equivalent: `npx eslint
CLAUDE.md` reports "File ignored because no matching configuration was supplied." ESLint's own
config (`eslint.config.mjs`, via `tseslint.configs.recommended`'s file globs) never matched `.md`
files in the first place, so `prettier/prettier`'s 37 warnings were always exclusively about `.ts`/
`.tsx` — markdown was never part of `npm run lint`'s surface, and `.prettierignore` only changes
what `npm run format` (`prettier --write .`) touches.

---

## R56 — two findings from R47–R50 are recorded where nobody will look

R48's addendum did exactly the right investigative work and recorded it in the right *document*.
The question is whether that document is where the next person will find it.

Both of these meet `CLAUDE.md`'s own stated bar — *a trap that will bite someone working on
something unrelated*:

- **`npm run test:large` currently fails.** A full run across every fixture takes **~21 minutes** and
  ends with **8 truncation-fuzz tests failing** on `[vitest-worker]: Timeout calling "onTaskUpdate"`
  — a worker RPC timeout, not an assertion — on the largest fixtures at the full 200-sample count.
  Confirmed pre-existing, not caused by R48c. Anyone running the exhaustive suite before publication
  hits this, and today they can only find out it is known by reading R47's results section.
- **`grep -c $'\r'` returns false zeroes in this environment**, against files independently confirmed
  to contain hundreds of `\r` bytes. R47 found this while verifying its own work and switched to
  `node -e` byte counting. That is a trap for *any* future round that tries to verify a byte-level
  claim with the shell — which is most of them.

**Fix: one line each in `docs/FINDINGS.md`**, under "Known-wrong, not yet fixed" and "Environment and
tooling" respectively, each pointing at R47's results for the full account. The detail stays where
it is; only the pointer moves to the file that is actually read before implementing.

`FINDINGS.md` is curated and has a budget. Both of these earn it: one is a command that does not work,
the other is a tool that lies.

---

## R56 — Results

Built as scoped. One line each, in the sections named: `test:large`'s worker-RPC-timeout failure
under "Known-wrong, not yet fixed" (`docs/FINDINGS.md`), the `grep -c $'\r'` false-zero trap under
"Environment and tooling." Both point at `docs/plans/R47-repo-hygiene.md` for the full account rather than
duplicating it — the detail stays in one place, only the pointer moves to the file read before
implementing.

Nothing pruned to make room — `FINDINGS.md`'s own stated budget is "roughly the length it is now,"
and two one-line additions to an already-curated file don't cross it on inspection; a future pass
that finds otherwise should prune then; inventing a cut here to justify one wasn't worth the
churn on entries this round didn't investigate.

With this, all three of R54–R56 are built — this document's own header is flipped to match, same
as R47–R50's own R50 did for itself.

---

## Addendum — CI never built the app (a fourth thing R47–R50 left open)

**Built.** Filed here, after R54–R56 landed, because it comes from the same review pass and there was
no reason to open a new `R` id for a two-line workflow change. It amends **R49**
(`docs/plans/R47-repo-hygiene.md`), whose Results now point here.

### The gap

R49's workflow ran `npm ci`, `npm run typecheck`, `npm run lint`, Playwright install, `npm test`. It
**never built the app.** `typecheck` is four `tsc --noEmit` passes; it does not invoke Vite, so
nothing in CI exercised the bundling, the worker chunk, the CSS pipeline, or electron-vite's
main/preload/renderer split. A build-only failure would have reached a user with CI green the whole
way.

**Demonstrated rather than argued.** Replacing a real icon import with a file that does not exist —

```ts
import add from '@fluentui/svg-icons/icons/definitely_not_an_icon_20_regular.svg?raw'
```

— leaves `npm run typecheck:web` **passing clean.** It has to: `tsconfig.web.json` sets
`"types": ["vite/client"]`, whose ambient `*.svg?raw` declaration types *any* such path, so the
compiler cannot tell a real asset from an imaginary one. Only the real build resolves the file.
R38 added four such imports two rounds earlier, so this is a live class of defect, not a
hypothetical one. (The experiment was reverted immediately; `git diff` confirmed clean.)

### The fix

One step, before the Playwright install:

```yaml
- run: npx electron-vite build
```

**`npx electron-vite build`, not `npm run build`**, and the reason is in the workflow as a comment:
`build` is `npm run typecheck && electron-vite build`, and typecheck already ran as its own step —
running it again would double roughly 40 s *and* report a type error under a step labelled "build",
which is exactly the failure-attribution problem separate steps exist to avoid.

Verified locally before committing: `npx electron-vite build` exits 0 and emits all three targets
(main, preload, renderer + the parse worker chunk) in ~3 s on an already-warm tree.

**Still unverified against a live GitHub Actions run**, the same disclosure R49's own Results
carry — there is no remote configured in this environment, so nothing here has ever executed on a
runner.

### Not done: the platform matrix

The same review raised that CI is `ubuntu-latest` only while `electron-builder.yml` targets Windows
(NSIS), macOS (dmg) and Linux (AppImage + snap), and that the nine `process.platform` branches in
`src/main/index.ts`, `src/preload` and `TitleBar.tsx` therefore never execute their `win32`/`darwin`
paths in CI. **The project lead's call is to leave it Linux-only for now** and revisit in the
publication round, which will need a Windows runner for packaging anyway.

Recorded here so it is a stated position rather than an accident: **Windows and macOS behaviour is
unverified by automation.** Note it cuts both ways — a Linux runner's case-sensitive filesystem
catches wrong-cased imports that pass silently on both other platforms, which is worth something on
a project developed on Windows. The known risk it does *not* cover is Windows-specific behaviour of
exactly the kind that started R47: `docs/FINDINGS.md` still records that newline style is hard-coded
to `\n` rather than detected, so a save on a CRLF document flips its line endings, and no Linux test
will ever notice.
