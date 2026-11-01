// Pure logic: no engine involved beyond the test runner.
import { describe, expect, test } from 'claude-code/testing'

import * as L from '../hooks/logic'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 10, 1, 6, 0, 0)
const cfg = (over: Partial<L.Config> = {}): L.Config => ({ ...L.DEFAULTS, ...over })
const ultra = (pct: number, at = T0): L.Limits => ({ at, sevenDay: { pct, resetsAt: T0 + 3 * 24 * HOUR } })
const max = (pct5: number, at = T0): L.Limits => ({
  at,
  fiveHour: { pct: pct5, resetsAt: T0 + 2 * HOUR },
  sevenDay: { pct: 30, resetsAt: T0 + 3 * 24 * HOUR },
})

describe('blocks', () => {
  test('a block starts now and lasts windowHours', async () => {
    const b = L.startBlock(T0, cfg())
    expect(b.endsAt - b.startedAt).toBe(5 * HOUR)
    expect(L.isActive(b, T0)).toBe(true)
    expect(L.isActive(b, T0 + 5 * HOUR - 1)).toBe(true)
  })

  test('expiry at exactly the 5-hour boundary, and rollover to a new block', async () => {
    const b = L.startBlock(T0, cfg())
    expect(L.isActive(b, T0 + 5 * HOUR)).toBe(false)
    const next = L.ensureBlock(b, T0 + 5 * HOUR + 1000, cfg())
    expect(next.startedAt).toBe(T0 + 5 * HOUR + 1000)
    expect(next.endsAt).toBe(T0 + 10 * HOUR + 1000)
    expect(L.ensureBlock(b, T0 + HOUR, cfg())).toBe(b)
  })

  test('windowHours is configurable', async () => {
    expect(L.startBlock(T0, cfg({ windowHours: 3 })).endsAt).toBe(T0 + 3 * HOUR)
  })

  test('a new block records the weekly baseline when a fresh reading exists', async () => {
    expect(L.ensureBlock(undefined, T0, cfg(), ultra(40)).weeklyBase).toBe(40)
    expect(L.ensureBlock(undefined, T0 + 10 * HOUR, cfg(), ultra(40)).weeklyBase).toBe(undefined)
  })
})

describe('concurrent sessions', () => {
  test('mergeBlock: the earliest active block wins, either order', async () => {
    const a = L.startBlock(T0, cfg(), 10)
    const b = L.startBlock(T0 + 1000, cfg(), 11)
    expect(L.mergeBlock(a, b, T0 + 2000)).toEqual(a)
    expect(L.mergeBlock(b, a, T0 + 2000)).toEqual(a)
  })

  test('mergeBlock: an expired block loses to an active one', async () => {
    const old = L.startBlock(T0 - 6 * HOUR, cfg())
    const cur = L.startBlock(T0, cfg())
    expect(L.mergeBlock(old, cur, T0 + 1)).toEqual(cur)
    expect(L.mergeBlock(old, undefined, T0 + 1)).toBe(undefined)
  })

  test('mergeBlock: the same block combines weekly fields', async () => {
    const a: L.Block = { ...L.startBlock(T0, cfg(), 10), weeklyLast: 12 }
    const b: L.Block = { ...L.startBlock(T0, cfg(), 10), weeklyLast: 14 }
    expect(L.mergeBlock(a, b, T0 + 1)?.weeklyLast).toBe(14)
  })

  test('token counters per session sum within one block', async () => {
    const A = L.addTokens(undefined, T0, 1000, T0)
    const B = L.addTokens(L.addTokens(undefined, T0, 500, T0), T0, 250, T0)
    const stale = L.addTokens(undefined, T0 - 6 * HOUR, 99_999, T0)
    expect(L.sumTokens([A, B, stale, undefined], T0)).toBe(1750)
    expect(L.addTokens(A, T0 + 1, 7, T0).tokens).toBe(7)
  })
})

