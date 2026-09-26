/**
 * R219 (`docs/plans/R219-open-with.md` §3): which of a process's command-line
 * arguments are files Klados was asked to open — "Open with" on Windows and
 * Linux runs `Klados "<path>"`. Pure, so the rules are tested without a
 * process: `main/index.ts` supplies the real `argv`, working directory and
 * `stat`.
 *
 * **Defensive by construction**, since this is the one place a path reaches
 * Klados from outside the Open dialog and drag-and-drop:
 *
 * - the executable is skipped, and under `electron .` (`process.defaultApp`)
 *   the app path too — else a development launch of `out/main/index.js`
 *   would open the entry script as a document. **By position among the
 *   non-switch arguments, not by index**: a first instance sees
 *   `[electron, app, --switch, file]`, but `second-instance` delivers the
 *   second one's command line with Chromium's switches moved first —
 *   `[electron, --switch, --allow-file-access-from-files, app, file]`,
 *   measured — so `argv[1]` is not the app there;
 * - every argument starting with `-` is skipped: Chromium's and Electron's own
 *   switches, including the ones a second instance's `argv` carries. A path
 *   the shell supplies is absolute and cannot start with one;
 * - what remains is resolved against the launching process's working
 *   directory and kept only if it is an existing regular file.
 */
import { isAbsolute, resolve } from 'path'

export interface LaunchPathOptions {
  /** `process.defaultApp`: launched as `electron <app path>`, so the first
   * argument that is not a switch is the app, not a file. */
  readonly defaultApp: boolean
  /** The directory a relative argument is relative to — the launching
   * process's, which for a second instance is not this one's. */
  readonly workingDirectory: string
  /** Whether `path` is an existing regular file. */
  readonly isFile: (path: string) => boolean
}

export function launchPathsFrom(
  argv: readonly string[],
  { defaultApp, workingDirectory, isFile }: LaunchPathOptions
): string[] {
  const paths: string[] = []
  let appPathSkipped = !defaultApp
  for (const arg of argv.slice(1)) {
    if (arg.length === 0 || arg.startsWith('-')) continue
    if (!appPathSkipped) {
      appPathSkipped = true
      continue
    }
    const path = isAbsolute(arg) ? arg : resolve(workingDirectory, arg)
    if (isFile(path) && !paths.includes(path)) paths.push(path)
  }
  return paths
}
