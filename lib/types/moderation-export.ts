import type { ModerationAction } from "@/lib/moderation-audit";

export type AuditExportRole = "moderator" | "regulator";
export type AuditExportFormat = "json" | "ndjson" | "csv";

export interface AuditExportFilter {
  role: AuditExportRole;
  format: AuditExportFormat;
  from?: number;
  to?: number;
  action?: ModerationAction;
  signal_id?: string;
  moderator_wallet?: string;
  limit?: number;
  cursor?: string;
}

export interface RedactedAuditEvent {
  id: string;
  signal_id: string;
  action: ModerationAction;
  moderator: string;
  signature?: string;
  reason: string | null;
  created_at: number;
  ai?: {
    queue_id: string;
    decision: string | null;
    confidence: number | null;
    model_id: string | null;
    scores?: Record<string, number> | null;
    agreed?: boolean | null;
  };
}

export interface AuditExportResult {
  metadata: {
    format: AuditExportFormat;
    role: AuditExportRole;
    exported_at: number;
    count: number;
    total: number;
    next_cursor?: string;
    filters: Record<string, unknown>;
  };
  events: RedactedAuditEvent[];
}