describe('strategies', () => {
  test('auto: official when the 5-hour window is present (Max/Pro)', async () => {
    expect(L.selectStrategy(cfg(), max(10), T0).strategy).toBe('official')
  })

  test('auto: weekly delta when only seven_day is present (verified Ultra)', async () => {
    const s = L.selectStrategy(cfg(), ultra(10), T0)
    expect(s).toEqual({ strategy: 'weekly', available: true, degraded: false })
  })

  test('auto: tokens when there is no usage data, marked degraded', async () => {
    const s = L.selectStrategy(cfg(), undefined, T0)
    expect(s.strategy).toBe('tokens')
    expect(s.degraded).toBe(true)
  })

  test('auto: a stale snapshot counts as no data', async () => {
    expect(L.selectStrategy(cfg(), ultra(10, T0 - 6 * HOUR), T0).strategy).toBe('tokens')
  })

  test('forced modes report unavailability', async () => {
    expect(L.selectStrategy(cfg({ mode: 'official' }), ultra(10), T0).available).toBe(false)
    expect(L.selectStrategy(cfg({ mode: 'weekly' }), undefined, T0).available).toBe(false)
    expect(L.selectStrategy(cfg({ mode: 'tokens' }), max(10), T0).strategy).toBe('tokens')
  })

  test('parseRateLimits: a missing five_hour stays missing', async () => {
    const l = L.parseRateLimits([{ kind: 'seven_day', percentUsed: 42.5, resetsAt: '2026-11-04T00:00:00Z' }], T0)
    expect(l?.fiveHour).toBe(undefined)
    expect(l?.sevenDay?.pct).toBe(42.5)
    expect(L.parseRateLimits([], T0)).toBe(undefined)
    expect(L.parseRateLimits([{ kind: 'spend_limit', percentUsed: 3 }], T0)).toBe(undefined)
  })

  test('weekly delta: growth, then a weekly reset mid-block carries the spend', async () => {
    let b = L.startBlock(T0, cfg(), 40)
    b = L.observeWeekly(b, 46)
    expect(L.weeklySpent(b)).toBe(6)
    b = L.observeWeekly(b, 2) // weekly window reset
    expect(L.weeklySpent(b)).toBe(8)
    b = L.observeWeekly(b, 5)
    expect(L.weeklySpent(b)).toBe(11)
  })

  test('weekly delta: no baseline at start takes the first reading', async () => {
    let b = L.startBlock(T0, cfg())
    b = L.observeWeekly(b, 50)
    expect(L.weeklySpent(b)).toBe(0)
    b = L.observeWeekly(b, 53.5)
    expect(L.weeklySpent(b)).toBe(3.5)
  })

  test('weightedTokens weighs cache reads at 10%', async () => {
    expect(L.weightedTokens({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 })).toBe(260)
    expect(L.weightedTokens(undefined)).toBe(0)
  })
})

describe('evaluation', () => {
  const block = L.startBlock(T0, cfg(), 40)
  const at = (b: L.Block, limits: L.Limits | undefined, tokens: number, c: L.Config = cfg(), control: L.Control = {}) =>
    L.evaluate({ cfg: c, now: T0 + HOUR, block: b, limits, tokens, control })

  test('below warn is ok; warn threshold; cap at 100%', async () => {
    expect(at(L.observeWeekly(block, 45), ultra(45, T0 + HOUR), 0).level).toBe('ok')
    expect(at(L.observeWeekly(block, 52), ultra(52, T0 + HOUR), 0).level).toBe('warn')
    const capped = at(L.observeWeekly(block, 55), ultra(55, T0 + HOUR), 0)
    expect(capped.level).toBe('cap')
    expect(capped.blocks).toBe(true)
  })

  test('official uses Anthropic % against the cap and its reset time', async () => {
    const s = at(block, max(90, T0 + HOUR), 0)
    expect(s.strategy).toBe('official')
    expect(s.level).toBe('cap')
    expect(s.resetsAt).toBe(T0 + 2 * HOUR)
    expect(at(block, max(50, T0 + HOUR), 0).level).toBe('ok')
  })

  test('tokens against tokenBudget', async () => {
    expect(at(block, undefined, 9_999_999).level).toBe('warn')
    expect(at(block, undefined, 10_000_000).level).toBe('cap')
  })

  test('off and unlocked never block', async () => {
    const off = at(block, undefined, 1e9, cfg(), { offUntil: T0 + 2 * HOUR })
    expect(off.level).toBe('off')
    expect(off.blocks).toBe(false)
    const un = at(block, undefined, 1e9, cfg(), { unlockedBlock: block.startedAt })
    expect(un.level).toBe('unlocked')
    expect(un.blocks).toBe(false)
    expect(at(block, undefined, 1e9, cfg(), { unlockedBlock: 1 }).level).toBe('cap')
  })

  test('forced strategy without data: failing, blocks only when fail-closed', async () => {
    expect(at(block, undefined, 0, cfg({ mode: 'weekly' })).blocks).toBe(false)
    expect(at(block, undefined, 0, cfg({ mode: 'weekly', failMode: 'closed' })).blocks).toBe(true)
  })
})

describe('prompts that are never refused', () => {
  test('commands, meta rows and notifications pass', async () => {
    expect(L.isNewWork({ origin: { kind: 'composer' } })).toBe(true)
    expect(L.isNewWork({ origin: { kind: 'auto-continuation' } })).toBe(true)
    expect(L.isNewWork({ origin: { kind: 'composer' }, command: { name: '5h', args: '' } })).toBe(false)
    expect(L.isNewWork({ origin: { kind: 'task-notification' } })).toBe(false)
    expect(L.isNewWork({ origin: { kind: 'unclassified' } })).toBe(false)
    expect(L.isNewWork({ origin: { kind: 'composer' }, isMeta: true })).toBe(false)
  })
})

