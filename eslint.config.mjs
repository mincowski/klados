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
  }
)
