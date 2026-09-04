/**
 * M5-PLAN.md H12's token registry, pulled out of `src/main/documents.ts` so
 * the single-use + TTL logic — the entire security model for the
 * `klados-file://` read path (see that file's own doc comment) — can be
 * unit-tested directly. `src/main` has no test harness in this codebase
 * (nothing under `src/main` is tested elsewhere either); this module has no
 * Electron or Node-specific import, so it lives in `src/core` and is tested
 * like anything else there.
 */

interface PendingEntry {
  readonly path: string
  readonly mintedAt: number
}

export interface ReadTokenRegistry {
  /** Sweeps expired entries, then mints and stores a fresh token for `path`. */
  mint(path: string): string
  /** Single-use: returns the path and removes the entry, or `undefined` if
   * the token is unknown (never minted, already consumed, or swept). */
  take(token: string): string | undefined
  /** Discards any entry older than the registry's TTL. Called on every
   * mint so a registry that's never otherwise touched still bounds its
   * own growth; also exposed for a caller that wants to sweep on its own
   * schedule (a timer, a test advancing a fake clock). */
  sweepExpired(): void
}

/**
 * @param ttlMs how long an unconsumed token survives.
 * @param now clock, injectable for tests.
 * @param randomToken token generator, injectable for tests — production
 *   callers pass `crypto.randomUUID`, kept out of this module so it stays
 *   free of Node-specific imports.
 */
export function createReadTokenRegistry(
  ttlMs: number,
  now: () => number = Date.now,
  randomToken: () => string = () => Math.random().toString(36).slice(2)
): ReadTokenRegistry {
  const pending = new Map<string, PendingEntry>()

  function sweepExpired(): void {
    const cutoff = now() - ttlMs
    for (const [token, entry] of pending) {
      if (entry.mintedAt < cutoff) pending.delete(token)
    }
  }

  return {
    mint(path: string): string {
      sweepExpired()
      const token = randomToken()
      pending.set(token, { path, mintedAt: now() })
      return token
    },
    take(token: string): string | undefined {
      const entry = pending.get(token)
      if (entry === undefined) return undefined
      pending.delete(token)
      return entry.path
    },
    sweepExpired
  }
}
