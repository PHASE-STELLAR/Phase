/**
 * Analytics warehouse export: schema-versioned NDJSON and Parquet, redacted.
 * Spike 618 / Issue #481.
 *
 * The warehouse is a flat, append-only row model (`table`, `ts`, `metric`,
 * `value`, `status`, `wallet_fingerprint`) collected from three sources:
 * process counters, distributor health history and wash-excluded market
 * volume. Two output formats share one manifest:
 *
 *   - NDJSON: first line is a manifest object (`schema`, `version`,
 *     `row_count`, `checksum`), then one row per line — the streaming shape
 *     `lib/narrative-world-store.ts` established.
 *   - Parquet: columnar buffer via `hyparquet-writer`, with the same manifest
 *     in `key_value_metadata` (`phase.schema_version`, `phase.checksum`, …).
 *
 * Redaction is unconditional: exports never contain raw `G...` addresses or
 * `S...` seeds. Wallet fields become `fingerprintWallet()` strings and any
 * wallet/secret-looking text inside metric or status is rewritten in place
 * (`redactWarehouseRow`). Flag: phase-180.
 * Rollback: unset the flag — the export route 404s and no stored state needs
 * reversing; the Parquet/NDJSON helpers stay importable for tests.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { parquetWriteBuffer } from "hyparquet-writer"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { computeSha256 } from "@/lib/data-portability"
import { fingerprintWallet, redactSecretKeys, WALLET_KEY_RE } from "@/lib/redaction"
import { snapshotSecurityCounters } from "@/lib/security-counters"
import { getHealthHistory } from "@/lib/distributor-health-store"
import { getDb } from "@/lib/sqlite-db"

export const WAREHOUSE_SCHEMA = "phase-warehouse-export"
export const WAREHOUSE_SCHEMA_VERSION = "1.0.0"

export const WAREHOUSE_TABLES = ["counter", "health", "volume"] as const
export type WarehouseTable = (typeof WAREHOUSE_TABLES)[number]

export type WarehouseRow = {
  table: WarehouseTable
  ts: number
  metric: string
  value: number | null
  status: string | null
  wallet_fingerprint: string | null
}

export function isWarehouseExportEnabled(): boolean {
  return isFeatureEnabled("phase-180")
}

export function isWarehouseIntegrationExportEnabled(): boolean {
  return isFeatureEnabled("phase-253")
}

// ── phase-176 (spike 610): unified event recording ─────────────────────────
// Restored after a merge left the callers (faucet, notifications, forge,
// achievements) importing functions this module no longer exported. The event
// table is the one `lib/funnel-retention.ts` already queries.

export function isAnalyticsWarehouseEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-176", wallet ? { wallet } : undefined)
}

export type WarehouseEventInput = {
  surface: string
  stage: string
  wallet?: string | null
  sessionId?: string | null
  session_id?: string | null
  reason?: string | null
  correlation_id?: string | null
  metadata?: Record<string, unknown>
  now?: number
  /** Forward-compatible: event payloads may add fields without a type break. */
  [key: string]: unknown
}

