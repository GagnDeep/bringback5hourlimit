// The real hooks module driven through the engine's test host.
import type { On } from 'claude-code'
import { type Engine, describe, expect, test } from 'claude-code/testing'

import { HOUR, MIN, T0, cmd, iso, measureInput, prompt, spawnInput, step, world } from './world'

const ULTRA = (pct: number) => [{ kind: 'seven_day', percentUsed: pct, resetsAt: iso(T0 + 3 * 24 * HOUR) }]
const MAX = (pct5: number) => [
  { kind: 'five_hour', percentUsed: pct5, resetsAt: iso(T0 + 2 * HOUR) },
  { kind: 'seven_day', percentUsed: 30, resetsAt: iso(T0 + 3 * 24 * HOUR) },
]
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as never
const TZ = { BB5H_TIMEZONE: 'Asia/Calcutta' }

describe('verified Ultra (weekly window only)', () => {
  test('allows below the budget, warns at 80%, refuses prompts and agents at the cap', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40), env: TZ })
    await $.session.start(START)

    const first = await $.prompt.submit(prompt('hello'))
    expect(first.drop).toBe(undefined)
    expect(w.store.get('block')).toEqual(expect.objectContaining({ startedAt: T0, endsAt: T0 + 5 * HOUR, weeklyBase: 40 }))

    await w.clock.advance(30 * MIN)
    w.setLimits(ULTRA(52)) // +12 of 15 = 80%
    await $.session.measure(measureInput(ULTRA(52)))
    expect(w.toasts.some(t => /budget at 80%/.test(t))).toBe(true)
    expect((await $.prompt.submit(prompt('still ok'))).drop).toBe(undefined)
    expect((await $.agent.spawn(spawnInput())).deny).toBe(undefined)

    w.setLimits(ULTRA(55)) // +15 = 100%
    await $.session.measure(measureInput(ULTRA(55)))
    const refused = await $.prompt.submit(prompt('more'))
    expect(refused.drop).toMatch(/limit is reached/)
    expect(refused.drop).toMatch(/15% of your week \(budget 15%\)/)
    // 06:00 UTC + 5h = 11:00 UTC = 4:30 PM IST
    expect(refused.drop).toMatch(/Resets 4:30\sPM (IST|GMT\+5:30) \(in 4h 30m\)/)
    const agent = await $.agent.spawn(spawnInput())
    expect(agent.deny).toMatch(/New agent not started/)
    expect(w.notifications.length).toBe(1)
  })

  test('background notifications and slash commands still pass at the cap', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    await $.prompt.submit(prompt('start'))
    w.setLimits(ULTRA(60))
    await $.session.measure(measureInput(ULTRA(60)))
    expect((await $.prompt.submit(prompt('x', { origin: { kind: 'task-notification' } }))).drop).toBe(undefined)
    expect((await $.prompt.submit(prompt('/5h status', { command: { name: '5h', args: 'status' } }))).drop).toBe(undefined)
    expect((await $.prompt.submit(prompt('x'))).drop).toMatch(/limit is reached/)
  })

  test('the block expires at 5 hours and the next prompt starts a fresh one', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    await $.prompt.submit(prompt('start'))
    w.setLimits(ULTRA(60))
    await $.session.measure(measureInput(ULTRA(60)))
    expect((await $.prompt.submit(prompt('x'))).drop).toMatch(/limit is reached/)
    await w.clock.advance(5 * HOUR)
    const after = await $.prompt.submit(prompt('new block'))
    expect(after.drop).toBe(undefined)
    // The 5-hour-old reading is too old to anchor the new block...
    expect(w.store.get('block')).toEqual(expect.objectContaining({ startedAt: T0 + 5 * HOUR }))
    expect((w.store.get('block') as { weeklyBase?: number }).weeklyBase).toBe(undefined)
    // ...the first fresh reading does.
    await $.session.measure(measureInput(ULTRA(60)))
    expect(w.store.get('block')).toEqual(expect.objectContaining({ startedAt: T0 + 5 * HOUR, weeklyBase: 60 }))
  })

  test('a mid-turn cap appends one wrap-up note instead of killing the turn', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    await $.prompt.submit(prompt('start'))
    await $.turn.start({ text: 'start', turnId: 't1' } as never)
    w.setLimits(ULTRA(56))
    await $.session.measure(measureInput(ULTRA(56)))
    await $.session.measure(measureInput(ULTRA(57)))
    const notes = w.session.appended().filter(r => JSON.stringify(r.message).includes('Finish the step in progress'))
    expect(notes.length).toBe(1)
    const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect((ran as { deny?: string }).deny).toBe(undefined)
  })
})

