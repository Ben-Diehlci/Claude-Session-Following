export type WaitReason = 'permission' | 'question' | 'turn'

export type Waiting = {
  reason: WaitReason
  question: string
  since: string
}

/** A session's last turn ended with nothing waiting on me. */
export type Done = {
  /** When the turn ended (ISO). */
  at: string
  /** Last line of the reply, clipped. */
  preview: string
  /** I have looked at it since (opened it from the panel, replied, or marked all seen). */
  seen: boolean
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
  /** Raw model id (claude-opus-5-5), or empty. */
  model: string
  effort: string
  branch: string
  /** Permission mode; get_session reports it only for the calling session and sessions it started. */
  perm: string
  /** Context used, percent, for working sessions; null when unavailable. */
  ctx: number | null
  /** Epoch ms when this mod first saw the session running; 0 when idle. */
  workingSince: number
  waiting: Waiting | null
  done: Done | null
  /** Helper agents still running after the session's own turn ended (0 = none). */
  bg: number
  /** Their task descriptions, joined and clipped. */
  bgLabel: string
}

export type Usage = {
  label: string
  percent: number
  resetsIn: string
}

export type Snapshot = {
  checkedAt: string
  sessions: Sess[]
  error: string | null
  /** Every plan window (5-hour, weekly...), empty when the plan limits are not readable. */
  usage: Usage[]
  /** Epoch ms until which Clawd cheers (a session just finished). */
  cheerUntil: number
  /** Title of the session that finished most recently. */
  cheerTitle: string
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