export function ensureAnalyticsEventTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      event_id   TEXT PRIMARY KEY,
      surface    TEXT NOT NULL,
      stage      TEXT NOT NULL,
      wallet     TEXT,
      session_id TEXT,
      metadata   TEXT,
      ts         INTEGER NOT NULL
    )
  `)
  getDb().exec("CREATE INDEX IF NOT EXISTS idx_analytics_events_surface_ts ON analytics_events (surface, ts)")
  getDb().exec("CREATE INDEX IF NOT EXISTS idx_analytics_events_wallet_ts ON analytics_events (wallet, ts)")
}

/**
 * Append one event. Metadata is JSON-encoded but never used as a counter label;
 * the closed-label rule applies to security counters, not to this row store.
 */
export async function recordWarehouseEvent(
  input: WarehouseEventInput,
): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!isAnalyticsWarehouseEnabled(input.wallet ?? undefined)) return { ok: true, skipped: true }
  const now = input.now ?? Date.now()
  const eventId = createHash("sha256")
    .update(`${input.surface}|${input.stage}|${input.wallet ?? ""}|${now}|${Math.random()}`)
    .digest("hex")
  ensureAnalyticsEventTable()
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO analytics_events
        (event_id, surface, stage, wallet, session_id, metadata, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      input.surface,
      input.stage,
      input.wallet ?? null,
      input.sessionId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    )
  return { ok: true }
}

/** Stage counts for one surface over a window (read-only operator view). */
export async function getUnifiedFunnelAnalytics(opts: {
  surface: string
  windowMs?: number
  now?: number
}): Promise<{
  surface: string
  window_ms: number
  total: number
  unique_subjects: number
  stages: Array<{ stage: string; count: number }>
}> {
  ensureAnalyticsEventTable()
  const now = opts.now ?? Date.now()
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000
  const rows = getDb()
    .prepare(
      `SELECT stage, COUNT(*) AS count FROM analytics_events
        WHERE surface = ? AND ts >= ? GROUP BY stage ORDER BY count DESC`,
    )
    .all(opts.surface, now - windowMs) as Array<{ stage: string; count: number }>
  const subjects = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(wallet, session_id)) AS n FROM analytics_events
        WHERE surface = ? AND ts >= ?`,
    )
    .get(opts.surface, now - windowMs) as { n?: number }
  const stages = rows.map((r) => ({ stage: r.stage, count: Number(r.count) }))
  return {
    surface: opts.surface,
    window_ms: windowMs,
    total: stages.reduce((sum, s) => sum + s.count, 0),
    unique_subjects: Number(subjects?.n ?? 0),
    stages,
  }
}

export function warehouse180RollbackNote(): string {
  return "Rollback phase-180: unset NEXT_PUBLIC_FEATURE_PHASE_180 / FEATURE_PHASE_180 or set 0/false and restart. The export route 404s; no stored warehouse state exists."
}

export class WarehouseExportError extends Error {
  readonly code: "FLAG_DISABLED" | "UNAUTHORIZED" | "EXPORT_FAILED"
  readonly details?: unknown
  constructor(code: WarehouseExportError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "WarehouseExportError"
    this.code = code
    this.details = details
  }
}

// ─── Redaction ───────────────────────────────────────────────────────────────

/** Fingerprints raw wallets and strips secrets from free text. */
export function redactWarehouseText(text: string): string {
  if (!text) return text
  return redactSecretKeys(text).replace(WALLET_KEY_RE, (wallet) => fingerprintWallet(wallet))
}

/**
 * Makes one row safe for export. `wallet_fingerprint` is only ever written by
 * collectors as a raw address (the field name describes the post-redaction
 * role), so a raw `G...` here is fingerprinted rather than trusted. A fresh
 * non-global regex because `WALLET_KEY_RE` carries `/g` and `.test()` on it is
 * stateful across calls.
 */
const FULL_WALLET_RE = /^G[A-Z2-7]{55}$/

export function redactWarehouseRow(row: WarehouseRow): WarehouseRow {
  return {
    ...row,
    metric: redactWarehouseText(row.metric),
    status: row.status === null ? null : redactWarehouseText(row.status),
    wallet_fingerprint:
      row.wallet_fingerprint === null
        ? null
        : FULL_WALLET_RE.test(row.wallet_fingerprint)
          ? fingerprintWallet(row.wallet_fingerprint)
          : redactWarehouseText(row.wallet_fingerprint),
  }
}

export function redactWarehouseRows(rows: WarehouseRow[]): WarehouseRow[] {
  return rows.map(redactWarehouseRow)
}

// ─── Collectors ─────────────────────────────────────────────────────────────

export type CollectOptions = {
  now?: number
  healthLimit?: number
  volumeWindowMs?: number
}

export const DEFAULT_VOLUME_WINDOW_MS = 24 * 60 * 60 * 1000

export function collectCounterRows(now: number = Date.now()): WarehouseRow[] {
  const snapshot = snapshotSecurityCounters()
  return Object.entries(snapshot).map(([metric, value]) => ({
    table: "counter" as const,
    ts: now,
    metric,
    value,
    status: null,
    wallet_fingerprint: null,
  }))
}