describe('official 5-hour window present (Max / Pro / unverified Ultra)', () => {
  test('applies the cap to Anthropic\'s own 5-hour %, with its reset time', async ($, on) => {
    const w = world(on, { rateLimits: MAX(50), env: TZ })
    await $.session.start(START)
    expect((await $.prompt.submit(prompt('a'))).drop).toBe(undefined)
    w.setLimits(MAX(91))
    const r = await $.prompt.submit(prompt('b'))
    expect(r.drop).toMatch(/Anthropic 5h at 91% \(cap 90%\)/)
    expect(r.drop).toMatch(/Resets 1:30\sPM/) // 08:00 UTC
  })
})

describe('no usage data (offline / API changed)', () => {
  test('falls back to local token counts against the token budget', async ($, on) => {
    const w = world(on, { env: { BB5H_TOKEN_BUDGET: '100000' } })
    await $.session.start(START)
    expect((await $.prompt.submit(prompt('a'))).drop).toBe(undefined)
    await step($, w, { input_tokens: 50_000, output_tokens: 10_000 })
    await step($, w, { output_tokens: 30_000 }, 'agent-1')
    expect((await $.prompt.submit(prompt('b'))).drop).toBe(undefined)
    await step($, w, { cache_read_input_tokens: 100_000 })
    const r = await $.prompt.submit(prompt('c'))
    expect(r.drop).toMatch(/100k of 100k tokens/)
    const status = await $.command.run(cmd('status'))
    expect(status.text).toMatch(/tokens counted on this machine \(Anthropic sent no usage data, so this is an estimate\)/)
  })

  test('mode=tokens budgets by tokens even when percentages exist', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(10), env: { BB5H_MODE: 'tokens', BB5H_TOKEN_BUDGET: '1000' } })
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    await step($, w, { output_tokens: 1000 })
    expect((await $.prompt.submit(prompt('b'))).drop).toMatch(/1k of 1k tokens/)
  })
})

describe('detection', () => {
  test('between whole weekly points the bar moves with tokens, marked ≈, and stays under the next point', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    await step($, w, { output_tokens: 1_000_000 }) // 0.25 of a point at the 4M prior
    let s = (await $.command.run(cmd('status'))).text ?? ''
    expect(s).toMatch(/^5h limit: ≈1% used/) // 0.25 of a point / 15
    expect(s).toMatch(/used ≈0\.3% of your week \(0% reported \+ ≈0\.3% estimated from tokens/)
    await step($, w, { output_tokens: 50_000_000 })
    s = (await $.command.run(cmd('status'))).text ?? ''
    expect(s).toMatch(/^5h limit: ≈6% used/) // capped at 0.95 of a point
    expect(s).toMatch(/used ≈1% of your week/)
  })

  test('learns tokens per weekly point from tick to tick, never from the first partial tick', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    await step($, w, { output_tokens: 300_000 })
    w.setLimits(ULTRA(41))
    await $.session.measure(measureInput(ULTRA(41))) // first tick after baseline: partial, ignored
    expect(w.store.get('calibration')).toBe(undefined)
    await step($, w, { output_tokens: 2_000_000 })
    w.setLimits(ULTRA(42))
    await $.session.measure(measureInput(ULTRA(42))) // a whole point took 2M
    expect(w.store.get('calibration')).toEqual({ tokensPerPct: 2_000_000, samples: 1 })
    await step($, w, { output_tokens: 1_000_000 })
    const s = (await $.command.run(cmd('status'))).text ?? ''
    expect(s).toMatch(/2% reported \+ ≈0\.5% estimated/) // 1M at the learned 2M per point
  })

  test('an unchanged polled reading does not pass as fresh after a long idle', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    const at0 = (w.store.get('limits') as { at: number }).at
    await w.clock.advance(6 * HOUR)
    await $.command.run(cmd('status')) // polls $.session.usage(): same figures
    expect((w.store.get('limits') as { at: number }).at).toBe(at0)
    expect((await $.command.run(cmd('status'))).text).toMatch(/estimate/) // stale → token fallback
  })

  test('a weekly window past its reset time is not trusted', async ($, on) => {
    const stale = [{ kind: 'seven_day', percentUsed: 90, resetsAt: iso(T0 - MIN) }]
    world(on, { rateLimits: stale })
    await $.session.start(START)
    expect((await $.command.run(cmd('status'))).text).toMatch(/tokens counted on this machine/)
  })
})

