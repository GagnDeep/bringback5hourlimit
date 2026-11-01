import type { BandData } from '../types'

// Pure, side-effect-free logic for bringback5hourlimit.
// Nothing here touches `$`, the clock or storage: every input is passed in,
// so each function is unit-testable on its own.

export type Mode = 'auto' | 'official' | 'weekly' | 'tokens'
export type Strategy = 'official' | 'weekly' | 'tokens'
export type FailMode = 'open' | 'closed'

export type Config = {
  windowHours: number
  mode: Mode
  officialCapPct: number
  weeklyBudgetPct: number
  tokenBudget: number
  warnPct: number
  failMode: FailMode
  showBar: boolean
  timeZone: string
}

export const DEFAULTS: Config = {
  windowHours: 5,
  mode: 'auto',
  officialCapPct: 90,
  weeklyBudgetPct: 15,
  tokenBudget: 10_000_000,
  warnPct: 80,
  failMode: 'open',
  showBar: true,
  timeZone: '',
}

const HOUR = 3_600_000

// ---------------------------------------------------------------- config

type Raw = Record<string, unknown>

const MODES: readonly Mode[] = ['auto', 'official', 'weekly', 'tokens']
const FAILS: readonly FailMode[] = ['open', 'closed']

function num(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/_/g, ''))
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === undefined || v === null || v === '') return undefined
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(s)) return true
  if (['0', 'false', 'off', 'no'].includes(s)) return false
  return undefined
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase() as T
  return list.includes(s) ? s : undefined
}