export async function collectHealthRows(
  opts: CollectOptions = {},
): Promise<WarehouseRow[]> {
  const history = await getHealthHistory(opts.healthLimit ?? 50)
  return history.map((record) => ({
    table: "health" as const,
    ts: record.checkedAt,
    metric: "distributor_health",
    value: record.distributorXlm,
    status: record.status,
    wallet_fingerprint: record.distributorAddress || null,
  })).concat(
    history.map((record) => ({
      table: "health" as const,
      ts: record.checkedAt,
      metric: "distributor_phase_liq_stroops",
      value: record.distributorPhaseLiqStroops === null ? null : Number(record.distributorPhaseLiqStroops),
      status: record.status,
      wallet_fingerprint: record.issuerAddress || null,
    })),
  )
}

export async function collectVolumeRows(
  opts: CollectOptions = {},
): Promise<WarehouseRow[]> {
  const now = opts.now ?? Date.now()
  const since = now - (opts.volumeWindowMs ?? DEFAULT_VOLUME_WINDOW_MS)
  try {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(amount_phaselq), 0) AS total, COUNT(*) AS offers
           FROM offers
          WHERE status = 'accepted' AND wash_flagged = 0 AND created_at >= ?`,
      )
      .get(since) as { total: number; offers: number }
    return [
      {
        table: "volume",
        ts: now,
        metric: "market_volume_phaselq_24h",
        value: Number(row?.total ?? 0),
        status: null,
        wallet_fingerprint: null,
      },
      {
        table: "volume",
        ts: now,
        metric: "market_offers_accepted_24h",
        value: Number(row?.offers ?? 0),
        status: null,
        wallet_fingerprint: null,
      },
    ]
  } catch {
    // A missing/unmigrated database yields no rows rather than failing the export.
    return []
  }
}

export async function collectWarehouseRows(opts: CollectOptions = {}): Promise<WarehouseRow[]> {
  const now = opts.now ?? Date.now()
  const [health, volume] = await Promise.all([collectHealthRows(opts), collectVolumeRows(opts)])
  return [...collectCounterRows(now), ...health, ...volume]
}

// ─── Manifest + formats ─────────────────────────────────────────────────────

export type WarehouseManifest = {
  schema: typeof WAREHOUSE_SCHEMA
  version: string
  generated_at: number
  row_count: number
  tables: string[]
  redacted: boolean
  checksum: string
}

/** Rows only — the checksum must be reproducible without the manifest line. */
export function warehouseRowsChecksum(rows: WarehouseRow[]): string {
  return computeSha256(rows.map((row) => JSON.stringify(row)).join("\n"))
}

export function buildWarehouseManifest(
  rows: WarehouseRow[],
  opts: { generatedAt?: number; redacted?: boolean } = {},
): WarehouseManifest {
  const tables = [...new Set(rows.map((row) => row.table))].sort()
  return {
    schema: WAREHOUSE_SCHEMA,
    version: WAREHOUSE_SCHEMA_VERSION,
    generated_at: opts.generatedAt ?? Date.now(),
    row_count: rows.length,
    tables,
    redacted: opts.redacted ?? true,
    checksum: warehouseRowsChecksum(rows),
  }
}

export function formatWarehouseNdjson(
  rows: WarehouseRow[],
  opts: { generatedAt?: number } = {},
): { manifest: WarehouseManifest; body: string } {
  const manifest = buildWarehouseManifest(rows, { generatedAt: opts.generatedAt, redacted: true })
  const body =
    JSON.stringify(manifest) +
    "\n" +
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length > 0 ? "\n" : "")
  return { manifest, body }
}

export function rowsToParquetBuffer(
  rows: WarehouseRow[],
  opts: { generatedAt?: number } = {},
): { manifest: WarehouseManifest; buffer: ArrayBuffer } {
  const manifest = buildWarehouseManifest(rows, { generatedAt: opts.generatedAt, redacted: true })
  try {
    const buffer = parquetWriteBuffer({
      columnData: [
        { name: "table", data: rows.map((row) => row.table), type: "STRING" },
        { name: "ts", data: rows.map((row) => BigInt(row.ts)), type: "INT64" },
        { name: "metric", data: rows.map((row) => row.metric), type: "STRING" },
        { name: "value", data: rows.map((row) => row.value), type: "DOUBLE" },
        { name: "status", data: rows.map((row) => row.status), type: "STRING" },
        { name: "wallet_fingerprint", data: rows.map((row) => row.wallet_fingerprint), type: "STRING" },
      ],
      kvMetadata: [
        { key: "phase.schema", value: manifest.schema },
        { key: "phase.schema_version", value: manifest.version },
        { key: "phase.generated_at", value: String(manifest.generated_at) },
        { key: "phase.row_count", value: String(manifest.row_count) },
        { key: "phase.checksum", value: manifest.checksum },
        { key: "phase.redacted", value: "true" },
      ],
    })
    return { manifest, buffer }
  } catch (error) {
    throw new WarehouseExportError(
      "EXPORT_FAILED",
      "Parquet encoding failed",
      error instanceof Error ? error.message : String(error),
    )
  }
}

// ── phase-253 (#704): signed one-use export grants, closed-label sanitization,
// paginated streaming with row cap, and audit event log ──

export const MAX_WAREHOUSE_EXPORT_ROWS = 1_000
export const DEFAULT_WAREHOUSE_PAGE_SIZE = 100
export const MAX_WAREHOUSE_PAGE_SIZE = 500
export const DEFAULT_EXPORT_GRANT_TTL_MS = 60_000
export const MAX_EXPORT_GRANT_TTL_MS = 300_000

const CID_RE = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,})\b/gi
const CLOSED_STATUS_LABELS = new Set(["ok", "degraded", "down", "accepted", "rejected", "unknown"])

function hashSubject(raw: string): string {
  return `subj_${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16)}`
}

export function sanitizeWarehouseTextClosed(text: string): string {
  if (!text) return text
  return redactWarehouseText(text).replace(CID_RE, "[REDACTED_CID]")
}

/**
 * Sanitizes a warehouse row to closed labels and hashed subjects — ensuring no
 * raw wallet (`G...`), secret (`S...`), or IPFS CID (`Qm...`/`bafy...`) leaks.
 */
export function sanitizeWarehouseRowClosed(row: WarehouseRow): WarehouseRow {
  const base = redactWarehouseRow(row)
  const safeTable: WarehouseTable = (WAREHOUSE_TABLES as readonly string[]).includes(base.table)
    ? base.table
    : "counter"
  const safeStatus =
    base.status === null
      ? null
      : CLOSED_STATUS_LABELS.has(base.status.toLowerCase())
        ? base.status.toLowerCase()
        : "unknown"
  const safeSubject =
    base.wallet_fingerprint === null
      ? null
      : CID_RE.test(base.wallet_fingerprint) || FULL_WALLET_RE.test(base.wallet_fingerprint)
        ? hashSubject(base.wallet_fingerprint)
        : sanitizeWarehouseTextClosed(base.wallet_fingerprint)

  return {
    table: safeTable,
    ts: base.ts,
    metric: sanitizeWarehouseTextClosed(base.metric),
    value: base.value,
    status: safeStatus,
    wallet_fingerprint: safeSubject,
  }
}

export function sanitizeWarehouseRowsClosed(rows: WarehouseRow[]): WarehouseRow[] {
  return rows.map(sanitizeWarehouseRowClosed)
}

function getExportGrantSecret(override?: string): string {
  return (
    override ??
    process.env.ANALYTICS_EXPORT_GRANT_SECRET ??
    process.env.ADMIN_API_KEY ??
    "phase-warehouse-export-grant-secret"
  )
}

function ensureExportGrantTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS warehouse_export_grants (
      grant_id   TEXT PRIMARY KEY,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      max_rows   INTEGER NOT NULL,
      used_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS warehouse_export_audit (
      audit_id   TEXT PRIMARY KEY,
      grant_id   TEXT,
      format     TEXT NOT NULL,
      row_count  INTEGER NOT NULL,
      truncated  INTEGER NOT NULL,
      status     TEXT NOT NULL,
      reason     TEXT,
      ts         INTEGER NOT NULL
    );
  `)
}