describe('two concurrent sessions share one block', () => {
  test('session B joins A\'s block and sees A\'s tokens', async ($, on) => {
    const store = new Map<string, unknown>([
      ['block', { startedAt: T0 - HOUR, endsAt: T0 + 4 * HOUR, weeklyCarried: 0 }],
      ['tok:sess-A', { blockStart: T0 - HOUR, tokens: 900, at: T0 - MIN }],
    ])
    const w = world(on, { store, sessionId: 'sess-B', env: { BB5H_TOKEN_BUDGET: '1000' } })
    await $.session.start(START)
    expect((await $.prompt.submit(prompt('b1'))).drop).toBe(undefined)
    expect(w.store.get('block')).toEqual(expect.objectContaining({ startedAt: T0 - HOUR }))
    await step($, w, { output_tokens: 100 })
    expect(w.store.get('tok:sess-B')).toEqual(expect.objectContaining({ blockStart: T0 - HOUR, tokens: 100 }))
    expect((await $.prompt.submit(prompt('b2'))).drop).toMatch(/1k of 1k tokens/)
  })

  test('a later block written by another session loses to the earlier active one', async ($, on) => {
    const store = new Map<string, unknown>([['block', { startedAt: T0 - 2 * HOUR, endsAt: T0 + 3 * HOUR, weeklyCarried: 0 }]])
    const w = world(on, { store, sessionId: 'sess-B' })
    await $.session.start(START)
    await $.prompt.submit(prompt('x'))
    expect((w.store.get('block') as { startedAt: number }).startedAt).toBe(T0 - 2 * HOUR)
  })
})

describe('/5h commands', () => {
  const capped = async ($: Engine, w: ReturnType<typeof world>) => {
    await $.session.start(START)
    await $.prompt.submit(prompt('start'))
    w.setLimits(ULTRA(60))
    await $.session.measure(measureInput(ULTRA(60)))
  }

  test('status reports block, strategy, weekly % and reset', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40), env: TZ })
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    const s = (await $.command.run(cmd('status'))).text ?? ''
    expect(s).toMatch(/This week: 40% used, resets/)
    expect(s).toMatch(/Resets 4:30\sPM/)
    expect(w.store.get('block')).toBeDefined()
  })

  test('unlock lifts the cap once for this block; the next block enforces again', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await capped($, w)
    expect((await $.prompt.submit(prompt('x'))).drop).toMatch(/limit is reached/)
    expect((await $.command.run(cmd('unlock'))).text).toMatch(/Unlocked for this block/)
    expect((await $.prompt.submit(prompt('x'))).drop).toBe(undefined)
    expect((await $.agent.spawn(spawnInput())).deny).toBe(undefined)
    await w.clock.advance(5 * HOUR)
    await $.prompt.submit(prompt('new block'))
    await $.session.measure(measureInput(ULTRA(60)))
    w.setLimits(ULTRA(80))
    await $.session.measure(measureInput(ULTRA(80)))
    expect((await $.prompt.submit(prompt('x'))).drop).toMatch(/limit is reached/)
  })

  test('off pauses until the reset; on re-enables', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await capped($, w)
    expect((await $.command.run(cmd('off'))).text).toMatch(/Cap paused until/)
    expect((await $.prompt.submit(prompt('x'))).drop).toBe(undefined)
    expect((await $.command.run(cmd('on'))).text).toBe('Cap on.')
    expect((await $.prompt.submit(prompt('x'))).drop).toMatch(/limit is reached/)
  })

  test('set changes a budget, validates, and reset restores defaults', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await capped($, w)
    expect((await $.command.run(cmd('set 30'))).text).toMatch(/Set weeklyBudgetPct = 30/)
    expect((await $.prompt.submit(prompt('x'))).drop).toBe(undefined)
    expect((await $.command.run(cmd('set hours -2'))).text).toMatch(/Invalid value/)
    expect((await $.command.run(cmd('set hours 3'))).text).toMatch(/Set windowHours = 3/)
    expect((await $.command.run(cmd('reset'))).text).toMatch(/overrides cleared/)
    expect((await $.prompt.submit(prompt('x'))).drop).toMatch(/limit is reached/)
  })

  const ENGINE_DRAWS = (on: On) =>
    // Stands for the engine's own drawing beneath the plugin.
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      const p = e.props as { hint?: string; tail?: string }
      return <Text>{p.hint !== undefined ? `${p.hint}${p.tail ? ` ${p.tail}` : ''}` : 'engine'}</Text>
    })
  const HINT = { plugin: 'bringback5hourlimit', component: 'PromptHint', requestId: 'hint', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never
  const BAND = { plugin: 'bringback5hourlimit', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 140, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as never

  test('default placement: the bar is a band above the input; the hint line is untouched', async ($, on) => {
    world(on, { rateLimits: ULTRA(40) })
    ENGINE_DRAWS(on)
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    const band = await $.ui.mount(BAND)
    expect((await band.find({ type: 'Text', text: /0% used/ }))?.text).toBe(' 0% used')
    await band.unmount()
    const hint = await $.ui.mount(HINT)
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    await hint.unmount()
  })

  test('/5h bar toggles; /5h bar above moves it above the input, /5h bar below back', async ($, on) => {
    world(on, { rateLimits: ULTRA(40) })
    ENGINE_DRAWS(on)
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    expect((await $.command.run(cmd('bar'))).text).toMatch(/Bar hidden/)
    let hint = await $.ui.mount(HINT)
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    await hint.unmount()
    expect((await $.command.run(cmd('bar'))).text).toMatch(/Bar on \(above the prompt\)/)
    const band = await $.ui.mount(BAND)
    expect((await band.find({ type: 'Text', text: /0% used/ }))?.text).toBe(' 0% used')
    expect((await band.find({ type: 'Text', text: /week 40%/ }))?.text).toBe(' · week 40%')
    await band.unmount()
    hint = await $.ui.mount(HINT)
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    await hint.unmount()
    await $.command.run(cmd('bar below'))
    hint = await $.ui.mount(HINT)
    expect((await hint.find({ type: 'Text' }))?.text).toMatch(/^\? for shortcuts 5h limit/)
    await hint.unmount()
  })

  test('near and at the limit the hint-line bar carries ⚠ and ⛔', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    ENGINE_DRAWS(on)
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    await $.command.run(cmd('bar below'))
    w.setLimits(ULTRA(53))
    await $.session.measure(measureInput(ULTRA(53)))
    let hint = await $.ui.mount(HINT)
    expect((await hint.find({ type: 'Text' }))?.text).toMatch(/shortcuts ⚠ 5h limit █{9}░ 86% used/)
    await hint.unmount()
    w.setLimits(ULTRA(56))
    await $.session.measure(measureInput(ULTRA(56)))
    hint = await $.ui.mount(HINT)
    expect((await hint.find({ type: 'Text' }))?.text).toMatch(/shortcuts ⛔ 5h limit reached/)
    await hint.unmount()
  })

  test('unknown input prints usage', async ($, on) => {
    world(on)
    await $.session.start(START)
    expect((await $.command.run(cmd('dance'))).text).toMatch(/^Usage: \/5h/)
  })
})

