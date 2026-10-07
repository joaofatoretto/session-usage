export type UsageWindow = { percent: number; resetsAt?: string }

export type ContextFill = { tokens?: number; window: number; percent?: number }

export type Usage = {
  session?: UsageWindow
  week?: UsageWindow
  costUsd?: number
  context?: ContextFill
}

declare module 'claude-code' {
  interface PluginState {
    'session-usage': { usage: Usage | null; now: number; isMinimized: boolean; isBlinking: boolean }
  }
}
