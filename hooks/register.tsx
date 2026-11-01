// bringback5hourlimit: a local, self-imposed rolling usage cap.
// Wiring only: every decision is made by the pure functions in ./logic.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandView } from '../types'
import * as L from './logic'

type $T = EngineInterface

// The tag declines what an earlier version stored under this key.
const view = atom({ plugin: 'bringback5hourlimit', key: 'view' } as const, null as BandView | null, { shape: 'band-3' })

const TONE_COLOR: Record<L.Tone, 'warning' | 'error' | undefined> = {
  label: undefined, text: undefined, dim: undefined, track: undefined,
  ok: undefined, warn: 'warning', error: 'error',
}

const KEY_BLOCK = 'block'
const KEY_LIMITS = 'limits'
const KEY_CONTROL = 'control'
const KEY_OVERRIDES = 'overrides'
const KEY_CALIBRATION = 'calibration'
const KEY_TOK = 'tok:'
const REFRESH_MS = 30_000
const STALE_COUNTER_MS = 24 * 3_600_000
const HOUR = 3_600_000

/** Per-load module state: lost on reload, which only re-arms toasts and notes. */
type Ctx = {
  options: Record<string, unknown>
  sessionId: string
  lastCfg: L.Config
  lastStatus: L.Status | undefined
  mainTurnRunning: boolean
  /** Cells the mode labels (`⏵⏵ auto mode on`) take on the hint row. */
  modesWidth: number
  toasted: Set<string>
  noted: Set<string>
}

type Snapshot = {
  cfg: L.Config
  invalid: string[]
  now: number
  block: L.Block
  isIdle: boolean
  control: L.Control
  status: L.Status
}

// ------------------------------------------------------------ storage

async function getJSON<T>($: $T, key: string): Promise<T | undefined> {
  const v = await $.store.get(key)
  return v === undefined || v === null ? undefined : (v as T)
}

async function envLayer($: $T): Promise<Record<string, unknown>> {
  return {
    windowHours: await $.env.get('BB5H_WINDOW_HOURS'),
    mode: await $.env.get('BB5H_MODE'),
    officialCapPct: await $.env.get('BB5H_OFFICIAL_CAP_PCT'),
    weeklyBudgetPct: await $.env.get('BB5H_BLOCK_BUDGET_PCT_OF_WEEKLY'),
    tokenBudget: await $.env.get('BB5H_TOKEN_BUDGET'),
    warnPct: await $.env.get('BB5H_WARN_PCT'),
    failMode: await $.env.get('BB5H_FAIL_MODE'),
    showBar: await $.env.get('BB5H_SHOW_BAR'),
    barPosition: await $.env.get('BB5H_BAR_POSITION'),
    timeZone: await $.env.get('BB5H_TIMEZONE'),
  }
}

async function loadConfig($: $T, ctx: Ctx) {
  const overrides = (await getJSON<Record<string, unknown>>($, KEY_OVERRIDES)) ?? {}
  const r = L.resolveConfig(ctx.options, await envLayer($), overrides)
  ctx.lastCfg = r.config
  return r
}

async function ensureSessionId($: $T, ctx: Ctx): Promise<string> {
  if (!ctx.sessionId) {
    const id = await $.session.id().catch(() => '')
    ctx.sessionId = id || `anon-${Math.random().toString(36).slice(2)}`
  }
  return ctx.sessionId
}

/** Re-reads the shared block, merges ours in, writes when it changed. */
async function writeBlock($: $T, mine: L.Block, now: number): Promise<L.Block> {
  const stored = await getJSON<L.Block>($, KEY_BLOCK)
  const merged = L.mergeBlock(stored, mine, now) ?? mine
  if (JSON.stringify(merged) !== JSON.stringify(stored)) await $.store.set(KEY_BLOCK, merged)
  return merged
}

async function readTokens($: $T, blockStart: number): Promise<number> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(KEY_TOK))
  const counters: (L.TokenCounter | undefined)[] = []
  for (const k of keys) counters.push(await getJSON<L.TokenCounter>($, k))
  return L.sumTokens(counters, blockStart)
}

/**
 * Stores a reading. A pushed one (`session.measure`) is fresh by definition;
 * a polled one is the last response's figures, so it only counts as new when
 * they changed: otherwise hours-old numbers would keep passing as current.
 */
async function saveLimits($: $T, fresh: L.Limits | undefined, isPushed: boolean): Promise<void> {
  if (!fresh) return
  const stored = await getJSON<L.Limits>($, KEY_LIMITS)
  if (!isPushed && L.sameLimits(stored, fresh)) return
  if (L.mergeLimits(stored, fresh) === fresh) await $.store.set(KEY_LIMITS, fresh)
}