describe('fail-open and fail-closed when the usage source errors', () => {
  test('auto mode degrades to tokens and says so; nothing is refused', async ($, on) => {
    const w = world(on, { usageThrows: true })
    await $.session.start(START)
    expect((await $.prompt.submit(prompt('a'))).drop).toBe(undefined)
    expect(((await $.command.run(cmd('status'))).text ?? '')).toMatch(/tokens/)
    expect(w.store.get('limits')).toBe(undefined)
  })

  test('forced weekly mode with no data, fail-open: allows with a visible warning', async ($, on) => {
    const w = world(on, { usageThrows: true, env: { BB5H_MODE: 'weekly' } })
    await $.session.start(START)
    expect((await $.prompt.submit(prompt('a'))).drop).toBe(undefined)
    expect((await $.agent.spawn(spawnInput())).deny).toBe(undefined)
    expect(w.toasts.some(t => /Cap not enforcing: no weekly window reported\. Failing open/.test(t))).toBe(true)
  })

  test('forced weekly mode with no data, fail-closed: refuses with the reason', async ($, on) => {
    world(on, { usageThrows: true, env: { BB5H_MODE: 'weekly', BB5H_FAIL_MODE: 'closed' } })
    await $.session.start(START)
    expect((await $.prompt.submit(prompt('a'))).drop).toMatch(/usage can't be read \(no weekly window reported\) and fail mode is "closed"/)
    expect((await $.agent.spawn(spawnInput())).deny).toMatch(/fail mode is "closed"/)
  })

  test('a crashing store: fail-open lets work through with a warning', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    w.breakStore()
    expect((await $.prompt.submit(prompt('a'))).drop).toBe(undefined)
    expect(w.toasts.some(t => /check failed; allowing \(fail-open\)/.test(t))).toBe(true)
  })

  test('a crashing store: fail-closed refuses', async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40), env: { BB5H_FAIL_MODE: 'closed' } })
    await $.session.start(START)
    w.breakStore()
    expect((await $.prompt.submit(prompt('a'))).drop).toMatch(/usage check failed/)
  })
})

describe('configuration', () => {
  test('userConfig options change the window and budget', { options: { windowHours: 3, weeklyBudgetPct: 5 } }, async ($, on) => {
    const w = world(on, { rateLimits: ULTRA(40) })
    await $.session.start(START)
    await $.prompt.submit(prompt('a'))
    expect(w.store.get('block')).toEqual(expect.objectContaining({ endsAt: T0 + 3 * HOUR }))
    w.setLimits(ULTRA(45))
    await $.session.measure(measureInput(ULTRA(45)))
    expect((await $.prompt.submit(prompt('b'))).drop).toMatch(/3h limit is reached/)
  })
})
