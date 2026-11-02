// Stands in for Claude Code beneath the mod: store, clock, env, usage, UI.
// Two "sessions" can share one store Map to test cross-session behaviour.
import type { On } from 'claude-code'
import { type Engine, type MockClock, type MockSession, mock } from 'claude-code/testing'

export const HOUR = 3_600_000
export const MIN = 60_000
// 2026-11-01 06:00:00 UTC (11:30 AM in Asia/Calcutta).
export const T0 = Date.UTC(2026, 10, 1, 6, 0, 0)

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type WorldOptions = {
  now?: number
  env?: Record<string, string>
  store?: Map<string, unknown>
  sessionId?: string
  rateLimits?: RateLimit[]
  /** `$.session.usage()` throws, as when the usage source is broken. */
  usageThrows?: boolean
}


export type World = {
  clock: MockClock
  store: Map<string, unknown>
  session: MockSession
  toasts: string[]
  notifications: string[]
  spawned: string[]
  /** Usage the next model request reports. */
  nextUsage: Record<string, number> | undefined
  /** Usage every model request reports while set (parallel steps). */
  stickyUsage: Record<string, number> | undefined
  setLimits(list: RateLimit[] | 'throw'): void
  /** Every later `$.store.get` throws, as with a corrupt or locked store. */
  breakStore(): void
}

export function world(on: On, o: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: o.now ?? T0 })
  mock.env(on, o.env ?? {})
  const session = mock.session(on)
  const store = o.store ?? new Map<string, unknown>()
  let limits: RateLimit[] | 'throw' = o.usageThrows ? 'throw' : (o.rateLimits ?? [])
  let storeBroken = false
  const w: World = {
    clock,
    store,
    session,
    toasts: [],
    notifications: [],
    spawned: [],
    nextUsage: undefined,
    stickyUsage: undefined,
    setLimits(list) {
      limits = list
    },
    breakStore() {
      storeBroken = true
    },
  }
  on('store.get', ($, e) => {
    if (storeBroken) throw new Error('store unreadable')
    return { value: structuredClone(store.get(e.key)) }
  })
  on('store.set', ($, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: o.sessionId ?? 'sess-A' }))
  on('session.usage', () => {
    if (limits === 'throw') throw new Error('usage service unavailable')
    return { value: { startedAt: T0, context: { window: 200_000 }, rateLimits: limits } } as never
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  on('ui.notify', ($, e) => {
    w.notifications.push(String((e as { text: string }).text))
    return { value: { isSent: true, channel: 'test' } } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    const u = w.stickyUsage ?? w.nextUsage
    const usage = u
      ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u, model: 'claude-test' }
      : null
    w.nextUsage = undefined
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.spawn', ($, e) => {
    w.spawned.push(e.subagentType)
    return { model: 'claude-test', agentId: `agent-${w.spawned.length}` }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  return w
}

export const TYPED = { kind: 'composer' } as const

export function prompt(text: string, extra: Record<string, unknown> = {}) {
  return { text, wait: false, origin: TYPED, ...extra } as never
}

export function spawnInput(type = 'general-purpose') {
  return {
    tool_use_id: 'tu-1',
    prompt: 'do it',
    description: 'task',
    subagentType: type,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
  } as never
}

/** One model request reporting `usage`, as the engine streams it. */
export async function step($: Engine, w: World, usage: Record<string, number>, agentId?: string): Promise<void> {
  w.nextUsage = usage
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let r = await stream.next()
  while (r.done !== true) r = await stream.next()
}

export function turnDone(usage: Record<string, number> | undefined, agentId?: string) {
  return {
    turnId: 't',
    answer: '',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
    ...(usage ? { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage, model: 'claude-test' } } : {}),
    ...(agentId ? { agentId } : {}),
  } as never
}

export function measureInput(rateLimits: RateLimit[]) {
  return { context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] } as never
}

export function cmd(args: string) {
  return { command: '5h', args, origin: TYPED } as never
}

export const iso = (ms: number) => new Date(ms).toISOString()