async function readLimits($: $T, now: number): Promise<L.Limits | undefined> {
  try {
    const usage = await $.session.usage()
    await saveLimits($, L.parseRateLimits(usage.rateLimits, now), false)
  } catch {
    // The usage source failed: strategy selection degrades on stale data.
  }
  return getJSON<L.Limits>($, KEY_LIMITS)
}

// ------------------------------------------------------------ core

/** Measures everything; `start` begins a block when none is active. */
async function snapshot($: $T, ctx: Ctx, start: boolean): Promise<Snapshot> {
  const now = await $.clock.now()
  const { config: cfg, invalid } = await loadConfig($, ctx)
  const limits = await readLimits($, now)
  const control = (await getJSON<L.Control>($, KEY_CONTROL)) ?? {}
  const stored = await getJSON<L.Block>($, KEY_BLOCK)
  const isIdle = !L.isActive(stored, now) && !start
  let block = L.ensureBlock(stored, now, cfg, limits)
  const tokens = isIdle ? 0 : await readTokens($, block.startedAt)
  let calibration = await getJSON<L.Calibration>($, KEY_CALIBRATION)
  if (!isIdle) {
    const fresh = L.liveLimits(limits, now, cfg)
    if (fresh?.sevenDay && fresh.at >= block.startedAt - L.BASELINE_MAX_AGE_MS) {
      const seen = L.observeWeekly(block, fresh.sevenDay.pct, tokens)
      block = seen.block
      if (seen.sample) {
        const learned = L.calibrate(calibration, seen.sample)
        if (learned && learned !== calibration) {
          calibration = learned
          await $.store.set(KEY_CALIBRATION, learned)
        }
      }
    }
    block = await writeBlock($, block, now)
  }
  const status = L.evaluate({ cfg, now, block, limits, tokens, control, ...(calibration ? { calibration } : {}) })
  ctx.lastStatus = status
  await publish($, cfg, status, now, isIdle, control)
  return { cfg, invalid, now, block, isIdle, control, status }
}

async function publish($: $T, cfg: L.Config, status: L.Status, now: number, isIdle: boolean, control: L.Control): Promise<void> {
  const data = L.bandData(status, now, cfg, isIdle, control)
  const next: BandView = { data, show: cfg.showBar, position: cfg.barPosition }
  // `now` only matters at minute resolution: skip writes that draw the same.
  const key = (v: BandView | null) =>
    v ? JSON.stringify({ ...v.data, now: Math.floor(v.data.now / 60_000) }) + v.show + v.position : ''
  await update($, view, prev => (key(prev) === key(next) ? prev : next))
}

/** Warnings and the wrap-up note, once per block. */
async function react($: $T, ctx: Ctx, snap: Snapshot): Promise<void> {
  const { status: s, block, now, cfg } = snap
  if (snap.isIdle) return
  const id = String(block.startedAt)
  if (s.level === 'warn' && !ctx.toasted.has(`${id}:warn`)) {
    ctx.toasted.add(`${id}:warn`)
    $.ui.toast(`${s.windowLabel} budget at ${Math.floor(s.pct)}% · resets ${L.formatReset(s.resetsAt, now, cfg.timeZone)}`, { timeoutMs: 8000 })
  }
  if (s.level === 'cap' && !ctx.toasted.has(`${id}:cap`)) {
    ctx.toasted.add(`${id}:cap`)
    ctx.toasted.add(`${id}:warn`)
    $.ui.toast(
      `${s.windowLabel} budget spent · new prompts and agents paused until ${L.formatClock(s.resetsAt, cfg.timeZone, now)} · /5h unlock to override`,
      { timeoutMs: 12000 },
    )
    await $.ui.notify(`${s.windowLabel} budget spent. Resets ${L.formatReset(s.resetsAt, now, cfg.timeZone)}.`, { title: 'bringback5hourlimit' }).catch(() => undefined)
  }
  if (s.level === 'failing' && !ctx.toasted.has(`${id}:failing`)) {
    ctx.toasted.add(`${id}:failing`)
    $.ui.toast(
      cfg.failMode === 'open'
        ? `⚠ Cap not enforcing: ${s.reason}. Failing open; /5h status`
        : `⚠ Can't measure usage (${s.reason}); failing closed: new work is refused. /5h off to pause.`,
      { timeoutMs: 10000 },
    )
  }
  if (s.level === 'cap' && ctx.mainTurnRunning) await note($, ctx, s, now, cfg, block, undefined)
}

async function note($: $T, ctx: Ctx, s: L.Status, now: number, cfg: L.Config, block: L.Block, agentId: string | undefined): Promise<void> {
  const key = `${block.startedAt}:${agentId ?? 'main'}`
  if (ctx.noted.has(key)) return
  ctx.noted.add(key)
  const message = { type: 'user' as const, content: [{ type: 'text' as const, text: L.wrapUpNote(s, now, cfg.timeZone) }] }
  await $.session.append(agentId ? { message, agentId } : { message }).catch(() => undefined)
}