export function isValidTimeZone(tz: string): boolean {
  if (tz === '') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function zone(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return isValidTimeZone(s) ? s : undefined
}

/** Reads one layer of raw values; drops invalid ones, naming them. */
export function parseLayer(raw: Raw): { values: Partial<Config>; invalid: string[] } {
  const values: Partial<Config> = {}
  const invalid: string[] = []
  const take = <K extends keyof Config>(key: K, parsed: Config[K] | undefined) => {
    if (parsed !== undefined) values[key] = parsed
    else if (raw[key] !== undefined && raw[key] !== '' && raw[key] !== null) invalid.push(key)
  }
  take('windowHours', num(raw.windowHours, 0.25, 168))
  take('mode', oneOf(raw.mode, MODES))
  take('officialCapPct', num(raw.officialCapPct, 1, 100))
  take('weeklyBudgetPct', num(raw.weeklyBudgetPct, 0.1, 100))
  take('tokenBudget', num(raw.tokenBudget, 1000, 1e12))
  take('warnPct', num(raw.warnPct, 1, 100))
  take('failMode', oneOf(raw.failMode, FAILS))
  take('showBar', bool(raw.showBar))
  take('timeZone', zone(raw.timeZone))
  return { values, invalid }
}

/** Layers, lowest first: userConfig options, env, /5h overrides. */
export function resolveConfig(...layers: Raw[]): { config: Config; invalid: string[] } {
  let config: Config = { ...DEFAULTS }
  const invalid: string[] = []
  for (const layer of layers) {
    const parsed = parseLayer(layer)
    config = { ...config, ...parsed.values }
    invalid.push(...parsed.invalid)
  }
  return { config, invalid }
}

// ---------------------------------------------------------------- limits

export type Window = { pct: number; resetsAt?: number }
/** One snapshot of the account's windows, taken at `at`. */
export type Limits = { at: number; fiveHour?: Window; sevenDay?: Window }

export type RateLimitLike = { kind: string; percentUsed: number; resetsAt?: string }

/** Turns the engine's `rateLimits` into a snapshot; undefined when empty. */
export function parseRateLimits(list: readonly RateLimitLike[] | undefined, now: number): Limits | undefined {
  if (!list || list.length === 0) return undefined
  const pick = (kind: string): Window | undefined => {
    const w = list.find(l => l.kind === kind)
    if (!w || typeof w.percentUsed !== 'number' || !Number.isFinite(w.percentUsed)) return undefined
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return Number.isFinite(t) ? { pct: w.percentUsed, resetsAt: t } : { pct: w.percentUsed }
  }
  const fiveHour = pick('five_hour')
  const sevenDay = pick('seven_day')
  if (!fiveHour && !sevenDay) return undefined
  const out: Limits = { at: now }
  if (fiveHour) out.fiveHour = fiveHour
  if (sevenDay) out.sevenDay = sevenDay
  return out
}

/** Newest snapshot wins (a whole snapshot, so an absent window stays absent). */
export function mergeLimits(a: Limits | undefined, b: Limits | undefined): Limits | undefined {
  if (!a) return b
  if (!b) return a
  return b.at >= a.at ? b : a
}

export function isFresh(limits: Limits | undefined, now: number, cfg: Config): limits is Limits {
  return !!limits && now - limits.at <= Math.max(cfg.windowHours, 5) * HOUR && limits.at <= now + 60_000
}

// ---------------------------------------------------------------- strategy

export type Selection = { strategy: Strategy; available: boolean; degraded: boolean; reason?: string }

export function selectStrategy(cfg: Config, limits: Limits | undefined, now: number): Selection {
  const fresh = isFresh(limits, now, cfg) ? limits : undefined
  const has5 = !!fresh?.fiveHour
  const has7 = !!fresh?.sevenDay
  switch (cfg.mode) {
    case 'official':
      return has5
        ? { strategy: 'official', available: true, degraded: false }
        : { strategy: 'official', available: false, degraded: true, reason: 'no 5-hour window reported' }
    case 'weekly':
      return has7
        ? { strategy: 'weekly', available: true, degraded: false }
        : { strategy: 'weekly', available: false, degraded: true, reason: 'no weekly window reported' }
    case 'tokens':
      return { strategy: 'tokens', available: true, degraded: false }
    default:
      if (has5) return { strategy: 'official', available: true, degraded: false }
      if (has7) return { strategy: 'weekly', available: true, degraded: false }
      return { strategy: 'tokens', available: true, degraded: true, reason: 'no usage data; counting tokens locally' }
  }
}

// ---------------------------------------------------------------- blocks

export type Block = {
  startedAt: number
  endsAt: number
  weeklyBase?: number
  weeklyLast?: number
  weeklyCarried: number
}

export function isActive(block: Block | undefined, now: number): block is Block {
  return !!block && now >= block.startedAt && now < block.endsAt
}

export function startBlock(now: number, cfg: Config, weeklyPct?: number): Block {
  const b: Block = { startedAt: now, endsAt: now + cfg.windowHours * HOUR, weeklyCarried: 0 }
  if (weeklyPct !== undefined) {
    b.weeklyBase = weeklyPct
    b.weeklyLast = weeklyPct
  }
  return b
}

/** The active block, or a new one started now. */
export function ensureBlock(block: Block | undefined, now: number, cfg: Config, limits?: Limits): Block {
  if (isActive(block, now)) return block
  const weekly = isFresh(limits, now, cfg) ? limits.sevenDay?.pct : undefined
  return startBlock(now, cfg, weekly)
}

/**
 * Deterministic merge of two sessions' views of the shared block: the
 * earliest active block wins; the same block's fields combine.
 */
export function mergeBlock(a: Block | undefined, b: Block | undefined, now: number): Block | undefined {
  const A = isActive(a, now) ? a : undefined
  const B = isActive(b, now) ? b : undefined
  if (!A) return B
  if (!B) return A
  if (A.startedAt !== B.startedAt) return A.startedAt < B.startedAt ? A : B
  const base = [A.weeklyBase, B.weeklyBase].filter((x): x is number => x !== undefined)
  const last = [A.weeklyLast, B.weeklyLast].filter((x): x is number => x !== undefined)
  const out: Block = {
    startedAt: A.startedAt,
    endsAt: Math.min(A.endsAt, B.endsAt),
    weeklyCarried: Math.max(A.weeklyCarried, B.weeklyCarried),
  }
  if (base.length) out.weeklyBase = Math.min(...base)
  if (last.length) out.weeklyLast = A.weeklyCarried === B.weeklyCarried ? Math.max(...last) : (A.weeklyCarried > B.weeklyCarried ? A : B).weeklyLast
  return out
}

/** Folds a weekly reading into the block (baseline, growth, weekly reset). */
export function observeWeekly(block: Block, pct: number): Block {
  if (block.weeklyBase === undefined || block.weeklyLast === undefined) {
    return { ...block, weeklyBase: pct, weeklyLast: pct }
  }
  if (pct < block.weeklyLast - 0.5) {
    // The weekly window reset inside this block: carry what was spent.
    return {
      ...block,
      weeklyCarried: block.weeklyCarried + Math.max(0, block.weeklyLast - block.weeklyBase),
      weeklyBase: 0,
      weeklyLast: pct,
    }
  }
  return { ...block, weeklyLast: Math.max(block.weeklyLast, pct) }
}

export function weeklySpent(block: Block): number {
  if (block.weeklyBase === undefined || block.weeklyLast === undefined) return block.weeklyCarried
  return round1(block.weeklyCarried + Math.max(0, block.weeklyLast - block.weeklyBase))
}

// ---------------------------------------------------------------- tokens

export type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export function weightedTokens(u: UsageLike | undefined): number {
  if (!u) return 0
  const n = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)
  return Math.round(
    n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens) + 0.1 * n(u.cache_read_input_tokens),
  )
}

