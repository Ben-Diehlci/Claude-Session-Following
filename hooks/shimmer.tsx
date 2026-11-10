import type { ClientModule } from 'claude-code'

export type ShimmerProps = {
  id: string
  text: string
  bright: string
  dim: string
  clickable: boolean
  still?: boolean
}
type Local = { phase: number; stop?: () => void }

const TICK_MS = 110

// A moving light wave across the title, in the row's green. Clicking posts the
// session id so the hooks module can open it (a Client cannot run commands).
const Shimmer: ClientModule<ShimmerProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const stop = props.still ? undefined : surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
    state = { phase: 0, stop }
    surface.setState(state)
  }
  if (props.clickable) {
    surface.onPointer(e => {
      if (e.type === 'down' && (e.button ?? 'left') === 'left') surface.post({ open: props.id })
    })
  }
  const chars = [...props.text]
  const len = chars.length
  const band = props.still ? -99 : ((state.phase * 1.4) % (len + 10)) - 3
  return (
    <Box flexDirection="row">
      {chars.map((ch, i) => {
        const d = Math.abs(i - band)
        return (
          <Text key={`c${i}`} color={d < 1.2 ? props.bright : props.dim} bold={d < 1.2}>
            {ch}
          </Text>
        )
      })}
    </Box>
  )
}

export default Shimmer
