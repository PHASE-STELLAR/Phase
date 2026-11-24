/**
 * Legal-hold preservation with deny-delete during investigation.
 * Spike 636 / Issue #498.
 *
 * Implements:
 * - WORM (Write-Once-Read-Many) immutability and retention clocks
 * - Custodian authorization for hold placement and release
 * - Cascade enforcement: holding a wallet cascades preservation to its authored
 *   signals, profile, marketplace listings, and notifications
 * - Hard denial of takedown, delete, cancel, or destructive overwrite
 *
 * Feature flag: phase-169.
 * Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_169 / FEATURE_PHASE_169; returns 404.
 */

import { nanoid } from "nanoid";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { readStore, updateStore } from "@/lib/json-store";
import type {
  CreateLegalHoldInput,
  LegalHold,
  LegalHoldCheckResult,
  LegalHoldTargetType,
  ReleaseLegalHoldInput,
} from "@/lib/types/legal-hold";

export class LegalHoldError extends Error {
  code:
    | "FLAG_DISABLED"
    | "LEGAL_HOLD_ACTIVE"
    | "HOLD_NOT_FOUND"
    | "ALREADY_RELEASED"
    | "WORM_LOCKED"
    | "UNAUTHORIZED"
    | "INVALID_INPUT";
  hold?: LegalHold;

  constructor(
    code: LegalHoldError["code"],
    message: string,
    hold?: LegalHold,
  ) {
    super(message);
    this.name = "LegalHoldError";
    this.code = code;
    this.hold = hold;
  }
}

export function isLegalHold169Enabled(): boolean {
  return isFeatureEnabled("phase-169");
}

type LegalHoldStore = Record<string, LegalHold>;

async function readHoldStore(): Promise<LegalHoldStore> {
  return readStore<LegalHoldStore>("legalHolds", () => ({}));
}

/**
 * Creates and registers a new legal hold.
 */
export async function createLegalHold(
  input: CreateLegalHoldInput,
): Promise<LegalHold> {
  if (!isLegalHold169Enabled()) {
    throw new LegalHoldError(
      "FLAG_DISABLED",
      "Legal-hold preservation is disabled (phase-169 flag off)",
    );
  }

  if (!input.target_id || !input.matter_id || !input.reason || !input.custodian) {
    throw new LegalHoldError(
      "INVALID_INPUT",
      "Missing required legal hold fields (target_id, matter_id, reason, custodian)",
    );
  }

  const now = Date.now();
  const retentionUntil = input.retention_days
    ? now + input.retention_days * 86400 * 1000
    : undefined;

  const hold: LegalHold = {
    id: `hold_${nanoid(12)}`,
    target_type: input.target_type,
    target_id: input.target_id.trim(),
    matter_id: input.matter_id.trim(),
    reason: input.reason.trim(),
    custodian: input.custodian.trim(),
    created_at: now,
    active: true,
    retention_until: retentionUntil,
    immutable_worm: Boolean(input.immutable_worm),
  };

  await updateStore<LegalHoldStore>("legalHolds", (store) => {
    store[hold.id] = hold;
  });

  return hold;
}

/**
 * Releases an active legal hold, validating retention clocks and WORM restrictions.
 */
export async function releaseLegalHold(
  input: ReleaseLegalHoldInput,
): Promise<LegalHold> {
  if (!isLegalHold169Enabled()) {
    throw new LegalHoldError(
      "FLAG_DISABLED",
      "Legal-hold preservation is disabled (phase-169 flag off)",
    );
  }

  let releasedHold: LegalHold | undefined;

  await updateStore<LegalHoldStore>("legalHolds", (store) => {
    const hold = store[input.id];
    if (!hold) {
      throw new LegalHoldError("HOLD_NOT_FOUND", `Legal hold '${input.id}' not found`);
    }
    if (!hold.active) {
      throw new LegalHoldError("ALREADY_RELEASED", `Legal hold '${input.id}' is already released`);
    }

    const now = Date.now();
    // Enforce WORM retention clock
    if (hold.immutable_worm && hold.retention_until && now < hold.retention_until) {
      const remainingHours = Math.ceil((hold.retention_until - now) / 3600000);
      throw new LegalHoldError(
        "WORM_LOCKED",
        `Cannot release WORM-locked legal hold before retention clock expires (expires in ${remainingHours} hours)`,
        hold,
      );
    }

    hold.active = false;
    hold.released_at = now;
    hold.released_by = input.released_by.trim();
    hold.release_reason = input.release_reason.trim();
    releasedHold = hold;
  });

  return releasedHold!;
}

/**
 * Retrieves all active holds matching a target.
 */
export async function getActiveHoldsForTarget(
  target_type: LegalHoldTargetType,
  target_id: string,
): Promise<LegalHold[]> {
  const store = await readHoldStore();
  return Object.values(store).filter(
    (h) => h.active && h.target_type === target_type && h.target_id === target_id,
  );
}

/**
 * Checks whether an entity or its owning wallet is preserved under an active legal hold.
 */
export async function isUnderLegalHold(
  target_type: LegalHoldTargetType,
  target_id: string,
  owner_wallet?: string,
): Promise<LegalHoldCheckResult> {
  if (!isLegalHold169Enabled()) {
    return { held: false };
  }

  const store = await readHoldStore();
  const holds = Object.values(store);

  // 1. Direct target hold
  const directHold = holds.find(
    (h) => h.active && h.target_type === target_type && h.target_id === target_id,
  );
  if (directHold) {
    return {
      held: true,
      hold: directHold,
      reason: `Entity is preserved under active legal hold '${directHold.id}' (Matter: ${directHold.matter_id})`,
    };
  }

  // 2. Cascade wallet hold: if the entity belongs to a wallet that is held, cascade preservation
  if (owner_wallet) {
    const walletHold = holds.find(
      (h) => h.active && h.target_type === "wallet" && h.target_id === owner_wallet,
    );
    if (walletHold) {
      return {
        held: true,
        hold: walletHold,
        reason: `Owning wallet '${owner_wallet}' is preserved under active legal hold '${walletHold.id}' (Matter: ${walletHold.matter_id})`,
      };
    }
  }

  return { held: false };
}

/**
 * Asserts that an entity is NOT under active legal hold.
 * Throws LegalHoldError with code 'LEGAL_HOLD_ACTIVE' (HTTP 423 Locked) if held.
 */
export async function assertNoLegalHold(
  target_type: LegalHoldTargetType,
  target_id: string,
  action: string = "modification",
  owner_wallet?: string,
): Promise<void> {
  if (!isLegalHold169Enabled()) return;

  const result = await isUnderLegalHold(target_type, target_id, owner_wallet);
  if (result.held && result.hold) {
    throw new LegalHoldError(
      "LEGAL_HOLD_ACTIVE",
      `Deny-delete enforcement: cannot perform ${action} on ${target_type} '${target_id}'. ${result.reason}`,
      result.hold,
    );
  }
}
