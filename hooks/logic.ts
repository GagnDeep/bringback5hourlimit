import type { BandData } from '../types'

// Pure, side-effect-free logic for bringback5hourlimit.
// Nothing here touches `$`, the clock or storage: every input is passed in,
// so each function is unit-testable on its own.

export type Mode = 'auto' | 'official' | 'weekly' | 'tokens'
export type Strategy = 'official' | 'weekly' | 'tokens'
export type FailMode = 'open' | 'closed'
export type BarPosition = 'below' | 'above'

export type Config = {
  windowHours: number
  mode: Mode
  officialCapPct: number
  weeklyBudgetPct: number
  tokenBudget: number
  warnPct: number
  failMode: FailMode
  showBar: boolean
  barPosition: BarPosition
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
  barPosition: 'above',
  timeZone: '',
}

/**
 * Prior for how many weighted tokens make one point of the weekly limit,
 * used until the mod has watched the weekly % tick up once and learned it.
 */
export const DEFAULT_TOKENS_PER_WEEKLY_PCT = 4_000_000

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR

// ---------------------------------------------------------------- config

type Raw = Record<string, unknown>

const MODES: readonly Mode[] = ['auto', 'official', 'weekly', 'tokens']
const FAILS: readonly FailMode[] = ['open', 'closed']
const POSITIONS: readonly BarPosition[] = ['below', 'above']

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
  take('barPosition', oneOf(raw.barPosition, POSITIONS))
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
  const [older, newer] = b.at >= a.at ? [a, b] : [b, a]
  // Inside one window usage only grows. A lower figure for the same window is
  // a stale copy (another process's cached reading), so the higher one stands.
  const keep = (o: Window | undefined, n: Window | undefined): Window | undefined =>
    o && n && sameWindow(o, n) && o.pct > n.pct ? o : n
  const fiveHour = keep(older.fiveHour, newer.fiveHour)
  const sevenDay = keep(older.sevenDay, newer.sevenDay)
  if (fiveHour === newer.fiveHour && sevenDay === newer.sevenDay) return newer
  const out: Limits = { at: newer.at }
  if (fiveHour) out.fiveHour = fiveHour
  if (sevenDay) out.sevenDay = sevenDay
  return out
}

/** Two readings of one window: the same reset time (a minute's slack), or neither says. */
export function sameWindow(a: Window, b: Window): boolean {
  if (a.resetsAt === undefined || b.resetsAt === undefined) return a.resetsAt === b.resetsAt
  return Math.abs(a.resetsAt - b.resetsAt) <= 60_000
}

/**
 * True when `next` belongs to a later window than `prev`: its reset time moved
 * on by over an hour. Without both reset times, only a fall to under half (by
 * 5+ points) reads as a new window; smaller dips are stale copies.
 */
export function isNewWindow(prev: Window, next: Window): boolean {
  if (prev.resetsAt !== undefined && next.resetsAt !== undefined) return next.resetsAt > prev.resetsAt + HOUR
  return next.pct < prev.pct / 2 && prev.pct - next.pct >= 5
}

export function isFresh(limits: Limits | undefined, now: number, cfg: Config): limits is Limits {
  return !!limits && now - limits.at <= Math.max(cfg.windowHours, 5) * HOUR && limits.at <= now + 60_000
}

/** A reading young enough to anchor a new block's weekly baseline. */
export const BASELINE_MAX_AGE_MS = 15 * 60_000

/**
 * The windows that can be trusted now: a fresh snapshot, less any window
 * whose reset time has passed (its percentage belongs to the old window).
 */
export function liveLimits(limits: Limits | undefined, now: number, cfg: Config): Limits | undefined {
  if (!isFresh(limits, now, cfg)) return undefined
  const out: Limits = { at: limits.at }
  if (limits.fiveHour && !(limits.fiveHour.resetsAt !== undefined && limits.fiveHour.resetsAt <= now)) out.fiveHour = limits.fiveHour
  if (limits.sevenDay && !(limits.sevenDay.resetsAt !== undefined && limits.sevenDay.resetsAt <= now)) out.sevenDay = limits.sevenDay
  return out.fiveHour || out.sevenDay ? out : undefined
}

