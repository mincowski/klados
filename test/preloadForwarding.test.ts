/**
 * R194 — every preload method forwards every argument it is given.
 *
 * **This test exists because a shipped defect got through three other checks.**
 * `saveAsDialog` was declared in `api.ts` as `(defaultPath, filters)` and
 * implemented in `index.ts` as `(defaultPath) => invoke(channel, defaultPath)`.
 * The filters were built correctly, passed correctly by the session, and
 * dropped on the floor at the bridge — so Save As showed `*.*`, which is
 * exactly the defect R194 set out to fix.
 *
 * Why nothing caught it:
 *
 * - **TypeScript cannot.** A function of fewer parameters is assignable where
 *   more are expected — ordinary, sound function subtyping. `(a: string) => P`
 *   *is* a valid `(a: string, b: F[]) => P`. The interface in `api.ts` could
 *   never have flagged it.
 * - **The session test mocks this layer away.** `documentSession.test.ts`
 *   asserts `saveAsDialog` was called with the filters, but `saveAsDialog`
 *   there is a `vi.fn()` standing in for this module. It proves
 *   renderer → API; the defect was API → IPC.
 * - **R51's surface test checks shape, not arity.** It asserts the keys exist
 *   and are functions, which a one-argument implementation satisfies.
 *
 * So the seam had a type system that structurally cannot see it, and tests on
 * both sides of it. This closes it for every method at once rather than for
 * the one that broke: a dropped argument anywhere in the bridge fails here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(() => Promise.resolve(undefined))
const send = vi.fn()
const exposed = new Map<string, unknown>()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value)
  },
  ipcRenderer: { invoke, send, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: () => 'C:/x' }
}))

type Api = Record<string, Record<string, unknown>>

let api: Api

beforeAll(async () => {
  // The module takes the `contextBridge` branch only when context isolation is
  // on, which is what the application runs with (`sandbox: true`, R166). In a
  // plain Node process the flag is absent, and the other branch assigns to
  // `window`, which does not exist here.
  ;(process as unknown as { contextIsolated: boolean }).contextIsolated = true
  await import('../src/preload/index')
  api = exposed.get('api') as Api
})

/**
 * Every method that is a straight `ipcRenderer.invoke` forwarder, with the
 * channel it uses and sentinel arguments to hand it.
 *
 * Deliberately a literal table rather than a walk of the object: a walk would
 * have to guess how many arguments each method takes, and the whole defect
 * this guards was an argument count. Adding a method here is the point — a
 * forwarder absent from this table is untested, and that is visible.
 */
const FORWARDERS: ReadonlyArray<readonly [string, string, string, readonly unknown[]]> = [
  ['keybindings', 'read', 'keybindings:read', []],
  ['keybindings', 'write', 'keybindings:write', ['contents']],
  ['document', 'openDialog', 'document:openDialog', [[{ name: 'n', extensions: ['x'] }]]],
  ['document', 'stat', 'document:stat', ['C:/a.json']],
  ['document', 'mintReadToken', 'document:mintReadToken', ['C:/a.json']],
  ['document', 'write', 'document:write', ['C:/a.json', new ArrayBuffer(4)]],
  [
    'document',
    'saveAsDialog',
    'document:saveAsDialog',
    ['C:/a.json', [{ name: 'JSON files', extensions: ['json'] }]]
  ],
  ['document', 'watch', 'document:watch', ['C:/a.json', 'tab-1']],
  ['document', 'unwatch', 'document:unwatch', ['tab-1']],
  ['titleBar', 'setOverlayColors', 'titleBar:setOverlayColors', [{ background: '#fff' }]],
  ['view', 'setZoomFactor', 'view:setZoomFactor', [1.25]]
]

describe('the preload bridge forwards every argument', () => {
  it.each(FORWARDERS)('%s.%s passes all arguments to %s', (group, method, channel, args) => {
    invoke.mockClear()
    const fn = api[group]?.[method] as ((...a: unknown[]) => unknown) | undefined
    expect(fn, `${group}.${method} is missing from the exposed api`).toBeTypeOf('function')

    fn!(...args)

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(channel, ...args)
  })

  it('declares a parameter for every argument it forwards', () => {
    // The failure mode the table above cannot see on its own: an
    // implementation that reads `arguments` or spreads would forward correctly
    // while declaring nothing. Arity is the property `api.ts` describes, and
    // it is what R51's shape test stops short of.
    for (const [group, method, , args] of FORWARDERS) {
      const fn = api[group]?.[method] as ((...a: unknown[]) => unknown) | undefined
      expect(fn!.length, `${group}.${method} declares the wrong parameter count`).toBe(args.length)
    }
  })
})
