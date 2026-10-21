export type LegalHoldTargetType =
  | "wallet"
  | "signal"
  | "collection"
  | "listing"
  | "profile";

export interface LegalHold {
  id: string;
  target_type: LegalHoldTargetType;
  target_id: string;
  matter_id: string;
  reason: string;
  custodian: string;
  created_at: number;
  active: boolean;
  retention_until?: number;
  immutable_worm?: boolean;
  released_at?: number;
  released_by?: string;
  release_reason?: string;
}

export interface CreateLegalHoldInput {
  target_type: LegalHoldTargetType;
  target_id: string;
  matter_id: string;
  reason: string;
  custodian: string;
  retention_days?: number;
  immutable_worm?: boolean;
}

export interface ReleaseLegalHoldInput {
  id: string;
  released_by: string;
  release_reason: string;
}

export interface LegalHoldCheckResult {
  held: boolean;
  hold?: LegalHold;
  reason?: string;
}