/** Same windows and figures, whenever taken. */
export function sameLimits(a: Limits | undefined, b: Limits | undefined): boolean {
  const strip = (l: Limits | undefined) => (l ? JSON.stringify({ f: l.fiveHour ?? null, s: l.sevenDay ?? null }) : '')
  return strip(a) === strip(b)
}

// ---------------------------------------------------------------- strategy

export type Selection = { strategy: Strategy; available: boolean; degraded: boolean; reason?: string }

export function selectStrategy(cfg: Config, limits: Limits | undefined, now: number): Selection {
  const fresh = liveLimits(limits, now, cfg)
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
  /** Block token total when the weekly % last ticked up (or the baseline was set). */
  stepTokens?: number
  /**
   * True once `stepTokens` was taken at a tick. A baseline lands somewhere
   * inside a weekly point, so the first rise after it is no clean sample.
   */
  stepExact?: boolean
  /** The weekly window's reset time when `weeklyLast` was read. */
  weeklyResetsAt?: number
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
  const live = liveLimits(limits, now, cfg)
  const weekly = live && now - live.at <= BASELINE_MAX_AGE_MS ? live.sevenDay?.pct : undefined
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
  const later = (A.stepTokens ?? -1) >= (B.stepTokens ?? -1) ? A : B
  if (later.stepTokens !== undefined) out.stepTokens = later.stepTokens
  if (later.stepExact) out.stepExact = true
  const resets = [A.weeklyResetsAt, B.weeklyResetsAt].filter((x): x is number => x !== undefined)
  if (resets.length) out.weeklyResetsAt = Math.max(...resets)
  if (base.length) out.weeklyBase = Math.min(...base)
  if (last.length) out.weeklyLast = A.weeklyCarried === B.weeklyCarried ? Math.max(...last) : (A.weeklyCarried > B.weeklyCarried ? A : B).weeklyLast
  return out
}

/** Tokens spent over a rise of the weekly %, to learn their ratio. */
export type CalibrationSample = { tokens: number; pct: number }

/**
 * Folds a weekly reading into the block (baseline, growth, weekly reset).
 * `tokensNow` is the block's token total, so a rise yields a sample of how
 * many tokens one weekly point took.
 */
export function observeWeekly(block: Block, pct: number, tokensNow = 0, resetsAt?: number): { block: Block; sample?: CalibrationSample } {
  if (!Number.isFinite(pct)) return { block }
  const at = resetsAt !== undefined && Number.isFinite(resetsAt) ? { weeklyResetsAt: resetsAt } : {}
  if (block.weeklyBase === undefined || block.weeklyLast === undefined) {
    return { block: { ...block, weeklyBase: pct, weeklyLast: pct, stepTokens: tokensNow, stepExact: false, ...at } }
  }
  const prev: Window = { pct: block.weeklyLast, ...(block.weeklyResetsAt !== undefined ? { resetsAt: block.weeklyResetsAt } : {}) }
  const next: Window = { pct, ...(at.weeklyResetsAt !== undefined ? { resetsAt: at.weeklyResetsAt } : {}) }
  if (isNewWindow(prev, next) && couldResetInside(block, at.weeklyResetsAt)) {
    // The weekly window reset inside this block: carry what was spent.
    return {
      block: {
        ...block,
        weeklyCarried: round1(block.weeklyCarried + Math.max(0, block.weeklyLast - block.weeklyBase)),
        weeklyBase: 0,
        weeklyLast: pct,
        stepTokens: tokensNow,
        stepExact: false,
        ...at,
      },
    }
  }
  if (pct > block.weeklyLast) {
    const rise = pct - block.weeklyLast
    const tokens = tokensNow - (block.stepTokens ?? 0)
    const moved = { ...block, weeklyLast: pct, stepTokens: tokensNow, stepExact: true, ...at }
    return block.stepExact && tokens > 0 ? { block: moved, sample: { tokens, pct: rise } } : { block: moved }
  }
  // The same or lower inside the same window: a stale copy, nothing to learn.
  return { block: block.weeklyResetsAt === undefined && at.weeklyResetsAt !== undefined ? { ...block, ...at } : block }
}

/**
 * A weekly window can only have reset inside the block if the current window
 * began after the block did. Windows are a week long, so with a reset time in
 * hand that is checkable; without one, the drop rule alone decides.
 */
