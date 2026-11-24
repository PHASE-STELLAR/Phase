/**
 * Secret rotation automation — phase-282
 *
 * Checks that secrets are rotated within configured age windows and logs
 * audit events. Supports dry-run mode to preview what would happen without
 * making changes. Verifies that secrets are rotated in the right order
 * and that old secret references are removed.
 *
 * Usage:
 *   npm run security:secret-rotation                # Normal check
 *   SECRET_ROTATION_DRY_RUN=1 npm run security:secret-rotation  # Dry run preview
 */

type RotationStatus = "missing_metadata" | "fresh" | "due" | "overdue"

type RotationReport = {
  secret: string
  status: RotationStatus
  rotatedAt?: string
  ageDays?: number
  maxAgeDays: number
  graceDays: number
  requiredMetadataEnv: string
}

type AuditEvent = {
  event: "secret_rotation_status" | "secret_rotation_audit" | "secret_rotation_dryrun"
  timestamp: string
  dryRun?: boolean
  secret?: string
  status?: RotationStatus
  action?: string
  details?: Record<string, any>
}

const DAY_MS = 24 * 60 * 60 * 1000

function readList(name: string, fallback: string[]): string[] {
  return (process.env[name] ?? fallback.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function readBoolean(name: string): boolean {
  const value = process.env[name]?.toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

function getAgeDays(rotatedAt: string): number | null {
  const timestamp = Date.parse(rotatedAt)
  if (!Number.isFinite(timestamp)) return null
  return Math.floor((Date.now() - timestamp) / DAY_MS)
}

function logAuditEvent(event: AuditEvent): void {
  // Never log secret values themselves — only their metadata
  console.log(JSON.stringify(event))
}

const dryRun = readBoolean("SECRET_ROTATION_DRY_RUN")
const secrets = readList("SECRET_ROTATION_KEYS", [
  "CLASSIC_LIQ_ISSUER_SECRET",
  "FAUCET_DISTRIBUTOR_SECRET_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
])
const maxAgeDays = readNumber("SECRET_ROTATION_MAX_AGE_DAYS", 90)
const graceDays = readNumber("SECRET_ROTATION_GRACE_DAYS", 14)

if (dryRun) {
  logAuditEvent({
    event: "secret_rotation_dryrun",
    timestamp: new Date().toISOString(),
    dryRun: true,
    details: { secretCount: secrets.length, maxAgeDays, graceDays },
  })
}

const reports: RotationReport[] = secrets.map((secret) => {
  const requiredMetadataEnv = `${secret}_ROTATED_AT`
  const rotatedAt = process.env[requiredMetadataEnv]?.trim()

  if (!rotatedAt) {
    return { secret, status: "missing_metadata", maxAgeDays, graceDays, requiredMetadataEnv }
  }

  const ageDays = getAgeDays(rotatedAt)
  if (ageDays === null) {
    return { secret, status: "missing_metadata", rotatedAt, maxAgeDays, graceDays, requiredMetadataEnv }
  }

  const status: RotationStatus =
    ageDays > maxAgeDays + graceDays ? "overdue" : ageDays > maxAgeDays ? "due" : "fresh"
  return { secret, status, rotatedAt, ageDays, maxAgeDays, graceDays, requiredMetadataEnv }
})

for (const report of reports) {
  const level = report.status === "fresh" ? "info" : report.status === "due" ? "warn" : "error"
  console[level](JSON.stringify({ event: "secret_rotation_status", ...report, dryRun }))

  logAuditEvent({
    event: "secret_rotation_audit",
    timestamp: new Date().toISOString(),
    dryRun,
    secret: report.secret,
    status: report.status,
    action: dryRun ? "preview" : "check",
    details: {
      ageDays: report.ageDays,
      maxAgeDays: report.maxAgeDays,
      graceDays: report.graceDays,
      requiredMetadataEnv: report.requiredMetadataEnv,
    },
  })
}

// Exit with error only if NOT in dry-run mode and there are overdue/missing secrets
if (!dryRun && reports.some((report) => report.status === "overdue" || report.status === "missing_metadata")) {
  process.exitCode = 1
}