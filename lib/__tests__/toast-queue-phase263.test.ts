import { describe, expect, it } from "vitest"
import { ToastQueue, normalizeToastError, type ToastEmitTarget } from "@/lib/toast-queue"

function createQueue(maxQueue = 3) {
  const emitted: string[] = []
  const target: ToastEmitTarget = {
    success: (message) => emitted.push(`success:${message}`),
    error: (message) => emitted.push(`error:${message}`),
    info: (message) => emitted.push(`info:${message}`),
    warning: (message) => emitted.push(`warning:${message}`),
    default: (message) => emitted.push(`default:${message}`),
  }
  return { emitted, queue: new ToastQueue(target, { maxVisible: 1, maxQueue }) }
}

describe("phase-263 toast queue", () => {
  it("deduplicates across message changes when the event key is stable", () => {
    const { queue } = createQueue()
    expect(queue.push("info", "first", { eventKey: "wallet.updated" })).toBe(true)
    expect(queue.push("success", "second", { eventKey: "wallet.updated" })).toBe(false)
    expect(queue.size).toBe(1)
  })

  it("keeps FIFO order when timestamps collide and enforces the queue cap", () => {
    const { queue, emitted } = createQueue(2)
    queue.push("info", "first")
    queue.push("info", "second")
    expect(queue.push("info", "third")).toBe(false)
    expect(queue.size).toBe(2)
    queue.drain()
    expect(emitted).toEqual(["info:first", "info:second"])
  })

  it("keeps a higher-priority toast by replacing the lowest-priority queued item", () => {
    const { queue } = createQueue(1)
    queue.push("info", "background")
    expect(queue.push("error", "urgent")).toBe(true)
    expect(queue.pending.map(({ message }) => message)).toEqual(["urgent"])
    expect(queue.size).toBeLessThanOrEqual(1)
  })

  it("normalizes the biometric trust-gate error in English and Spanish", () => {
    expect(normalizeToastError("contract failed with #13", "en")).toBe("[ ERROR: BIOMETRIC_TRUST_GATE_CLOSED ]")
    expect(normalizeToastError("BIOMETRIC_TRUST_GATE_CLOSED", "es")).toBe("[ ERROR: BIOMETRIC_TRUST_GATE_CLOSED ]")
  })
})