function couldResetInside(block: Block, resetsAt: number | undefined): boolean {
  return resetsAt === undefined || resetsAt - WEEK > block.startedAt - HOUR
}

/**
 * Repairs a block that carries spend from a weekly reset that cannot have
 * happened (the live window began before the block). Older versions, and any
 * process still running one, read a stale lower % as a reset; this undoes it
 * wherever it shows up, including after merging with such a process's write.
 * Carried spend is also capped at 100 (a whole week).
 */
export function healBlock(block: Block, limits: Limits | undefined): Block {
  let out = block
  const resetsAt = limits?.sevenDay?.resetsAt
  if (out.weeklyCarried > 0 && resetsAt !== undefined && !couldResetInside(out, resetsAt)) {
    const last = Math.max(out.weeklyLast ?? 0, limits?.sevenDay?.pct ?? 0)
    out = { ...out, weeklyCarried: 0, weeklyBase: out.weeklyBase && out.weeklyBase > 0 ? Math.min(out.weeklyBase, last) : last, weeklyLast: last, stepExact: false }
  }
  if (out.weeklyCarried > 100) out = { ...out, weeklyCarried: 100 }
  if (!Number.isFinite(out.weeklyCarried) || out.weeklyCarried < 0) out = { ...out, weeklyCarried: 0 }
  return out
}

export type Calibration = { tokensPerPct: number; samples: number }

/** Learns tokens-per-weekly-point from a sample (a moving average). */
export function calibrate(prev: Calibration | undefined, sample: CalibrationSample): Calibration | undefined {
  if (sample.pct <= 0 || sample.tokens < 10_000) return prev
  const r = Math.min(1e10, Math.max(1e4, sample.tokens / sample.pct))
  if (!prev) return { tokensPerPct: Math.round(r), samples: 1 }
  return { tokensPerPct: Math.round(prev.tokensPerPct * 0.6 + r * 0.4), samples: prev.samples + 1 }
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
  /** Part of `used` estimated from tokens since the weekly % last ticked (weekly). */
  estimated: number
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
  calibration?: Calibration
}