export type TokenCounter = { blockStart: number; tokens: number; at: number }

export function addTokens(c: TokenCounter | undefined, blockStart: number, tokens: number, now: number): TokenCounter {
  const base = c && c.blockStart === blockStart ? c.tokens : 0
  return { blockStart, tokens: base + tokens, at: now }
}

export function sumTokens(counters: readonly (TokenCounter | undefined)[], blockStart: number): number {
  return counters.reduce((s, c) => (c && c.blockStart === blockStart ? s + c.tokens : s), 0)
}

// ---------------------------------------------------------------- evaluation

export type Control = { offUntil?: number; unlockedBlock?: number }

export type Level = 'ok' | 'warn' | 'cap' | 'off' | 'unlocked' | 'failing'

export type Status = {
  strategy: Strategy
  degraded: boolean
  reason?: string
  level: Level
  pct: number
  used: number
  budget: number
  resetsAt: number
  weeklyPct?: number
  weeklyResetsAt?: number
  windowLabel: string
  /** True when the cap applies to new work now. */
  blocks: boolean
}

export type EvalInput = {
  cfg: Config
  now: number
  block: Block
  limits: Limits | undefined
  tokens: number
  control: Control
}

export function evaluate(x: EvalInput): Status {
  const { cfg, now, block, limits, tokens, control } = x
  const sel = selectStrategy(cfg, limits, now)
  const fresh = isFresh(limits, now, cfg) ? limits : undefined
  const weeklyPct = fresh?.sevenDay?.pct
  const weeklyResetsAt = fresh?.sevenDay?.resetsAt
  let used: number
  let budget: number
  let resetsAt = block.endsAt
  let windowLabel = `${trimNum(cfg.windowHours)}h`

  if (!sel.available) {
    return {
      strategy: sel.strategy, degraded: true, reason: sel.reason, level: 'failing', pct: 0, used: 0,
      budget: 0, resetsAt, weeklyPct, weeklyResetsAt, windowLabel, blocks: cfg.failMode === 'closed',
    }
  }
  if (sel.strategy === 'official' && fresh?.fiveHour) {
    const w = fresh.fiveHour
    const expired = w.resetsAt !== undefined && w.resetsAt <= now
    used = expired ? 0 : w.pct
    budget = cfg.officialCapPct
    resetsAt = !expired && w.resetsAt !== undefined ? w.resetsAt : block.endsAt
    windowLabel = '5h'
  } else if (sel.strategy === 'weekly') {
    used = weeklySpent(block)
    budget = cfg.weeklyBudgetPct
  } else {
    used = tokens
    budget = cfg.tokenBudget
  }
  const pct = budget > 0 ? Math.floor((used / budget) * 1000 + 1e-9) / 10 : 0
  let level: Level = pct >= 100 ? 'cap' : pct >= cfg.warnPct ? 'warn' : 'ok'
  if (control.offUntil !== undefined && now < control.offUntil) level = 'off'
  else if (control.unlockedBlock !== undefined && control.unlockedBlock === block.startedAt) level = 'unlocked'
  return {
    strategy: sel.strategy, degraded: sel.degraded, reason: sel.reason, level, pct, used, budget,
    resetsAt, weeklyPct, weeklyResetsAt, windowLabel, blocks: level === 'cap',
  }
}