function logError($: $T, err: unknown): void {
  $.ui.log(`bringback5hourlimit: ${err instanceof Error ? err.message : String(err)}`)
}

// ------------------------------------------------------------ hook bodies

async function onSessionStart($: $T, ctx: Ctx): Promise<void> {
  await ensureSessionId($, ctx)
  await $.command.register({
    name: '5h',
    description: 'Self-imposed usage cap: status | on | off | unlock | reset | set <key> <value> | bar on|off',
    argumentHint: '[status|on|off|unlock|reset|set <key> <value>|bar on|off]',
    immediate: true,
  })
  const now = await $.clock.now()
  for (const k of (await $.store.keys()).filter(k => k.startsWith(KEY_TOK))) {
    const c = await getJSON<L.TokenCounter>($, k)
    if (!c || now - c.at > STALE_COUNTER_MS) await $.store.delete(k)
  }
  await snapshot($, ctx, false)
}

async function onTick($: $T, ctx: Ctx): Promise<void> {
  try {
    await react($, ctx, await snapshot($, ctx, false))
  } catch (err) {
    logError($, err)
  }
}

async function onMeasure($: $T, ctx: Ctx, rateLimits: readonly L.RateLimitLike[], changed: readonly string[]): Promise<void> {
  // Every measurement is a fresh reading, whatever moved.
  await saveLimits($, L.parseRateLimits(rateLimits, await $.clock.now()), true)
  void changed
  await react($, ctx, await snapshot($, ctx, false))
}

/** Counts one model request's tokens against the block (any session, any loop). */
async function countUsage($: $T, ctx: Ctx, usage: L.UsageLike | undefined): Promise<void> {
  const tokens = L.weightedTokens(usage)
  if (tokens <= 0) return
  const sid = await ensureSessionId($, ctx)
  const live = await snapshot($, ctx, true) // activity starts a block
  const key = KEY_TOK + sid
  const counter = await getJSON<L.TokenCounter>($, key)
  await $.store.set(key, L.addTokens(counter, live.block.startedAt, tokens, live.now))
  await react($, ctx, await snapshot($, ctx, false))
}

async function onToolCall($: $T, ctx: Ctx, s: L.Status, agentId: string | undefined): Promise<void> {
  const now = await $.clock.now()
  const block = await getJSON<L.Block>($, KEY_BLOCK)
  if (L.isActive(block, now)) await note($, ctx, s, now, ctx.lastCfg, block, agentId)
}

async function guardPrompt($: $T, ctx: Ctx): Promise<string | undefined> {
  const snap = await snapshot($, ctx, true)
  if (snap.status.blocks) return L.refusalText(snap.status, snap.now, snap.cfg.timeZone, 'prompt')
  await react($, ctx, snap).catch(() => undefined)
  return undefined
}

async function guardAgent($: $T, ctx: Ctx): Promise<string | undefined> {
  const snap = await snapshot($, ctx, true)
  return snap.status.blocks ? L.refusalText(snap.status, snap.now, snap.cfg.timeZone, 'agent') : undefined
}

function failOpenWarn($: $T, what: string): void {
  $.ui.toast(`⚠ bringback5hourlimit: its ${what} check failed; allowing (fail-open).`, { timeoutMs: 8000 })
}

