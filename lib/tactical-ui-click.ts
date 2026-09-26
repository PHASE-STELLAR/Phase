let tacticalAudioCtx: AudioContext | null = null
let lastClickTime = 0
const DEBOUNCE_MS = 50

function getTacticalAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (tacticalAudioCtx?.state === "closed") tacticalAudioCtx = null
  if (tacticalAudioCtx) return tacticalAudioCtx
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    tacticalAudioCtx = new AC()
    return tacticalAudioCtx
  } catch {
    return null
  }
}

/** Short electronic UI tick — works after a prior user gesture (click). Debounced to prevent audio spam. */
export function playTacticalUiClick(): void {
  const now = Date.now()
  if (now - lastClickTime < DEBOUNCE_MS) return
  lastClickTime = now
  const ctx = getTacticalAudioContext()
  if (!ctx) return
  try {
    // Async resume to prevent blocking
    void ctx.resume().then(() => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "square"
      osc.frequency.setValueAtTime(920, ctx.currentTime)
      gain.gain.setValueAtTime(0.032, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.052)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.058)
    }).catch(() => {
      /* ignore audio errors */
    })
  } catch {
    /* ignore */
  }
}
