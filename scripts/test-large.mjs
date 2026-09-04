#!/usr/bin/env node
// Cross-platform stand-in for `KLADOS_TEST_LARGE=1 vitest run`: setting an
// env var inline before a command isn't portable between POSIX shells and
// Windows cmd.exe, so this sets it in-process and spawns vitest instead.
import { spawnSync } from 'node:child_process'

const result = spawnSync('npx', ['vitest', 'run'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, KLADOS_TEST_LARGE: '1' }
})

process.exit(result.status ?? 1)