describe('timezone display', () => {
  test('Asia/Calcutta shows IST local time', async () => {
    // 2026-11-01 08:00 UTC = 1:30 PM IST
    const t = L.formatClock(Date.UTC(2026, 10, 1, 8, 0, 0), 'Asia/Calcutta')
    expect(t).toMatch(/^1:30\sPM GMT\+5:30$|^1:30\sPM IST$/)
  })

  test('formatReset adds the countdown', async () => {
    const r = L.formatReset(T0 + 2 * HOUR + 13 * 60_000, T0, 'Asia/Calcutta')
    expect(r).toMatch(/^1:43\sPM .+ \(in 2h 13m\)$/)
  })

  test('far resets name the weekday', async () => {
    expect(L.formatClock(T0 + 30 * HOUR, 'Asia/Calcutta', T0)).toMatch(/^Mon,? 5:30\sPM/)
  })

  test('invalid zones are rejected by config', async () => {
    expect(L.isValidTimeZone('Asia/Calcutta')).toBe(true)
    expect(L.isValidTimeZone('Mars/Olympus')).toBe(false)
  })
})

describe('band text', () => {
  test('idle before the first prompt of a block; full line during one', async () => {
    const block = L.startBlock(T0, cfg(), 40)
    const s = L.evaluate({ cfg: cfg(), now: T0, block, limits: ultra(40), tokens: 0, control: {} })
    expect(L.bandText(s, T0, 'Asia/Calcutta', 160, true)).toBe('5h idle · next block starts with your next prompt · weekly-Δ · wk 40%')
    expect(L.bandText(s, T0, 'Asia/Calcutta', 160)).toMatch(/^5h ░{10} 0% · resets 4:30\sPM .+ · weekly-Δ 0\/15% wk · wk 40%$/)
  })

  test('narrow widths drop trailing parts', async () => {
    const s = L.evaluate({ cfg: cfg(), now: T0, block: L.startBlock(T0, cfg(), 40), limits: ultra(40), tokens: 0, control: {} })
    expect(L.bandText(s, T0, 'UTC', 60)).not.toMatch(/wk 40%/)
  })
})

describe('config', () => {
  test('precedence: overrides > env > userConfig > defaults; invalid values ignored', async () => {
    const r = L.resolveConfig({ windowHours: 4, warnPct: 70 }, { windowHours: '3', mode: 'bogus' }, { windowHours: 2 })
    expect(r.config.windowHours).toBe(2)
    expect(r.config.warnPct).toBe(70)
    expect(r.config.mode).toBe('auto')
    expect(r.invalid).toEqual(['mode'])
  })

  test('booleans and numbers parse from env strings', async () => {
    const r = L.resolveConfig({}, { showBar: 'off', tokenBudget: '2_000_000', failMode: 'CLOSED' })
    expect(r.config.showBar).toBe(false)
    expect(r.config.tokenBudget).toBe(2_000_000)
    expect(r.config.failMode).toBe('closed')
  })
})

describe('/5h parsing', () => {
  test('verbs', async () => {
    for (const v of ['status', 'on', 'off', 'unlock', 'reset'] as const) expect(L.parseCommand(v, 'weekly').kind).toBe(v)
    expect(L.parseCommand('', 'weekly').kind).toBe('status')
    expect(L.parseCommand('fly', 'weekly').kind).toBe('error')
  })

  test('set <number> targets the active strategy budget', async () => {
    expect(L.parseCommand('set 20', 'weekly')).toEqual({ kind: 'set', key: 'weeklyBudgetPct', value: '20' })
    expect(L.parseCommand('set 5m', 'tokens')).toEqual({ kind: 'set', key: 'tokenBudget', value: '5000000' })
    expect(L.parseCommand('set 80', 'official')).toEqual({ kind: 'set', key: 'officialCapPct', value: '80' })
  })

  test('set <key> <value> and bar shortcut', async () => {
    expect(L.parseCommand('set hours 3', 'weekly')).toEqual({ kind: 'set', key: 'windowHours', value: '3' })
    expect(L.parseCommand('set tz Asia/Calcutta', 'weekly')).toEqual({ kind: 'set', key: 'timeZone', value: 'Asia/Calcutta' })
    expect(L.parseCommand('bar off', 'weekly')).toEqual({ kind: 'set', key: 'showBar', value: 'off' })
    expect(L.parseCommand('set nope 1', 'weekly').kind).toBe('error')
  })

  test('applySet validates', async () => {
    expect('error' in L.applySet({}, 'windowHours', '-1')).toBe(true)
    expect(L.applySet({}, 'windowHours', '3')).toEqual({ overrides: { windowHours: 3 } })
  })
})
