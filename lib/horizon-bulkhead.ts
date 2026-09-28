/** Shared process-local concurrency gate for Horizon/Soroban reads. */

export const HORIZON_BULKHEAD_LIMIT = 5

type Waiter = () => void
let inFlight = 0
const waiters: Waiter[] = []
let batch429Count = 0

export type HorizonBulkheadMetrics = {
  inFlight: number
  queued: number
  limit: number
  horizon_429_batch: number
}

function statusOf(error: unknown): number | undefined {
  const value = error as { status?: unknown; response?: { status?: unknown } } | null
  if (typeof value?.status === "number") return value.status
  if (typeof value?.response?.status === "number") return value.response.status
  return undefined
}

export function isHorizon429(error: unknown): boolean {
  return statusOf(error) === 429
}

export function getHorizonBulkheadMetrics(): HorizonBulkheadMetrics {
  return { inFlight, queued: waiters.length, limit: HORIZON_BULKHEAD_LIMIT, horizon_429_batch: batch429Count }
}

export function resetHorizonBulkheadMetrics(): void {
  batch429Count = 0
}

async function acquire(): Promise<() => void> {
  if (inFlight >= HORIZON_BULKHEAD_LIMIT) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  inFlight += 1
  let released = false
  return () => {
    if (released) return
    released = true
    inFlight -= 1
    waiters.shift()?.()
  }
}

export async function withHorizonBulkhead<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquire()
  try {
    return await operation()
  } catch (error) {
    if (isHorizon429(error)) batch429Count += 1
    throw error
  } finally {
    release()
  }
}