// ---------------------------------------------------------------- prompts

export type OriginLike = { kind: string }

/** Origins that are deliveries of work already running, never new work. */
const PASS_ORIGINS = new Set(['task-notification', 'observer', 'observer-activity', 'unclassified'])

/** Whether a submitted prompt is new work the cap may refuse. */
export function isNewWork(e: { command?: unknown; isMeta?: true; origin?: OriginLike }): boolean {
  if (e.command !== undefined) return false
  if (e.isMeta) return false
  if (e.origin && PASS_ORIGINS.has(e.origin.kind)) return false
  return true
}

// ---------------------------------------------------------------- formatting

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round1(n))
}

function systemZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'system zone'
  } catch {
    return 'system zone'
  }
}

export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${mm}m`
  return `${mm}m`
}

export function formatClock(ms: number, timeZone: string, now?: number): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
  if (timeZone) opts.timeZone = timeZone
  if (now !== undefined && ms - now > 20 * HOUR) opts.weekday = 'short'
  try {
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

export function formatReset(ms: number, now: number, timeZone: string): string {
  return `${formatClock(ms, timeZone, now)} (in ${formatDuration(ms - now)})`
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${round1(n / 1e6)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function formatClockShort(ms: number, timeZone: string, now?: number): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  if (timeZone) opts.timeZone = timeZone
  if (now !== undefined && ms - now > 20 * HOUR) opts.weekday = 'short'
  try {
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

/** How usage is measured, in plain words. */
export function strategyLabel(s: Strategy): string {
  return s === 'official' ? "Anthropic's 5h limit" : s === 'weekly' ? 'share of your week' : 'local token count'
}

/** What was spent against what is allowed, in plain words. */
export function usedText(s: Status): string {
  if (s.strategy === 'tokens') return `${formatTokens(s.used)} of ${formatTokens(s.budget)} tokens`
  if (s.strategy === 'weekly') return `${round1(s.used)}% of your week (budget ${trimNum(s.budget)}%)`
  return `Anthropic 5h at ${round1(s.used)}% (cap ${trimNum(s.budget)}%)`
}

// ---------------------------------------------------------------- the band

export type { BandData }

export type Tone = 'label' | 'text' | 'dim' | 'track' | 'ok' | 'warn' | 'error'
export type Segment = { text: string; tone: Tone }

export function bandData(s: Status, now: number, cfg: Config, idle: boolean, control: Control): BandData {
  const d: BandData = {
    level: s.level, pct: s.pct, resetsAt: s.resetsAt, now, idle: idle && s.strategy !== 'official',
    isEstimate: s.strategy === 'tokens' && s.degraded, windowLabel: s.windowLabel,
    failMode: cfg.failMode, timeZone: cfg.timeZone,
  }
  if (s.weeklyPct !== undefined) d.weeklyPct = s.weeklyPct
  if (s.reason !== undefined) d.reason = s.reason
  if (control.offUntil !== undefined) d.offUntil = control.offUntil
  return d
}

const width = (segs: readonly Segment[]) => segs.reduce((n, s) => n + [...s.text].length, 0)

function bar(pct: number, cells: number, tone: Tone): Segment[] {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round((pct / 100) * cells)))
  const out: Segment[] = []
  if (filled > 0) out.push({ text: '━'.repeat(filled), tone })
  if (cells - filled > 0) out.push({ text: '─'.repeat(cells - filled), tone: 'track' })
  return out
}

/**
 * The band, laid out for `columns` cells: the richest variant that fits,
 * down to a few characters. Pure: `now` and every number come in `d`.
 */
export function bandLayout(d: BandData, columns: number): Segment[] {
  const W = d.windowLabel
  const left = formatDuration(d.resetsAt - d.now)
  const clock = formatClockShort(d.resetsAt, d.timeZone, d.now)
  const wk = d.weeklyPct !== undefined ? Math.round(d.weeklyPct) : undefined
  const pctText = `${d.isEstimate ? '≈' : ''}${Math.floor(d.pct)}%`
  const t = (text: string, tone: Tone = 'dim'): Segment => ({ text, tone })
  const week = (long: boolean): Segment[] => (wk === undefined ? [] : [t(long ? ` · week ${wk}%` : ` · wk ${wk}%`)])
  let variants: Segment[][]

  switch (d.level) {
    case 'failing': {
      const closed = d.failMode === 'closed'
      const tone: Tone = closed ? 'error' : 'warn'
      variants = [
        [t(`⚠ ${W} limit not active`, tone), t(` · can't read usage (${d.reason ?? 'no data'})`), t(closed ? ' · new prompts paused' : ' · allowing work'), t(' · /5h status')],
        [t(`⚠ ${W} limit not active`, tone), t(closed ? ' · new prompts paused' : ' · allowing work'), t(' · /5h status')],
        [t(`⚠ ${W} limit not active`, tone)],
        [t(`⚠ ${W}`, tone)],
      ]
      break
    }
    case 'off': {
      const until = d.offUntil ?? d.resetsAt
      variants = [
        [t(`${W} limit`, 'label'), t(` paused until ${formatClockShort(until, d.timeZone, d.now)} (in ${formatDuration(until - d.now)})`), ...week(true), t(' · /5h on to resume')],
        [t(`${W} limit`, 'label'), t(` paused · ${formatDuration(until - d.now)} left`), ...week(false)],
        [t(`${W} paused`, 'label')],
      ]
      break
    }
    case 'cap':
      variants = [
        [t(`${W} limit reached`, 'error'), t(' · new prompts & agents paused'), t(` · resets in ${left} (${clock})`, 'text'), t(' · /5h unlock to override')],
        [t(`${W} limit reached`, 'error'), t(` · resets in ${left} (${clock})`, 'text'), t(' · /5h unlock')],
        [t(`${W} limit reached`, 'error'), t(` · back in ${left}`, 'text')],
        [t(`${W} ⛔ ${left}`, 'error')],
      ]
      break
    default: {
      if (d.idle) {
        variants = [
          [t(`${W} limit`, 'label'), t(' ready', 'ok'), t(' · starts with your next prompt'), ...week(true)],
          [t(`${W} limit`, 'label'), t(' ready', 'ok'), ...week(false)],
          [t(`${W}`, 'label'), t(' ready', 'ok')],
        ]
        break
      }
      const tone: Tone = d.level === 'unlocked' ? 'dim' : d.level === 'warn' ? 'warn' : 'ok'
      const tag = d.level === 'unlocked' ? [t(' · unlocked', 'warn')] : []
      const used = `${pctText} used`
      variants = [
        [t(`${W} limit `, 'label'), ...bar(d.pct, 12, tone), t(` ${used}`, tone), ...tag, t(` · resets in ${left} (${clock})`), ...week(true)],
        [t(`${W} limit `, 'label'), ...bar(d.pct, 10, tone), t(` ${used}`, tone), ...tag, t(` · resets in ${left}`), ...week(true)],
        [t(`${W} `, 'label'), ...bar(d.pct, 6, tone), t(` ${pctText}`, tone), ...tag, t(` · ${left} left`), ...week(false)],
        [t(`${W} `, 'label'), t(pctText, tone), t(` · ${left}`)],
        [t(`${W} `, 'label'), t(pctText, tone)],
      ]
    }
  }
  for (const v of variants) if (width(v) <= columns) return v
  const last = variants[variants.length - 1]!
  return [{ text: last.map(s => s.text).join('').slice(0, Math.max(0, columns)), tone: last[0]!.tone }]
}

