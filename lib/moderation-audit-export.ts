/**
 * Audit exports for moderators and regulators with redaction and role-gating.
 * Spike 635 / Issue #497.
 *
 * Implements:
 * - Role-based access control ("moderator" vs "regulator")
 * - Cryptographic redaction of wallets and stripping of signatures for regulators
 * - Date-range and action filtering with cursor pagination
 * - Multi-format output: JSON, NDJSON (streaming), and RFC 4180 CSV
 *
 * Feature flag: phase-168.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_168 / FEATURE_PHASE_168; returns 404.
 */

import { isFeatureEnabled } from "@/lib/feature-flags";
import { readStore } from "@/lib/json-store";
import type { ModerationAuditEvent, ModerationAction } from "@/lib/moderation-audit";
import { fingerprintWallet, sanitizeModerationReason } from "@/lib/redaction";
import type {
  AuditExportFilter,
  AuditExportFormat,
  AuditExportResult,
  AuditExportRole,
  RedactedAuditEvent,
} from "@/lib/types/moderation-export";

export class ModerationAuditExportError extends Error {
  code: "FLAG_DISABLED" | "UNAUTHORIZED" | "INVALID_FILTER" | "UNSUPPORTED_FORMAT";
  constructor(code: ModerationAuditExportError["code"], message: string) {
    super(message);
    this.name = "ModerationAuditExportError";
    this.code = code;
  }
}

export function isAuditExport168Enabled(): boolean {
  return isFeatureEnabled("phase-168");
}

type ModerationAuditStore = Record<string, ModerationAuditEvent>;

async function readAuditStore(): Promise<ModerationAuditStore> {
  return readStore<ModerationAuditStore>("signalModerationAudit", () => ({}));
}

/**
 * Validates role-gated credentials.
 * - Moderator role requires PHASE_ADMIN_KEY or PHASE_MODERATOR_KEY.
 * - Regulator role requires PHASE_REGULATOR_TOKEN or PHASE_ADMIN_KEY.
 */
export function verifyAuditExportAuth(
  headers: Headers,
  role: AuditExportRole,
): { authorized: boolean; reason?: string } {
  const adminKey = process.env.PHASE_ADMIN_KEY?.trim();
  const modKey = process.env.PHASE_MODERATOR_KEY?.trim() || adminKey;
  const regKey = process.env.PHASE_REGULATOR_TOKEN?.trim() || adminKey;

  const providedAdmin = headers.get("x-admin-key")?.trim();
  const providedMod = headers.get("x-moderator-key")?.trim() || providedAdmin;
  const providedReg = headers.get("x-regulator-token")?.trim() || providedAdmin;

  if (role === "moderator") {
    if (modKey && providedMod !== modKey) {
      return { authorized: false, reason: "Invalid moderator credentials (x-moderator-key or x-admin-key required)" };
    }
  } else if (role === "regulator") {
    if (regKey && providedReg !== regKey) {
      return { authorized: false, reason: "Invalid regulator credentials (x-regulator-token required)" };
    }
  }

  return { authorized: true };
}

/**
 * Redacts an individual event based on the target audience role.
 */
export function redactEventForRole(
  event: ModerationAuditEvent,
  role: AuditExportRole,
): RedactedAuditEvent {
  if (role === "moderator") {
    return {
      id: event.id,
      signal_id: event.signal_id,
      action: event.action,
      moderator: event.moderator_wallet,
      signature: event.moderator_signature,
      reason: event.reason,
      created_at: event.created_at,
      ai: event.ai
        ? {
            queue_id: event.ai.queue_id,
            decision: event.ai.decision,
            confidence: event.ai.confidence,
            model_id: event.ai.model_id,
            scores: event.ai.scores,
            agreed: event.ai.agreed,
          }
        : undefined,
    };
  }

  // Regulator role: pseudonymize wallet, strip cryptographic signature, sanitize reason
  return {
    id: event.id,
    signal_id: event.signal_id,
    action: event.action,
    moderator: fingerprintWallet(event.moderator_wallet),
    reason: sanitizeModerationReason(event.reason),
    created_at: event.created_at,
    ai: event.ai
      ? {
          queue_id: event.ai.queue_id,
          decision: event.ai.decision,
          confidence: event.ai.confidence,
          model_id: event.ai.model_id,
          agreed: event.ai.agreed,
        }
      : undefined,
  };
}

/**
 * Filters, paginates, and redacts moderation audit events.
 */
export async function getAuditExport(
  filter: AuditExportFilter,
): Promise<AuditExportResult> {
  if (!isAuditExport168Enabled()) {
    throw new ModerationAuditExportError(
      "FLAG_DISABLED",
      "Moderation audit export is disabled (phase-168 flag off)",
    );
  }

  const store = await readAuditStore();
  let events = Object.values(store);

  // Filter by date range
  if (filter.from !== undefined) {
    events = events.filter((e) => e.created_at >= filter.from!);
  }
  if (filter.to !== undefined) {
    events = events.filter((e) => e.created_at <= filter.to!);
  }

  // Filter by action
  if (filter.action) {
    events = events.filter((e) => e.action === filter.action);
  }

  // Filter by signal
  if (filter.signal_id) {
    events = events.filter((e) => e.signal_id === filter.signal_id);
  }

  // Filter by moderator wallet
  if (filter.moderator_wallet) {
    events = events.filter((e) => e.moderator_wallet === filter.moderator_wallet);
  }

  // Sort ascending by creation time
  events.sort((a, b) => a.created_at - b.created_at);

  const total = events.length;

  // Apply cursor pagination
  if (filter.cursor) {
    const cursorIdx = events.findIndex((e) => e.id === filter.cursor);
    if (cursorIdx !== -1) {
      events = events.slice(cursorIdx + 1);
    }
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  const paginated = events.slice(0, limit);
  const nextCursor = paginated.length === limit ? paginated[paginated.length - 1]?.id : undefined;

  const redacted = paginated.map((e) => redactEventForRole(e, filter.role));

  return {
    metadata: {
      format: filter.format,
      role: filter.role,
      exported_at: Date.now(),
      count: redacted.length,
      total,
      next_cursor: nextCursor,
      filters: {
        from: filter.from,
        to: filter.to,
        action: filter.action,
        signal_id: filter.signal_id,
      },
    },
    events: redacted,
  };
}

/**
 * Formats redacted events into RFC 4180 compliant CSV.
 */
export function formatEventsToCsv(events: RedactedAuditEvent[]): string {
  const header = [
    "id",
    "created_at",
    "timestamp_iso",
    "action",
    "signal_id",
    "moderator",
    "reason",
    "ai_queue_id",
    "ai_decision",
  ].join(",");

  const rows = events.map((e) => {
    const fields = [
      e.id,
      String(e.created_at),
      new Date(e.created_at).toISOString(),
      e.action,
      e.signal_id,
      e.moderator,
      e.reason ?? "",
      e.ai?.queue_id ?? "",
      e.ai?.decision ?? "",
    ];

    return fields
      .map((f) => {
        const str = String(f);
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(",");
  });

  return [header, ...rows].join("\n");
}

/**
 * Formats events into Newline Delimited JSON (NDJSON).
 */
export function formatEventsToNdjson(events: RedactedAuditEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}
