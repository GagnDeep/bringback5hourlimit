export type BandView = {
  text: string
  level: 'ok' | 'warn' | 'cap' | 'off' | 'unlocked' | 'failing'
  show: boolean
}

declare module 'claude-code' {
  interface PluginState {
    bringback5hourlimit: { view: BandView | null }
  }
}