/** One line of plain text, for command output. */
export function bandText(d: BandData, columns = 120): string {
  return bandLayout(d, columns).map(s => s.text).join('')
}

export function refusalText(s: Status, now: number, timeZone: string, kind: 'prompt' | 'agent'): string {
  const what = kind === 'prompt' ? 'Prompt not sent' : 'New agent not started'
  if (s.level === 'failing') {
    return `bringback5hourlimit: ${what}: usage can't be read (${s.reason}) and fail mode is "closed". /5h set fail open, or /5h off.`
  }
  return (
    `bringback5hourlimit: ${what}: your ${s.windowLabel} limit is reached (${usedText(s)}). ` +
    `Resets ${formatReset(s.resetsAt, now, timeZone)}. /5h unlock to keep going this block, /5h off to pause until reset.`
  )
}

export function wrapUpNote(s: Status, now: number, timeZone: string): string {
  return (
    `[bringback5hourlimit] The user's self-imposed ${s.windowLabel} usage budget is now spent ` +
    `(resets ${formatReset(s.resetsAt, now, timeZone)}). Finish the step in progress and leave files ` +
    `in a consistent state. Do not start new large tasks or subagents. End this turn with a short ` +
    `summary of what is done and what is left, so the work can resume after the reset.`
  )
}

