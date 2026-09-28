/**
 * Module #67 — Toaster notification system with queueing and priority.
 *
 * PROBLEM BEING SOLVED:
 * The prior app used sonner toasts directly from many call sites. Under
 * concurrent flows (explore pagination, quick retry, world-filter swaps) two or
 * more toasts could be emitted "simultaneously". Sonner's default behaviour
 * surfaces a single active toast per position, so messages silently overwrote
 * each other — important errors were lost and UX became non-deterministic.
 *
 * THIS MODULE:
 * - Queues toasts instead of dumping them onto the viewport. `push` only
 *   enqueues; emission happens on an explicit `flush`/`drain`.
 * - Assigns a priority; higher-priority toasts preempt lower ones on flush.
 * - Deduplicates identical messages within a time window so bursts don't spam
 *   (and re-renders, e.g. React StrictMode, don't emit twice).
 * - Is fully pure/testable (no sonner import here — the emitter is injected).
 */

/**
 * Ordinal priority. Higher numbers preempt lower ones.
 * - crash / blocking errors => highest
 * - warn / transient errors  => medium-high
 * - info / success           => lowest
 */
export const ToastPriority = {
  info: 0,
  success: 1,
  warn: 2,
  error: 3,
  crash: 4,
} as const

export type ToastPriorityKey = keyof typeof ToastPriority

export type ToastKind = "success" | "error" | "info" | "warning" | "default"

export interface QueuedToast {
  /** Stable identity used for dedupe. */
  key: string
  kind: ToastKind
  message: string
  title?: string
  priority: number
  /** Epoch ms; used to keep FIFO ordering within the same priority. */
  enqueuedAt: number
  duration?: number
}

export interface ToastEmitTarget {
  success(message: string, options?: Record<string, unknown>): void
  error(message: string, options?: Record<string, unknown>): void
  info(message: string, options?: Record<string, unknown>): void
  warning(message: string, options?: Record<string, unknown>): void
  default(message: string, options?: Record<string, unknown>): void
}

const KIND_TO_KEY = {
  success: ToastPriority.success,
  error: ToastPriority.error,
  info: ToastPriority.info,
  warning: ToastPriority.warn,
  default: ToastPriority.info,
} as const

/** Default window during which an already-seen toast is suppressed. */
export const DEFAULT_DEDUPE_WINDOW_MS = 5_000

export class ToastQueue {
  private queue: QueuedToast[] = []
  /** key -> last-seen epoch ms within the dedupe window. */
  private seen = new Map<string, number>()
  private readonly emit: ToastEmitTarget
  private readonly maxVisible: number
  private readonly dedupeWindowMs: number

  constructor(
    emit: ToastEmitTarget,
    options?: { maxVisible?: number; dedupeWindowMs?: number },
  ) {
    this.emit = emit
    this.maxVisible = options?.maxVisible ?? 1
    this.dedupeWindowMs = options?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS
  }

  private static keyOf(kind: ToastKind, message: string): string {
    return `${kind}::${message}`
  }

  get size(): number {
    return this.queue.length
  }

  get pending(): readonly QueuedToast[] {
    return this.queue
  }

  /**
   * Enqueue a toast. Suppressed (returns false) when an identical toast was
   * seen within the dedupe window, so bursts collapse into a single entry.
   */
  push(
    kind: ToastKind,
    message: string,
    options?: { title?: string; priority?: number; duration?: number },
  ): boolean {
    const key = ToastQueue.keyOf(kind, message)
    const now = Date.now()
    const lastSeen = this.seen.get(key)
    if (lastSeen !== undefined && now - lastSeen < this.dedupeWindowMs) {
      return false
    }
    this.seen.set(key, now)

    this.queue.push({
      key,
      kind,
      message,
      title: options?.title,
      priority: options?.priority ?? KIND_TO_KEY[kind] ?? ToastPriority.info,
      enqueuedAt: now,
      duration: options?.duration,
    })
    return true
  }

  /**
   * Emit the highest-priority toasts, honouring FIFO within a priority and
   * capping simultaneous emissions at `maxVisible` so messages never clobber.
   * Surplus stays queued for a later flush. Returns how many were emitted.
   */
  flush(): number {
    if (this.queue.length === 0) return 0
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)

    const toEmit = this.queue.splice(0, this.maxVisible)

    for (const toast of toEmit) {
      const options: Record<string, unknown> = {}
      if (toast.title) options.description = toast.title
      if (toast.duration != null) options.duration = toast.duration
      switch (toast.kind) {
        case "success":
          this.emit.success(toast.message, options)
          break
        case "error":
          this.emit.error(toast.message, options)
          break
        case "info":
          this.emit.info(toast.message, options)
          break
        case "warning":
          this.emit.warning(toast.message, options)
          break
        default:
          this.emit.default(toast.message, options)
      }
    }
    return toEmit.length
  }

  /** Flush everything remaining, most important first, one batch at a time. */
  drain(): number {
    let total = 0
    while (this.queue.length > 0) total += this.flush()
    return total
  }

  /** Drop all queued but not-yet-emitted toasts (e.g. on unmount / reset). */
  clear(): void {
    this.queue = []
  }

  /** Drop everything: pending queue AND the dedupe window. */
  reset(): void {
    this.clear()
    this.seen.clear()
  }
}

/** Shorthand helpers for the common kinds. */
export type ToastQueueApi = {
  info(message: string, options?: { title?: string; duration?: number }): void
  success(message: string, options?: { title?: string; duration?: number }): void
  warn(message: string, options?: { title?: string; duration?: number }): void
  error(message: string, options?: { title?: string; duration?: number }): void
}