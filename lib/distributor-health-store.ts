/**
 * Distributor Health Status Store
 * 
 * Stores health check results for UI display and historical tracking
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { serverDataJsonPath } from "./server-data-paths"

export interface HealthCheckRecord {
  distributorAddress: string
  issuerAddress: string
  distributorPhaseLiqStroops: string | null
  distributorXlm: number | null
  issuerPhaseLiqStroops: string | null
  issuerXlm: number | null
  status: "healthy" | "warning" | "critical" | "error"
  message: string
  checkedAt: number
}

export interface HealthHistory {
  current: HealthCheckRecord | null
  history: HealthCheckRecord[]
  lastRefillAt: number | null
}

const MAX_HISTORY_RECORDS = 100

function healthStorePath(): string {
  return serverDataJsonPath("distributorHealth" as any)
}

async function readHealthHistory(): Promise<HealthHistory> {
  try {
    const raw = await readFile(healthStorePath(), "utf8")
    const parsed = JSON.parse(raw) as HealthHistory
    return {
      current: parsed.current ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      lastRefillAt: parsed.lastRefillAt ?? null,
    }
  } catch {
    return {
      current: null,
      history: [],
      lastRefillAt: null,
    }
  }
}

async function writeHealthHistory(data: HealthHistory): Promise<void> {
  const file = healthStorePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), "utf8")
}

/**
 * Record a health check
 */
export async function recordHealthCheck(record: HealthCheckRecord): Promise<void> {
  const data = await readHealthHistory()
  
  data.current = record
  data.history.unshift(record)
  
  // Keep only last N records
  if (data.history.length > MAX_HISTORY_RECORDS) {
    data.history = data.history.slice(0, MAX_HISTORY_RECORDS)
  }
  
  await writeHealthHistory(data)
}

/**
 * Get current health status
 */
export async function getDistributorHealthStatus(): Promise<HealthCheckRecord | null> {
  const data = await readHealthHistory()
  return data.current
}

/**
 * Get health history
 */
export async function getHealthHistory(limit: number = 20): Promise<HealthCheckRecord[]> {
  const data = await readHealthHistory()
  return data.history.slice(0, limit)
}

/**
 * Record a successful refill
 */
export async function recordRefill(): Promise<void> {
  const data = await readHealthHistory()
  data.lastRefillAt = Date.now()
  await writeHealthHistory(data)
}

/**
 * Get last refill timestamp
 */
export async function getLastRefillTime(): Promise<number | null> {
  const data = await readHealthHistory()
  return data.lastRefillAt
}

/**
 * Calculate time until next check (for UI countdown)
 */
export function getTimeUntilNextCheck(lastCheckAt: number, intervalMinutes: number = 60): number {
  const now = Date.now()
  const nextCheck = lastCheckAt + (intervalMinutes * 60 * 1000)
  return Math.max(0, nextCheck - now)
}

/**
 * Get health status summary for UI
 */
export async function getHealthSummary(): Promise<{
  current: HealthCheckRecord | null
  recentHistory: HealthCheckRecord[]
  lastRefillAt: number | null
  timeUntilNextCheck: number
}> {
  const data = await readHealthHistory()
  const recentHistory = data.history.slice(0, 5)
  const timeUntilNextCheck = data.current 
    ? getTimeUntilNextCheck(data.current.checkedAt, 60)
    : 0

  return {
    current: data.current,
    recentHistory,
    lastRefillAt: data.lastRefillAt,
    timeUntilNextCheck,
  }
}