export type WarehouseExportGrant = {
  grantId: string
  token: string
  issuedAt: number
  expiresAt: number
  maxRows: number
}

export function issueWarehouseExportGrant(opts: {
  ttlMs?: number
  maxRows?: number
  now?: number
  secret?: string
} = {}): WarehouseExportGrant {
  const now = opts.now ?? Date.now()
  const ttlMs = Math.max(1_000, Math.min(MAX_EXPORT_GRANT_TTL_MS, opts.ttlMs ?? DEFAULT_EXPORT_GRANT_TTL_MS))
  const maxRows = Math.max(1, Math.min(MAX_WAREHOUSE_EXPORT_ROWS, opts.maxRows ?? MAX_WAREHOUSE_EXPORT_ROWS))
  const grantId = randomBytes(16).toString("hex")
  const expiresAt = now + ttlMs

  ensureExportGrantTables()
  getDb()
    .prepare(
      `INSERT INTO warehouse_export_grants (grant_id, issued_at, expires_at, max_rows, used_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(grantId, now, expiresAt, maxRows)

  const payload = `${grantId}.${issuedAtStr(now)}.${expiresAt}.${maxRows}`
  const sig = createHmac("sha256", getExportGrantSecret(opts.secret)).update(payload, "utf8").digest("hex")
  return {
    grantId,
    token: `${payload}.${sig}`,
    issuedAt: now,
    expiresAt,
    maxRows,
  }
}

function issuedAtStr(ts: number): string {
  return String(ts)
}

export type ConsumeGrantResult =
  | { ok: true; grantId: string; maxRows: number }
  | { ok: false; code: "INVALID_GRANT" | "EXPIRED_GRANT" | "GRANT_ALREADY_USED" }

export function consumeWarehouseExportGrant(
  token: string,
  opts: { now?: number; secret?: string } = {},
): ConsumeGrantResult {
  const parts = token.trim().split(".")
  if (parts.length !== 4) return { ok: false, code: "INVALID_GRANT" }
  const [grantId, issuedStr, expiresStr, maxRowsStr, ...rest] = [parts[0]!, parts[1]!, parts[2]!, ...parts.slice(3)]
  if (rest.length !== 1) return { ok: false, code: "INVALID_GRANT" }
  const sig = rest[0]!
  const payload = `${grantId}.${issuedStr}.${expiresStr}.${maxRowsStr}`
  const expectedSig = createHmac("sha256", getExportGrantSecret(opts.secret)).update(payload, "utf8").digest("hex")

  const sigBuf = Buffer.from(sig, "utf8")
  const expectedBuf = Buffer.from(expectedSig, "utf8")
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, code: "INVALID_GRANT" }
  }

  const expiresAt = Number(expiresStr)
  const maxRows = Number(maxRowsStr)
  const now = opts.now ?? Date.now()
  if (!Number.isFinite(expiresAt) || !Number.isFinite(maxRows) || maxRows <= 0) {
    return { ok: false, code: "INVALID_GRANT" }
  }
  if (now >= expiresAt) {
    return { ok: false, code: "EXPIRED_GRANT" }
  }

  ensureExportGrantTables()
  const existing = getDb()
    .prepare(`SELECT grant_id, used_at FROM warehouse_export_grants WHERE grant_id = ?`)
    .get(grantId) as { grant_id: string; used_at: number | null } | undefined
  if (!existing) return { ok: false, code: "INVALID_GRANT" }
  if (existing.used_at !== null) return { ok: false, code: "GRANT_ALREADY_USED" }

  const res = getDb()
    .prepare(`UPDATE warehouse_export_grants SET used_at = ? WHERE grant_id = ? AND used_at IS NULL`)
    .run(now, grantId)
  if (res.changes === 0) return { ok: false, code: "GRANT_ALREADY_USED" }

  return { ok: true, grantId, maxRows: Math.min(maxRows, MAX_WAREHOUSE_EXPORT_ROWS) }
}

export function paginateWarehouseRows(
  rows: WarehouseRow[],
  opts: { cursor?: number; limit?: number; rowCap?: number } = {},
): {
  rows: WarehouseRow[]
  nextCursor: number | null
  totalCapped: number
  truncated: boolean
} {
  const rowCap = Math.max(1, Math.min(MAX_WAREHOUSE_EXPORT_ROWS, opts.rowCap ?? MAX_WAREHOUSE_EXPORT_ROWS))
  const capped = rows.slice(0, rowCap)
  const truncated = rows.length > rowCap
  const cursor = Math.max(0, Math.floor(opts.cursor ?? 0))
  const limit = Math.max(1, Math.min(MAX_WAREHOUSE_PAGE_SIZE, opts.limit ?? DEFAULT_WAREHOUSE_PAGE_SIZE))
  const page = capped.slice(cursor, cursor + limit)
  const nextCursor = cursor + page.length < capped.length ? cursor + page.length : null
  return {
    rows: page,
    nextCursor,
    totalCapped: capped.length,
    truncated,
  }
}

export function streamWarehouseNdjson(
  rows: WarehouseRow[],
  opts: { pageSize?: number; rowCap?: number; generatedAt?: number } = {},
): { manifest: WarehouseManifest; stream: ReadableStream<Uint8Array>; truncated: boolean } {
  const rowCap = Math.max(1, Math.min(MAX_WAREHOUSE_EXPORT_ROWS, opts.rowCap ?? MAX_WAREHOUSE_EXPORT_ROWS))
  const sanitized = sanitizeWarehouseRowsClosed(rows.slice(0, rowCap))
  const truncated = rows.length > rowCap
  const pageSize = Math.max(1, Math.min(MAX_WAREHOUSE_PAGE_SIZE, opts.pageSize ?? DEFAULT_WAREHOUSE_PAGE_SIZE))
  const manifest = buildWarehouseManifest(sanitized, { generatedAt: opts.generatedAt, redacted: true })
  const encoder = new TextEncoder()

  let cursor = 0
  let sentManifest = false

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentManifest) {
        sentManifest = true
        controller.enqueue(encoder.encode(JSON.stringify(manifest) + "\n"))
        if (sanitized.length === 0) {
          controller.close()
        }
        return
      }
      if (cursor >= sanitized.length) {
        controller.close()
        return
      }
      const chunk = sanitized.slice(cursor, cursor + pageSize)
      cursor += chunk.length
      controller.enqueue(encoder.encode(chunk.map((r) => JSON.stringify(r)).join("\n") + "\n"))
      if (cursor >= sanitized.length) {
        controller.close()
      }
    },
  })

  return { manifest, stream, truncated }
}

export type WarehouseExportAuditEvent = {
  audit_id: string
  grant_id: string | null
  format: string
  row_count: number
  truncated: boolean
  status: "success" | "rejected"
  reason: string | null
  ts: number
}

export function appendWarehouseExportAuditEvent(input: {
  grantId?: string | null
  format: string
  rowCount: number
  truncated: boolean
  status: "success" | "rejected"
  reason?: string | null
  ts?: number
}): WarehouseExportAuditEvent {
  ensureExportGrantTables()
  const ts = input.ts ?? Date.now()
  const audit_id = randomBytes(12).toString("hex")
  const event: WarehouseExportAuditEvent = {
    audit_id,
    grant_id: input.grantId ?? null,
    format: input.format,
    row_count: input.rowCount,
    truncated: input.truncated,
    status: input.status,
    reason: input.reason ?? null,
    ts,
  }
  getDb()
    .prepare(
      `INSERT INTO warehouse_export_audit (audit_id, grant_id, format, row_count, truncated, status, reason, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.audit_id,
      event.grant_id,
      event.format,
      event.row_count,
      event.truncated ? 1 : 0,
      event.status,
      event.reason,
      event.ts,
    )
  return event
}

export function getWarehouseExportAuditEvents(limit = 50): WarehouseExportAuditEvent[] {
  ensureExportGrantTables()
  const rows = getDb()
    .prepare(`SELECT audit_id, grant_id, format, row_count, truncated, status, reason, ts FROM warehouse_export_audit ORDER BY ts DESC LIMIT ?`)
    .all(limit) as Array<{
    audit_id: string
    grant_id: string | null
    format: string
    row_count: number
    truncated: number
    status: "success" | "rejected"
    reason: string | null
    ts: number
  }>
  return rows.map((r) => ({ ...r, truncated: Boolean(r.truncated) }))
}
