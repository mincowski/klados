import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'

// R54 (docs/R54-signal-followups.md, D-072): `npm run lint` runs
// `eslint --max-warnings 3 .` — a ratchet, not a suppression. `prettier/prettier`
// comes in as `warn`, not `error` (see `eslintConfigPrettier` below), so with no
// `--max-warnings` the command exited 0 at any warning count; that is the exact
// mechanism that let 5,363 CRLF warnings bury 4 real errors before R47 fixed it
// (`docs/R47-repo-hygiene.md`). R47 cleared the noise; this closes the mechanism
// that let it accumulate.
//
// The 3 known, explained warnings this number accounts for are all
// `react-hooks/incompatible-library` ("Compilation Skipped: Use of incompatible
// library") on `useVirtualizer` calls in `Detail.tsx`, `Grid.tsx` and `Tree.tsx`
// — the React Compiler declines to compile a hook it can't statically analyse.
// Nothing to fix in this codebase; TanStack Virtual is doing normal things the
// compiler is conservative about, and silencing these with inline disables would
// be noise added to production files to satisfy a counter.
//
// If a later round legitimately adds a fourth known warning, raise this number
// *and* update this comment with what it is and why — a silently-bumped number
// is the same baseline problem this exists to prevent.

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'spike/**',
      'src/core/types.ts',
      '.claude/worktrees/**'
    ]
  },
  tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  eslintConfigPrettier,
  {
    rules: {
      // A parameter required by an interface (e.g. FormatModule) but unused
      // in a given implementation is conventionally named with a leading `_`.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  // R163 (`docs/plans/R159-fixed-duration-waits.md` §8): a test may not wait a
  // number of milliseconds written at the call site.
  //
  // Four rounds found this defect once each — R140's `flushReparse` (which
  // failed the v1.0.0 release build), R152's missing `waitForOverflowButtons`,
  // R154's two, R158's `mountAndDrain` — and each fixed the one instance in
  // front of it. The review that produced this rule found 58 of them across 24
  // files, and something worse than flakiness: `rawCaretSync` had **no test
  // coverage at all**, hidden behind a 250 ms sleep whose comment named the
  // debounce it was not actually waiting for. A wait that is too short does not
  // only go red; where the assertion is negative it goes green forever.
  //
  // **Two escapes, both deliberate, and the rule distinguishes them by syntax
  // rather than by trust.** `setTimeout(fn, 0)` is a macrotask hop, not a
  // duration — five legitimate uses. And a delay passed as an *identifier* is
  // allowed, because naming it is the fix: `SETTLE_MS` for a paint margin,
  // `CARET_SYNC_DEBOUNCE_MS` imported from the product for a wait that must
  // outlast a real debounce, `NO_OP_WINDOW_MS` for a negative assertion that
  // has no condition to wait for. The banned thing is the anonymous number.
  {
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name="setTimeout"][arguments.1.type="Literal"][arguments.1.value!=0]',
          message:
            'Do not wait a fixed number of milliseconds in a test. Wait for the condition: `vi.waitFor` for a predicate, `waitForQuiet`/`waitForQuietFrames` from test/support/wait.ts for quiescence. If a duration is genuinely correct — a negative assertion, or a margin that gates nothing — give it a name and pass that instead. See docs/plans/R159-fixed-duration-waits.md.'
        }
      ]
    }
  }
)
