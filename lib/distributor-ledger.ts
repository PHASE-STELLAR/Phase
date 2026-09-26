// @ts-nocheck
/**
 * Distributor balance ledger (issue #231).
 *
 * The refill path is a classic check-then-act race: read the distributor's
 * balance, decide it is low, submit a mint. Two concurrent refills both read
 * the same balance and both submit, so the distributor ends up funded twice
 * what the threshold check authorised — and, in the inverse case, both decide
 * no refill is needed while the balance is already drained.
 *
 * `distributor-health-store.ts` is a UI-facing record store, not a
 * transactional balance: it is file-backed, holds no authoritative balance,
 * and any value it carries is a snapshot of when it was last written. Reading a
 * balance from it and then acting on that reading is the race.
 *
 * This module is the authoritative, transactional layer:
 *
 *   reserve(distributor, amount)  — atomically check-and-hold
 *   commitRefill(distributor, holdId, txHash)
 *   releaseRefill(distributor, holdId)
 *   availableBalance(distributor)
 *
 * `reserve` runs in a single IMMEDIATE transaction and is the only place a
 * decision to spend is made. `node:sqlite` serializes writers on one
 * connection per process, and `BEGIN IMMEDIATE` takes the write lock up front
 * so a concurrent caller cannot interleave between the check and the update —
 * which a bare `BEGIN` (deferred) would allow.
 *
 * The ledger records what is *reserved* as well as what is *paid*, so a refill
 * whose transaction is in flight is not double-authorised while it waits for
 * ledger confirmation.
 */

import { getDb } from "@/lib/sqlite-db"
import { incSecurityCounter } from "@/lib/security-counters"

export const DEFAULT_DISTRIBUTOR_RESERVE_STROOPS = 5_000_000 // 0.5 PHASELQ
export const DEFAULT_DISTRIBUTOR_FEE_RESERVE_STROOPS = 1_000_000 // 0.1 XLM for fees

export type ReserveOutcome =
  | { ok: true; holdId: string; availableBefore: string; amountStroops: string }
  | { ok: false; code: "UNKNOWN_DISTRIBUTOR" | "INSUFFICIENT_AVAILABLE" | "RESERVATION_CONFLICT"; reason: string; available: string; required: string }

function ensureLedgerTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS distributor_ledger (
      distributor     TEXT PRIMARY KEY,
      balance_stroops INTEGER NOT NULL DEFAULT 0,
      reserve_stroops INTEGER NOT NULL DEFAULT 0,
      fee_reserve_stroops INTEGER NOT NULL DEFAULT 0,
      version         INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL
    )
  `)
  db.exec(
    `CREATE TABLE IF NOT EXISTS distributor_reservations (
      id            TEXT PRIMARY KEY,
      distributor   TEXT NOT NULL,
      amount_stroops INTEGER NOT NULL,
      purpose       TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      state         TEXT NOT NULL DEFAULT 'held',
      horizon_tx_hash TEXT
    )`,
  )
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_distributor_reservations_open ON distributor_reservations (distributor, state)",
  )
}

export type LedgerRow = {
  distributor: string
  balance_stroops: number
  reserve_stroops: number
  fee_reserve_stroops: number
  version: number
  updated_at: number
}

/** Create the ledger row if absent, and return the current row. */
export function ensureDistributorLedger(
  distributor: string,
  opts: { balanceStroops?: number; reserveStroops?: number; feeReserveStroops?: number } = {},
): LedgerRow {
  ensureLedgerTable()
  const db = getDb()
  const now = Date.now()

  db.prepare(
    `INSERT INTO distributor_ledger
       (distributor, balance_stroops, reserve_stroops, fee_reserve_stroops, version, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT (distributor) DO NOTHING`,
  ).run(
    distributor,
    opts.balanceStroops ?? 0,
    opts.reserveStroops ?? DEFAULT_DISTRIBUTOR_RESERVE_STROOPS,
    opts.feeReserveStroops ?? DEFAULT_DISTRIBUTOR_FEE_RESERVE_STROOPS,
    now,
  )

  return readLedger(distributor)!
}

export function readLedger(distributor: string): LedgerRow | null {
  ensureLedgerTable()
  const row = getDb()
    .prepare("SELECT * FROM distributor_ledger WHERE distributor = ?")
    .get(distributor) as LedgerRow | undefined
  return row ?? null
}

/** Sum of reservations still held (refill submitted, not yet confirmed). */
export function pendingReservedStroops(distributor: string): number {
  ensureLedgerTable()
  const row = getDb()
    .prepare(
      "SELECT COALESCE(SUM(amount_stroops), 0) AS total FROM distributor_reservations WHERE distributor = ? AND state = 'held'",
    )
    .get(distributor) as { total: number }
  return Number(row?.total ?? 0)
}

/**
 * What may actually be spent: balance minus the reserve that must not be
 * drained, minus fees that must stay available, minus anything already
 * reserved by an in-flight refill.
 *
 * The issue calls for `availableBalance = balance - reserve - pending`; the
 * fee reserve is separated here because fees come out of native XLM and
 * draining it below the transaction fee strands every later settlement.
 */
export function availableBalance(distributor: string): bigint {
  const row = readLedger(distributor)
  if (!row) return 0n
  const pending = BigInt(pendingReservedStroops(distributor))
  const value =
    BigInt(row.balance_stroops) - BigInt(row.reserve_stroops) - BigInt(row.fee_reserve_stroops) - pending
  return value > 0n ? value : 0n
}

/** Record an authoritative balance observed from the network. */
export function setLedgerBalance(
  distributor: string,
  balanceStroops: string | number,
  now: number = Date.now(),
): LedgerRow {
  ensureLedgerTable()
  const db = getDb()
  db.prepare(
    `UPDATE distributor_ledger
        SET balance_stroops = ?, version = version + 1, updated_at = ?
      WHERE distributor = ?`,
  ).run(BigInt(balanceStroops), now, distributor)
  return readLedger(distributor)!
}

/**
 * Atomically reserve `amountStroops` for a spend.
 *
 * The check and the hold happen in one IMMEDIATE transaction. Under
 * `BEGIN IMMEDIATE` the write lock is taken before the balance is read, so two
 * concurrent callers cannot both observe the same available balance and both
 * proceed — which is exactly the double-spend this issue describes.
 *
 * Returns a `holdId` the caller must `commitRefill` or `releaseRefill`.
 */
export function reserveFunds(input: {
  distributor: string
  amountStroops: string | number
  purpose: string
  now?: number
}): ReserveOutcome {
  ensureLedgerTable()
  const db = getDb()
  const now = input.now ?? Date.now()
  const amount = BigInt(input.amountStroops)

  if (amount <= 0n) {
    return { ok: false, code: "INSUFFICIENT_AVAILABLE", reason: "amount must be positive", available: "0", required: String(amount) }
  }

  const holdId = `hold:${input.distributor}:${now}:${Math.random().toString(36).slice(2, 10)}`

  // IMMEDIATE, not deferred: take the write lock before reading the balance.
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db
      .prepare("SELECT * FROM distributor_ledger WHERE distributor = ?")
      .get(input.distributor) as LedgerRow | undefined

    if (!row) {
      db.exec("ROLLBACK")
      return {
        ok: false,
        code: "UNKNOWN_DISTRIBUTOR",
        reason: "no ledger row for this distributor",
        available: "0",
        required: String(amount),
      }
    }

    const pending = BigInt(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_stroops), 0) AS total FROM distributor_reservations WHERE distributor = ? AND state = 'held'",
          )
          .get(input.distributor) as { total: number }
      ).total ?? 0,
    )

    const available =
      BigInt(row.balance_stroops) - BigInt(row.reserve_stroops) - BigInt(row.fee_reserve_stroops) - pending
    const usable = available > 0n ? available : 0n

    if (usable < amount) {
      db.exec("ROLLBACK")
      incSecurityCounter("distributor_refill_race")
      return {
        ok: false,
        code: "INSUFFICIENT_AVAILABLE",
        reason: `available ${usable} is less than required ${amount}`,
        available: String(usable),
        required: String(amount),
      }
    }

    db.prepare(
      `INSERT INTO distributor_reservations (id, distributor, amount_stroops, purpose, created_at, state)
       VALUES (?, ?, ?, ?, ?, 'held')`,
    ).run(holdId, input.distributor, String(amount), input.purpose, now)

    db.prepare(
      "UPDATE distributor_ledger SET version = version + 1, updated_at = ? WHERE distributor = ?",
    ).run(now, input.distributor)

    db.exec("COMMIT")

    return { ok: true, holdId, availableBefore: String(usable), amountStroops: String(amount) }
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back
    }
    throw error
  }
}

/** Settle a held reservation: the refill transaction reached the ledger. */
export function commitRefill(holdId: string, horizonTxHash: string | null): boolean {
  ensureLedgerTable()
  const db = getDb()
  const result = db
    .prepare("UPDATE distributor_reservations SET state = 'committed', horizon_tx_hash = ? WHERE id = ? AND state = 'held'")
    .run(horizonTxHash, holdId)
  if (Number(result.changes) === 0) return false
  incSecurityCounter("distributor_refill_succeeded")
  return true
}

/**
 * Give a held reservation back.
 *
 * A refill that failed to submit (RPC rejection, timeout, `opUnderfunded`)
 * must release its hold, or the funds stay reserved forever and the
 * distributor reads as underfunded even after the ledger is topped up.
 */
export function releaseRefill(holdId: string): boolean {
  ensureLedgerTable()
  const db = getDb()
  const result = db
    .prepare("UPDATE distributor_reservations SET state = 'released' WHERE id = ? AND state = 'held'")
    .run(holdId)
  return Number(result.changes) > 0
}

/**
 * A settlement (classic-liq, x402, faucet, forge) is authorised only against a
 * *fresh* ledger read inside the same transaction as its reservation.
 */
export function authorizeSettlement(input: {
  distributor: string
  amountStroops: string | number
  purpose: string
  now?: number
}): ReserveOutcome {
  return reserveFunds(input)
}

/** Diagnostics: version, pending reservations, and staleness of the balance. */
export function distributorLedgerStats(distributor: string, now: number = Date.now()) {
  const row = readLedger(distributor)
  if (!row) return null
  const pending = pendingReservedStroops(distributor)
  const ageMs = Math.max(0, now - row.updated_at)
  if (ageMs > 30_000) {
    incSecurityCounter("distributor_available_balance_stale")
  }
  return {
    distributor,
    balanceStroops: String(row.balance_stroops),
    reserveStroops: String(row.reserve_stroops),
    feeReserveStroops: String(row.fee_reserve_stroops),
    pendingReservedStroops: String(pending),
    availableStroops: String(availableBalance(distributor)),
    version: row.version,
    balanceAgeMs: ageMs,
  }
}

/** Test seam: drop a distributor's ledger and reservations. */
export function resetLedgerForTests(distributor?: string): void {
  ensureLedgerTable()
  const db = getDb()
  if (distributor) {
    db.prepare("DELETE FROM distributor_reservations WHERE distributor = ?").run(distributor)
    db.prepare("DELETE FROM distributor_ledger WHERE distributor = ?").run(distributor)
    return
  }
  db.exec("DELETE FROM distributor_reservations;")
  db.exec("DELETE FROM distributor_ledger;")
}
