/** What the band above the prompt draws; laid out per width at draw time. */
export type BandData = {
  level: 'ok' | 'warn' | 'cap' | 'off' | 'unlocked' | 'failing'
  pct: number
  resetsAt: number
  now: number
  weeklyPct?: number
  idle: boolean
  /** True while the percentage is a local estimate (no usage data). */
  isEstimate: boolean
  reason?: string
  windowLabel: string
  offUntil?: number
  failMode: 'open' | 'closed'
  timeZone: string
}

export type BandView = { data: BandData; show: boolean }

declare module 'claude-code' {
  interface PluginState {
    bringback5hourlimit: { view: Shaped<BandView | null> }
  }
}
