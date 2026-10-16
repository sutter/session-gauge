/** One rate-limit window, its reset time in epoch milliseconds. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: number }

/** The session's figures as last measured. */
export type Snapshot = {
  limits: Limit[]
  context: { tokens?: number; window: number; percent?: number }
  costUsd?: number
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-gauge': { snapshot: Snapshot | null; now: number }
  }
}
