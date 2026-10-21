"use client"

import { useCallback, useMemo } from "react"
import { toast } from "sonner"
import { ToastQueue, type ToastKind, type ToastQueueApi } from "@/lib/toast-queue"

const emitTarget = {
  success: (m: string, o?: Record<string, unknown>) => toast.success(m, o),
  error: (m: string, o?: Record<string, unknown>) => toast.error(m, o),
  info: (m: string, o?: Record<string, unknown>) => toast.info(m, o),
  warning: (m: string, o?: Record<string, unknown>) => toast.warning(m, o),
  default: (m: string, o?: Record<string, unknown>) => toast(m, o),
}

const MAX_VISIBLE = 1
/** Cadence for releasing queued toasts after the top-priority one shows. */
const RELEASE_MS = 400

/**
 * Shared singleton: every caller (explore pagination, retry, preview nav)
 * routes through ONE queue, so concurrent toasts are deduplicated and
 * priority-sorted globally instead of clobbering each other on the viewport.
 */
const sharedQueue = new ToastQueue(emitTarget, { maxVisible: MAX_VISIBLE })

let flushPending = false
let releaseTimer: ReturnType<typeof setTimeout> | null = null

function release(): void {
  flushPending = false
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  sharedQueue.flush()
  if (sharedQueue.size > 0) {
    releaseTimer = setTimeout(release, RELEASE_MS)
  }
}

/**
 * Batch: pushes made in the same synchronous tick are collected first, then a
 * single microtask flush emits the highest-priority one. Lower-priority toasts
 * are released on a short staggered cadence so nothing is lost.
 */
function scheduleRelease(): void {
  if (flushPending) return
  flushPending = true
  queueMicrotask(release)
}

/**
 * Hook exposing a queued, priority-aware, deduped toast API backed by sonner.
 * Because the queue is shared and emission is batched, concurrent callers
 * (pagination + retry + world-filter) never overwrite one another.
 */
export function useToastQueue(): ToastQueueApi {
  const push = useCallback(
    (kind: ToastKind, message: string, o?: { title?: string; duration?: number }) => {
      sharedQueue.push(kind, message, o)
      scheduleRelease()
    },
    [],
  )

  return useMemo<ToastQueueApi>(
    () => ({
      info: (message, o) => push("info", message, o),
      success: (message, o) => push("success", message, o),
      warn: (message, o) => push("warning", message, o),
      error: (message, o) => push("error", message, o),
    }),
    [push],
  )
}