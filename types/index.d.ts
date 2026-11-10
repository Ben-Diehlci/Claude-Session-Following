export type WaitReason = 'permission' | 'question' | 'turn'

export type Waiting = {
  reason: WaitReason
  question: string
  since: string
}

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
  /** Dim caption under the title: model, effort, permission mode, context, branch. */
  detail: string
  waiting: Waiting | null
}

export type Usage = {
  percent: number
  resetsIn: string
}

export type Snapshot = {
  checkedAt: string
  sessions: Sess[]
  error: string | null
  /** 5-hour plan window, or null when the plan limits are not readable. */
  usage: Usage | null
  /** Epoch ms until which Clawd cheers (a session just finished). */
  cheerUntil: number
}

export type View = {
  perGroup: number
  expanded: string[]
  collapsed: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-following': { snap: Shaped<Snapshot>; view: Shaped<View> }
  }
}