async function runCommand($: $T, ctx: Ctx, args: string): Promise<string> {
  const snap = await snapshot($, ctx, false)
  const cmd = L.parseCommand(args, snap.status.strategy)
  const tz = snap.cfg.timeZone
  switch (cmd.kind) {
    case 'error':
      return cmd.message
    case 'status':
      return (
        L.statusText(snap.status, snap.cfg, snap.now, snap.block, snap.control, snap.invalid, snap.isIdle)
      )
    case 'off': {
      const until =
        snap.status.strategy === 'official' ? snap.status.resetsAt
        : snap.isIdle ? snap.now + snap.cfg.windowHours * HOUR
        : snap.block.endsAt
      await $.store.set(KEY_CONTROL, { ...snap.control, offUntil: until })
      await snapshot($, ctx, false)
      return `Cap paused until ${L.formatReset(until, snap.now, tz)}. /5h on to resume.`
    }
    case 'on': {
      await $.store.set(KEY_CONTROL, {})
      await snapshot($, ctx, false)
      return 'Cap on.'
    }
    case 'unlock': {
      const live = await snapshot($, ctx, true)
      await $.store.set(KEY_CONTROL, { ...live.control, unlockedBlock: live.block.startedAt })
      await snapshot($, ctx, false)
      return `Unlocked for this block (one-time). The cap re-engages at ${L.formatReset(live.block.endsAt, live.now, tz)}. /5h on to re-lock now.`
    }
    case 'toggleBar': {
      const current = (await getJSON<Record<string, unknown>>($, KEY_OVERRIDES)) ?? {}
      const show = !snap.cfg.showBar
      await $.store.set(KEY_OVERRIDES, { ...current, showBar: show })
      await snapshot($, ctx, false)
      return show ? `Bar on (${snap.cfg.barPosition} the prompt). /5h bar to hide.` : 'Bar hidden. /5h bar to show it again.'
    }
    case 'reset': {
      await $.store.delete(KEY_OVERRIDES)
      await snapshot($, ctx, false)
      return 'All /5h set overrides cleared; using /config, env vars and defaults.'
    }
    case 'set': {
      const current = (await getJSON<Record<string, unknown>>($, KEY_OVERRIDES)) ?? {}
      const r = L.applySet(current, cmd.key, cmd.value)
      if ('error' in r) return `${r.error} ${L.USAGE}`
      await $.store.set(KEY_OVERRIDES, r.overrides)
      const after = await snapshot($, ctx, false)
      return `Set ${cmd.key} = ${String(r.overrides[cmd.key])}.\n${L.bandText(L.bandData(after.status, after.now, after.cfg, after.isIdle, after.control))}`
    }
  }
}

// ------------------------------------------------------------ register

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    options: { ...options },
    sessionId: '',
    lastCfg: L.DEFAULTS,
    lastStatus: undefined,
    mainTurnRunning: false,
    modesWidth: 0,
    toasted: new Set(),
    noted: new Set(),
  }

  on('session.start', async ($, e, next) => {
    await onSessionStart($, ctx).catch(err => logError($, err))
    $.clock.every(REFRESH_MS, () => onTick($, ctx))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await onMeasure($, ctx, e.rateLimits, e.changed).catch(err => logError($, err))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) ctx.mainTurnRunning = true
    return next(e)
  })

  // Each model request's usage, as it lands, so the bar moves mid-turn.
  // The stream passes through untouched; counting never fails the request.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    await countUsage($, ctx, r.usage ?? undefined).catch(err => logError($, err))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) ctx.mainTurnRunning = false
    return next(e)
  })

  // Observe only: work running past the cap gets the wrap-up note once.
  on('tool.call', async ($, e, next) => {
    const s = ctx.lastStatus
    if (s?.level === 'cap') await onToolCall($, ctx, s, e.agentId).catch(err => logError($, err))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!L.isNewWork(e)) return next(e)
    const refusal = await guardPrompt($, ctx)
    return refusal ? { drop: refusal } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (ctx.lastCfg.failMode === 'closed') {
      return { drop: 'bringback5hourlimit: the usage check failed and fail mode is "closed". /5h off to pause.' }
    }
    failOpenWarn($, 'prompt')
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const refusal = await guardAgent($, ctx)
    return refusal ? { deny: refusal } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (ctx.lastCfg.failMode === 'closed') return { deny: 'bringback5hourlimit: the usage check failed and fail mode is "closed".' }
    failOpenWarn($, 'agent')
    return next(e)
  })

  on('command.run', { command: '5h' }, async ($, e) => ({ text: await runCommand($, ctx, e.args) }))

  // Observe only: the mode labels share the hint row, so their width is
  // what the bar must leave room for.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const width = L.modesWidth(e.props.modes)
    if (width !== ctx.modesWidth) {
      ctx.modesWidth = width
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Default: the bar rides at the end of the dim hint line under the input.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const v = await read($, view)
    if (!v || !v.show || v.position !== 'below') return next(e)
    const room = L.hintRoom(e.viewport?.columns ?? 100, ctx.modesWidth, e.props.hint, e.props.tail)
    const own = L.hintTail(v.data, room)
    if (!own) return next(e)
    const tail = e.props.tail ? `${e.props.tail} · ${own}` : own
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (!v || !v.show || v.position !== 'above' || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const segments = L.bandLayout(v.data, e.props.bodyColumns)
    // Quiet grey while all is well; colour only near or past the limit.
    const isAlert = v.data.level === 'warn' || v.data.level === 'cap' || v.data.level === 'failing'
    return (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" marginTop={1}>
        {segments.map(seg =>
          isAlert ? (
            <Text
              bold={seg.tone === 'label' || seg.tone === 'error'}
              color={TONE_COLOR[seg.tone]}
              dimColor={seg.tone === 'dim' || seg.tone === 'track'}
            >
              {seg.text}
            </Text>
          ) : (
            <Text dimColor>{seg.text}</Text>
          ),
        )}
      </Box>
    )
  })
}
