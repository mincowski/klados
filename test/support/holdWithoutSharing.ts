/**
 * R220 (`docs/plans/R220-file-error-messages.md` § 2) — a file another
 * program holds without sharing, as Excel holds an open CSV. Node cannot open
 * a file that way itself (it always asks Windows to share), so PowerShell
 * holds it until told to let go — on stdin, so nothing waits on a clock.
 *
 * **Windows only.** Measured there: `stat` of the held file still succeeds,
 * and `open`, a read stream and `writeFile` all fail with `EBUSY`.
 */
import { spawn } from 'child_process'

/** Holds `path` and resolves once it is held; the returned function lets go
 * and resolves once PowerShell has exited. `path` must not contain `'`. */
export async function holdWithoutSharing(path: string): Promise<() => Promise<void>> {
  if (path.includes("'")) throw new Error(`holdWithoutSharing cannot quote ${path}`)
  const holder = spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$h = [IO.File]::Open('${path}', 'Open', 'ReadWrite', 'None'); 'held'; [Console]::In.ReadLine() | Out-Null; $h.Close()`
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  )
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on('data', (chunk) => {
      if (String(chunk).includes('held')) resolve()
    })
    holder.on('exit', (code) => reject(new Error(`the holder exited early: ${code}`)))
  })
  return () =>
    new Promise<void>((resolve) => {
      holder.removeAllListeners('exit')
      holder.on('exit', () => resolve())
      holder.stdin.end('\n')
    })
}