// ---------------------------------------------------------------- commands

export type Command =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'on' }
  | { kind: 'unlock' }
  | { kind: 'reset' }
  | { kind: 'set'; key: keyof Config; value: string }
  | { kind: 'error'; message: string }

export const SET_KEYS: Record<string, keyof Config> = {
  hours: 'windowHours', window: 'windowHours', windowhours: 'windowHours',
  budget: 'weeklyBudgetPct', weekly: 'weeklyBudgetPct', weeklybudgetpct: 'weeklyBudgetPct',
  tokens: 'tokenBudget', tokenbudget: 'tokenBudget',
  cap: 'officialCapPct', officialcappct: 'officialCapPct',
  warn: 'warnPct', warnpct: 'warnPct',
  mode: 'mode',
  fail: 'failMode', failmode: 'failMode',
  bar: 'showBar', showbar: 'showBar',
  tz: 'timeZone', timezone: 'timeZone',
}

export const USAGE =
  'Usage: /5h [status|on|off|unlock|reset] · /5h set <hours|budget|tokens|cap|warn|mode|fail|bar|tz> <value> · /5h set <number> · /5h bar on|off'

/** The budget key the active strategy reads, for `/5h set <number>`. */
export function budgetKeyFor(s: Strategy): keyof Config {
  return s === 'official' ? 'officialCapPct' : s === 'weekly' ? 'weeklyBudgetPct' : 'tokenBudget'
}

export function parseCommand(args: string, active: Strategy): Command {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [verb = 'status', ...rest] = words.map((w, i) => (i < 2 ? w.toLowerCase() : w))
  switch (verb) {
    case 'status': case 'off': case 'on': case 'unlock': case 'reset':
      return rest.length ? { kind: 'error', message: USAGE } : { kind: verb }
    case 'bar':
      return rest.length === 1 ? { kind: 'set', key: 'showBar', value: rest[0]! } : { kind: 'error', message: USAGE }
    case 'set': {
      if (rest.length === 1 && /^[\d._]+[km]?$/i.test(rest[0]!)) {
        return { kind: 'set', key: budgetKeyFor(active), value: expandNumber(rest[0]!) }
      }
      if (rest.length < 2) return { kind: 'error', message: USAGE }
      const key = SET_KEYS[rest[0]!.toLowerCase()]
      if (!key) return { kind: 'error', message: `Unknown setting "${rest[0]}". ${USAGE}` }
      const value = rest.slice(1).join(' ')
      return { kind: 'set', key, value: key === 'tokenBudget' ? expandNumber(value) : value }
    }
    default:
      return { kind: 'error', message: USAGE }
  }
}