export function evaluate(x: EvalInput): Status {
  const { cfg, now, block, limits, tokens, control, calibration } = x
  let estimated = 0
  const sel = selectStrategy(cfg, limits, now)
  const fresh = liveLimits(limits, now, cfg)
  const weeklyPct = fresh?.sevenDay?.pct
  const weeklyResetsAt = fresh?.sevenDay?.resetsAt
  let used: number
  let budget: number
  let resetsAt = block.endsAt
  let windowLabel = `${trimNum(cfg.windowHours)}h`

  if (!sel.available) {
    return {
      strategy: sel.strategy, degraded: true, reason: sel.reason, level: 'failing', pct: 0, used: 0,
      budget: 0, resetsAt, weeklyPct, weeklyResetsAt, estimated, windowLabel, blocks: cfg.failMode === 'closed',
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
    // Anthropic reports whole weekly points. Between ticks, estimate from
    // tokens, kept under the next point so it never runs a point ahead.
    const ratio = calibration?.tokensPerPct ?? DEFAULT_TOKENS_PER_WEEKLY_PCT
    const since = Math.max(0, tokens - (block.stepTokens ?? 0))
    estimated = block.weeklyBase === undefined ? 0 : Math.min(0.95, since / ratio)
    used = weeklySpent(block) + estimated
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
    resetsAt, weeklyPct, weeklyResetsAt, estimated, windowLabel, blocks: level === 'cap',
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
    isEstimate: (s.strategy === 'tokens' && s.degraded) || (s.strategy === 'weekly' && s.estimated > 0.001),
    windowLabel: s.windowLabel,
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
  if (filled > 0) out.push({ text: '█'.repeat(filled), tone })
  if (cells - filled > 0) out.push({ text: '░'.repeat(cells - filled), tone: 'track' })
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
        [t(`${W} limit `, 'label'), ...bar(d.pct, 10, tone), t(` ${used}`, tone), ...tag, t(` · resets in ${left} (${clock})`), ...week(true)],
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

/** Cells the footer's mode labels take, with the space after them. */
export function modesWidth(modes: readonly string[]): number {
  const text = modes.join(' ')
  return text ? [...text].length + 1 : 0
}

/**
 * Cells left for the bar on the hint row: the row less its 2-cell indent,
 * the mode indicator, the engine's hint, another plugin's tail, the
 * engine's " · " before a tail, and one cell spare so it is never cut.
 */
export function hintRoom(columns: number, modes: number, hint: string, tail?: string): number {
  // The permission-mode indicator (`⏵⏵ auto mode on`) shares the row but is
  // not reported to mods; it shows whenever the hint offers shift+tab, so
  // room is kept for the longest one (`⏵⏵ bypass permissions on `).
  const indicator = /shift\+tab/i.test(hint) ? 26 : 0
  const used = 2 + Math.max(modes, indicator) + [...hint].length + (tail ? [...tail].length + 3 : 0) + 3 + 1
  return columns - used
}

/**
 * The bar as plain text for the hint line under the prompt, which is drawn
 * dim: ⚠ and ⛔ carry what colour would. Empty when under 7 cells fit.
 */
export function hintTail(d: BandData, columns: number): string {
  if (columns < 7) return ''
  const mark = d.level === 'cap' ? '⛔ ' : d.level === 'warn' || d.level === 'failing' ? '⚠ ' : ''
  const body = bandText(d, columns - [...mark].length)
  return d.level === 'failing' ? body : mark + body
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
  | { kind: 'toggleBar' }
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
  position: 'barPosition', barposition: 'barPosition',
  tz: 'timeZone', timezone: 'timeZone',
}

export const USAGE =
  'Usage: /5h [status|on|off|unlock|reset] · /5h bar (toggle) · /5h bar above|below · /5h set <hours|budget|tokens|cap|warn|mode|fail|tz> <value> · /5h set <number>'

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
      if (rest.length === 0) return { kind: 'toggleBar' }
      if (rest.length === 1 && (rest[0] === 'above' || rest[0] === 'below')) return { kind: 'set', key: 'barPosition', value: rest[0] }
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
  const pctText = `${s.estimated > 0.001 || (s.strategy === 'tokens' && s.degraded) ? '≈' : ''}${Math.floor(s.pct)}%`
  const headline: Record<Level, string> = {
    ok: `${pctText} used`,
    warn: `${pctText} used, close to the limit`,
    cap: 'limit reached: new prompts and agents are paused',
    off: 'paused (not enforcing)',
    unlocked: `unlocked for this block (${pctText} used)`,
    failing: cfg.failMode === 'closed' ? "can't read usage: new prompts are paused" : "can't read usage: not enforcing",
  }
  const lines = [`${W} limit: ${idle && s.level === 'ok' && s.strategy !== 'official' ? 'ready (no block running)' : headline[s.level]}`]
  if (idle && s.strategy !== 'official') lines.push(`  A ${W} block starts with your next prompt.`)
  else if (s.level !== 'failing') lines.push(`  Resets ${formatReset(s.resetsAt, now, tz)}`)
  if (s.level === 'failing') {
    lines.push(`  Why: ${s.reason ?? 'no usage data'}. Fix: /5h set mode auto (falls back to counting tokens).`)
  } else if (s.strategy === 'weekly') {
    lines.push(`  Measured as: a share of your weekly limit. Each ${W} block may use ${trimNum(cfg.weeklyBudgetPct)}% of your week;`)
    lines.push(
      s.estimated > 0.001
        ? `    this block has used ≈${round1(s.used)}% of your week (${round1(s.used - s.estimated)}% reported + ≈${round1(s.estimated)}% estimated from tokens,`
        : `    this block has used ${round1(s.used)}% of your week.`,
    )
    if (s.estimated > 0.001) lines.push('    since Anthropic reports whole weekly points). Change: /5h set budget <percent>')
    else lines.push('    Change: /5h set budget <percent>')
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
    `if usage can't be read: ${cfg.failMode === 'open' ? 'allow' : 'refuse'} · bar ${cfg.showBar ? cfg.barPosition + ' the prompt' : 'off'} (/5h bar toggles)`)
  lines.push(tz ? `  Times in ${tz}.` : `  Times in ${systemZone()} (system). Yours differs? /5h set tz Asia/Kolkata`)
  if (invalid.length) lines.push(`  Ignored invalid settings: ${[...new Set(invalid)].join(', ')}`)
  return lines.join('\n')
}
