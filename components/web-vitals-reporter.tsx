"use client"

/**
 * phase-213 — live RUM collector.
 *
 * Registers performance observers only when the phase-213 flag is on. Emits
 * LCP / INP / CLS to the closed-label `/api/rum/ingest` route using only:
 *   - a normalized route template (no query, wallet address or CID),
 *   - a SHA-256 hash of a per-session random UUID (never the UUID itself),
 *   - a numeric metric value and a timestamp.
 *
 * The component returns null; no DOM, no dataLayer, no PII.
 * Rollback: unset the flag → observers are never registered and nothing posts.
 */

import { useEffect } from "react"
import {
  createRumEvent,
  isRumCollectorEnabled,
  type VitalName,
} from "@/lib/web-vitals-budgets"

const SESSION_KEY = "phase-rum-session-v1"
const FLUSH_DELAY_MS = 15_000

async function hashedSessionId(): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) {
      raw = crypto.randomUUID()
      sessionStorage.setItem(SESSION_KEY, raw)
    }
  } catch {
    return null
  }
  const bytes = new TextEncoder().encode(raw) as BufferSource
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function send(event: ReturnType<typeof createRumEvent>): void {
  if (!event) return
  const body = JSON.stringify({ events: [event] })
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(
      "/api/rum/ingest",
      new Blob([body], { type: "application/json" }),
    )
    return
  }
  void fetch("/api/rum/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined)
}

export function WebVitalsReporter() {
  useEffect(() => {
    if (typeof window === "undefined") return
    // Flag off: no observers, no timers, no network.
    if (!isRumCollectorEnabled()) return

    let sessionHash: string | null = null
    const pending = new Map<VitalName, number>()
    let observer: PerformanceObserver | null = null
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    hashedSessionId()
      .then((hash) => {
        if (cancelled) return
        sessionHash = hash
      })
      .catch(() => undefined)

    const observe = (metric: VitalName, value: number) => {
      if (!Number.isFinite(value) || value < 0) return
      const previous = pending.get(metric)
      // Worst reading per metric, matching the CI p75 evaluation.
      if (previous === undefined || value > previous) pending.set(metric, value)
    }

    const flush = () => {
      if (cancelled || !sessionHash || pending.size === 0) return
      const route = window.location.pathname
      const ts = Date.now()
      for (const [metric, value] of pending) {
        send(createRumEvent({ route, metric, value, sessionHash, ts }))
      }
      pending.clear()
    }

    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "largest-contentful-paint") {
            const lcp = entry as PerformanceEntry & { renderTime?: number; loadTime?: number }
            observe("LCP", lcp.renderTime || lcp.loadTime || entry.startTime)
          } else if (entry.entryType === "layout-shift") {
            const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
            if (!shift.hadRecentInput) observe("CLS", (shift.value ?? 0) * 100)
          } else if (entry.entryType === "event") {
            // Longest interaction duration is a conservative INP approximation.
            observe("INP", entry.duration)
          }
        }
      })
      observer.observe({ type: "largest-contentful-paint", buffered: true })
      observer.observe({ type: "layout-shift", buffered: true })
      observer.observe({ type: "event", buffered: true })
    } catch {
      // Unsupported browser: collect nothing rather than sending bad data.
      observer?.disconnect()
      observer = null
      return
    }

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush()
    }
    document.addEventListener("visibilitychange", onVisibility)
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS)

    return () => {
      cancelled = true
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      if (flushTimer) clearTimeout(flushTimer)
    }
  }, [])

  return null
}