function expandNumber(v: string): string {
  const m = /^([\d._]+)([km])$/i.exec(v.trim())
  if (!m) return v
  return String(Number(m[1]!.replace(/_/g, '')) * (m[2]!.toLowerCase() === 'k' ? 1e3 : 1e6))
}

/** Applies one `/5h set` to the override layer; error text when invalid. */
export function applySet(overrides: Raw, key: keyof Config, value: string): { overrides: Raw } | { error: string } {
  const parsed = parseLayer({ [key]: value })
  if (parsed.invalid.length || parsed.values[key] === undefined) {
    return { error: `Invalid value "${value}" for ${key}.` }
  }
  return { overrides: { ...overrides, [key]: parsed.values[key] } }
}

export function statusText(s: Status, cfg: Config, now: number, block: Block, control: Control, invalid: string[], idle = false): string {
  const tz = cfg.timeZone
  const W = s.windowLabel
  const headline: Record<Level, string> = {
    ok: `${Math.floor(s.pct)}% used`,
    warn: `${Math.floor(s.pct)}% used, close to the limit`,
    cap: 'limit reached: new prompts and agents are paused',
    off: 'paused (not enforcing)',
    unlocked: `unlocked for this block (${Math.floor(s.pct)}% used)`,
    failing: cfg.failMode === 'closed' ? "can't read usage: new prompts are paused" : "can't read usage: not enforcing",
  }
  const lines = [`${W} limit: ${idle && s.level === 'ok' && s.strategy !== 'official' ? 'ready (no block running)' : headline[s.level]}`]
  if (idle && s.strategy !== 'official') lines.push(`  A ${W} block starts with your next prompt.`)
  else if (s.level !== 'failing') lines.push(`  Resets ${formatReset(s.resetsAt, now, tz)}`)
  if (s.level === 'failing') {
    lines.push(`  Why: ${s.reason ?? 'no usage data'}. Fix: /5h set mode auto (falls back to counting tokens).`)
  } else if (s.strategy === 'weekly') {
    lines.push(`  Measured as: a share of your weekly limit. Each ${W} block may use ${trimNum(cfg.weeklyBudgetPct)}% of your week;`)
    lines.push(`    this block has used ${round1(s.used)}%. Change: /5h set budget <percent>`)
  } else if (s.strategy === 'official') {
    lines.push(`  Measured as: Anthropic's own 5-hour limit, paused at ${trimNum(cfg.officialCapPct)}% of it (now ${round1(s.used)}%).`)
    lines.push('    Change: /5h set cap <percent>')
  } else {
    lines.push(`  Measured as: tokens counted on this machine${s.degraded ? ' (Anthropic sent no usage data, so this is an estimate)' : ''}.`)
    lines.push(`    ${formatTokens(s.used)} of ${formatTokens(cfg.tokenBudget)} tokens this block. Change: /5h set tokens <n>, e.g. 5m`)
  }
  if (s.weeklyPct !== undefined) {
    lines.push(`  This week: ${round1(s.weeklyPct)}% used` + (s.weeklyResetsAt !== undefined ? `, resets ${formatClock(s.weeklyResetsAt, tz, now)}` : ''))
  }
  if (control.offUntil !== undefined && now < control.offUntil) lines.push(`  Paused until ${formatClock(control.offUntil, tz, now)}. /5h on to resume.`)
  if (s.level === 'unlocked') lines.push('  /5h on re-locks it now.')
  lines.push(`  Settings: ${trimNum(cfg.windowHours)}h blocks · warn at ${trimNum(cfg.warnPct)}% · mode ${cfg.mode} · ` +
    `if usage can't be read: ${cfg.failMode === 'open' ? 'allow' : 'refuse'} · bar ${cfg.showBar ? 'on' : 'off'}`)
  lines.push(tz ? `  Times in ${tz}.` : `  Times in ${systemZone()} (system). Yours differs? /5h set tz Asia/Kolkata`)
  if (invalid.length) lines.push(`  Ignored invalid settings: ${[...new Set(invalid)].join(', ')}`)
  return lines.join('\n')
}
