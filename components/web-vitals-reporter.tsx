"use client"

import { useEffect } from "react"

export interface WebVitalsMetric {
  name: "LCP" | "FID" | "CLS" | "TTFB" | "INP"
  value: number
  rating: "good" | "needs-improvement" | "poor"
  delta: number
  id: string
}

const Web_Vitals_Thresholds = {
  LCP: { good: 2500, poor: 4000 },
  FID: { good: 100, poor: 300 },
  CLS: { good: 0.1, poor: 0.25 },
  TTFB: { good: 600, poor: 1200 },
  INP: { good: 200, poor: 500 },
}

function getRating(metric: string, value: number): "good" | "needs-improvement" | "poor" {
  const thresholds = Web_Vitals_Thresholds[metric as keyof typeof Web_Vitals_Thresholds]
  if (!thresholds) return "needs-improvement"
  if (value <= thresholds.good) return "good"
  if (value <= thresholds.poor) return "needs-improvement"
  return "poor"
}

export function WebVitalsReporter() {
  useEffect(() => {
    if (typeof window === "undefined") return

    const metrics: Partial<Record<string, WebVitalsMetric>> = {}

    const observeMetric = (name: string, value: number, delta: number, id: string) => {
      const rating = getRating(name, value)
      const metric: WebVitalsMetric = { name: name as any, value, rating, delta, id }

      metrics[name] = metric

      if (process.env.NODE_ENV === "development") {
        console.log(`[Web Vitals] ${name}: ${value.toFixed(2)}ms - ${rating}`)
      }

      if (typeof window.dataLayer !== "undefined") {
        window.dataLayer.push({
          event: "page_view",
          event_category: "web_vitals",
          event_label: name,
          value: Math.round(value),
          event_callback: () => {},
        })
      }
    }

    try {
      const po = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (entry.entryType === "largest-contentful-paint") {
            observeMetric("LCP", (entry as any).renderTime || (entry as any).loadTime, 0, entry.startTime as unknown as string)
          }
          if (entry.entryType === "first-input") {
            observeMetric("FID", (entry as any).processingDuration, (entry as any).processingDuration, entry.startTime as unknown as string)
          }
          if (entry.entryType === "layout-shift") {
            if (!(entry as any).hadRecentInput) {
              observeMetric("CLS", (entry as any).value * 100, (entry as any).value * 100, entry.startTime as unknown as string)
            }
          }
          if (entry.entryType === "navigation") {
            observeMetric("TTFB", (entry as any).responseStart - (entry as any).fetchStart, 0, entry.startTime as unknown as string)
          }
          if (entry.entryType === "interaction-to-next-paint") {
            observeMetric("INP", (entry as any).duration, (entry as any).duration, entry.startTime as unknown as string)
          }
        }
      })

      po.observe({ entryTypes: ["largest-contentful-paint", "first-input", "layout-shift", "navigation", "interaction-to-next-paint"] })

      return () => po.disconnect()
    } catch {
      if (process.env.NODE_ENV === "development") {
        console.warn("Web Vitals observer not supported")
      }
    }
  }, [])

  return null
}
