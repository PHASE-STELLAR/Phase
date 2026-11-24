import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { serverDataJsonPath } from "@/lib/server-data-paths"

/**
 * Sync, deterministic store for pool activity rows.
 *
 * The phase-182 activity feed is small (one row per verified swap/deposit) and
 * the screening helpers are synchronous, so a single JSON sidecar is enough.
 * Writes are atomic via a sibling temp file + rename, and dedupe is keyed by
 * the activity id (usually `swap:<txHash>`), so a retry after a serverless
 * timeout cannot double-count volume.
 */

export type PoolActivityRow = {
  id: string
  pool_id: string
  wallet: string
  counterparty: string | null
  kind: "deposit" | "withdraw" | "swap"
  amount_a: string
  amount_b: string
  value_xlm_stroops: string
  wash_flagged: 0 | 1
  wash_reason: string | null
  created_at: number
}

function filePath(): string {
  return serverDataJsonPath("poolActivity")
}

export function readPoolActivityRows(): PoolActivityRow[] {
  try {
    const raw = readFileSync(filePath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as PoolActivityRow[]) : []
  } catch {
    return []
  }
}

export function insertPoolActivityRow(row: PoolActivityRow): void {
  const rows = readPoolActivityRows()
  if (rows.some((r) => r.id === row.id)) return
  rows.push(row)
  const file = filePath()
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8")
  renameSync(tmp, file)
}

export function hasRecentPoolDeposit(poolId: string, wallet: string, since: number): boolean {
  const upper = wallet.trim().toUpperCase()
  return readPoolActivityRows().some(
    (r) => r.pool_id === poolId && r.wallet === upper && r.kind === "deposit" && r.created_at >= since,
  )
}
