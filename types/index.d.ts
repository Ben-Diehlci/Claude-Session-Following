export type Sess = {
  id: string
  title: string
  cwd: string
  isRunning: boolean
  lastActivityAt: string
  startedBy: string | null
  remote: boolean
  link: string | null
  isSelf: boolean
}

export type Snapshot = {
  checkedAt: string
  sessions: Sess[]
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-following': { snap: Shaped<Snapshot> }
  }
}
