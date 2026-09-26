/**
 * R220 (`docs/plans/R220-file-error-messages.md` § 1) — Save and Save As
 * discarded their outcome, so a save that failed said nothing at all: the
 * plan's own route table assumed a notification that did not exist. The
 * commands now raise one with the outcome's sentence; a cancelled Save As
 * (the dialog closed) stays silent, as it is the user's own choice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCommand, type AppContext } from '../src/renderer/commands/registry'
import { getContext } from '../src/renderer/commands/context'
import {
  getPushedNotifications,
  resetNotificationsForTests
} from '../src/renderer/notifications/notificationStore'
import type { DocumentSession } from '../src/renderer/session/documentSession'
import '../src/renderer/session/commands'

afterEach(() => resetNotificationsForTests())

/** Runs `id` against a session whose save resolves to `outcome`, and waits
 * for the command's own handling of it rather than for a duration. */
async function run(
  id: 'klados.document.save' | 'klados.document.saveAs',
  outcome: { ok: boolean; message?: string; cancelled?: boolean }
): Promise<void> {
  const command = getCommand(id)
  if (command === undefined) throw new Error(`${id} is not registered`)
  let settled!: () => void
  const done = new Promise<void>((resolve) => (settled = resolve))
  const answer = vi.fn().mockImplementation(async () => {
    queueMicrotask(() => queueMicrotask(() => settled()))
    return outcome
  })
  const session = { save: answer, saveAs: answer } as unknown as DocumentSession
  command.run({ context: getContext(), session } satisfies AppContext)
  await done
  expect(answer).toHaveBeenCalledOnce()
}

describe('a failed save is told (R220)', () => {
  it.each(['klados.document.save', 'klados.document.saveAs'] as const)(
    '%s raises an error notification with the sentence as it is',
    async (id) => {
      await run(id, { ok: false, message: "data.json can't be saved: the disk is full." })
      const pushed = getPushedNotifications()
      expect(pushed).toHaveLength(1)
      expect(pushed[0]!.severity).toBe('error')
      expect(pushed[0]!.message).toBe("data.json can't be saved: the disk is full.")
    }
  )

  it('a save that worked says nothing', async () => {
    await run('klados.document.save', { ok: true })
    expect(getPushedNotifications()).toEqual([])
  })

  it('a Save As whose dialog was closed says nothing', async () => {
    await run('klados.document.saveAs', { ok: true, cancelled: true })
    expect(getPushedNotifications()).toEqual([])
  })
})
