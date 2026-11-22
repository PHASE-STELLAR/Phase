/**
 * Security counter registry for the gated-preview / CID-verification work
 * (issues #227, #229, #230, #231).
 *
 * Counters are plain process-local values rather than a metrics library: this
 * repo has no metrics dependency and the existing observability story is
 * structured `console` logging. `snapshotSecurityCounters()` is what a health
 * endpoint or a log line reads; `resetSecurityCounters()` exists for tests.
 *
 * Label values are drawn from closed sets (result codes, operation names).
 * Nothing here is ever labelled by a token id, wallet, or CID — those are
 * unbounded, and a caller could inflate series cardinality just by varying one.
 *
 * phase-267 (issue #725): `SECURITY_COUNTER_REGISTRY` is the closed set of
 * counter names. Each counter belongs to one surface and accepts only the
 * reason codes listed for it, all drawn from `SECURITY_REASON_CODES`, so the
 * same reason ("replay", "network_mismatch") means the same thing on every
 * surface. With the flag on, `incSecurityCounter` rejects unknown names,
 * unknown reasons, PII-shaped labels and invalid increments at emit time: the
 * sample is dropped and `security_counter_label_rejected` records why.
 * Flag off: the registry checks and reason series are inert and counting works
 * exactly as before. Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_267 /
 * FEATURE_PHASE_267.
 */

import { isFeatureEnabled } from "@/lib/feature-flags"

/** Closed label sets, so a counter cannot grow into unbounded cardinality. */
export const PREVIEW_VERIFY_RESULTS = [
  "ok",
  "expired",
  "replay",
  "token_id_mismatch",
  "bad_signature",
  "network_mismatch",
  "missing_claims",
] as const

export const WASH_FLAG_REASONS = ["self_trade", "circular", "rapid_flip", "sybil_cluster", "wash_loop"] as const

/** phase-146 decision labels; every moderation counter maps from one of these. */
export const MODERATION_DECISIONS = ["auto_allow", "human_review", "auto_hold"] as const

const PREVIEW_VERIFY_REASONS = [...PREVIEW_VERIFY_RESULTS, "malformed"] as const

export const LABEL_REJECTION_REASONS = [
  "unknown_counter",
  "unknown_reason",
  "pii_label",
  "invalid_increment",
] as const

export const CUSTODIAN_RELEASE_REASONS = [
  "released",
  "forged_authorization",
  "nonce_replay",
  "already_released",
  "artifact_unverified",
  "not_custodied",
  "rpc_failure",
] as const

export const SYBIL_DECISION_REASONS = [
  "allowed_trusted",
  "allowed_caution",
  "below_threshold",
  "signal_unavailable",
  "invalid_wallet",
] as const

export const PRE_CREDIT_GATE_REASONS = [
  "admitted",
  "wallet_denied",
  "turnstile_required",
  "turnstile_failed",
  "sybil_blocked",
  "compliance_blocked",
  "provider_outage",
] as const

/** Every reason code any counter may carry. */
export const SECURITY_REASON_CODES = [
  ...PREVIEW_VERIFY_REASONS,
  ...WASH_FLAG_REASONS,
  ...MODERATION_DECISIONS,
  ...LABEL_REJECTION_REASONS,
  ...CUSTODIAN_RELEASE_REASONS,
  ...SYBIL_DECISION_REASONS,
  ...PRE_CREDIT_GATE_REASONS,
] as const

export type SecurityReasonCode = (typeof SECURITY_REASON_CODES)[number]

export const SECURITY_SURFACES = [
  "gated_preview",
  "ipfs",
  "market",
  "liquidity",
  "faucet",
  "ai",
  "growth",
  "moderation",
  "governance",
  "wallet",
  "privacy",
  "compliance",
  "deployment",
  "operations",
  "custody",
] as const

export type SecuritySurface = (typeof SECURITY_SURFACES)[number]

type CounterSpec = { surface: SecuritySurface; reasons: readonly SecurityReasonCode[] }

const NO_REASONS = [] as const

export const SECURITY_COUNTER_REGISTRY = {
  preview_verify_total: { surface: "gated_preview", reasons: PREVIEW_VERIFY_REASONS },
  preview_verify_expired: { surface: "gated_preview", reasons: NO_REASONS },
  preview_jti_replay: { surface: "gated_preview", reasons: NO_REASONS },
  preview_token_id_mismatch: { surface: "gated_preview", reasons: NO_REASONS },
  preview_bad_signature: { surface: "gated_preview", reasons: NO_REASONS },
  preview_network_mismatch: { surface: "gated_preview", reasons: NO_REASONS },
  gated_cdn_leak_blocked: { surface: "gated_preview", reasons: NO_REASONS },
  preview_grant_allowed: { surface: "gated_preview", reasons: NO_REASONS },
  preview_grant_denied: { surface: "gated_preview", reasons: PREVIEW_VERIFY_REASONS },
  cid_poison_attempts: { surface: "ipfs", reasons: NO_REASONS },
  cid_mismatch: { surface: "ipfs", reasons: NO_REASONS },
  cid_verified: { surface: "ipfs", reasons: NO_REASONS },
  cid_cdn_poison: { surface: "ipfs", reasons: NO_REASONS },
  metadata_uri_rejected: { surface: "ipfs", reasons: NO_REASONS },
  wash_trades_flagged: { surface: "market", reasons: WASH_FLAG_REASONS },
  wash_volume_excluded: { surface: "market", reasons: NO_REASONS },
  wash_graph_sybil: { surface: "market", reasons: NO_REASONS },
  market_volume_drift: { surface: "market", reasons: NO_REASONS },
  wash_loop_detected: { surface: "market", reasons: NO_REASONS },
  mercury_read_success: { surface: "operations", reasons: NO_REASONS },
  mercury_read_fallback_rpc: { surface: "operations", reasons: NO_REASONS },
  mercury_read_timeout: { surface: "operations", reasons: NO_REASONS },
  mercury_circuit_breaker_tripped: { surface: "operations", reasons: NO_REASONS },
  mercury_rpc_disagreement: { surface: "operations", reasons: NO_REASONS },
  grid_virtualization_rendered: { surface: "operations", reasons: NO_REASONS },
  grid_virtualization_window_sliced: { surface: "operations", reasons: NO_REASONS },
  distributor_refill_race: { surface: "faucet", reasons: NO_REASONS },
  distributor_op_underfunded: { surface: "faucet", reasons: NO_REASONS },
  distributor_available_balance_stale: { surface: "faucet", reasons: NO_REASONS },
  distributor_pending: { surface: "faucet", reasons: NO_REASONS },
  distributor_refill_succeeded: { surface: "faucet", reasons: NO_REASONS },
  image_variant_generated: { surface: "ai", reasons: NO_REASONS },
  image_crop_focal_computed: { surface: "ai", reasons: NO_REASONS },
  winback_dormant_detected: { surface: "growth", reasons: NO_REASONS },
  winback_experiment_dispatched: { surface: "growth", reasons: NO_REASONS },
  winback_fatigue_suppressed: { surface: "growth", reasons: NO_REASONS },
  ve_lock_created: { surface: "governance", reasons: NO_REASONS },
  ve_lock_extended: { surface: "governance", reasons: NO_REASONS },
  ve_fee_distributed: { surface: "governance", reasons: NO_REASONS },
  ve_fee_claimed: { surface: "governance", reasons: NO_REASONS },
  gauge_vote_cast: { surface: "governance", reasons: NO_REASONS },
  gauge_epoch_distributed: { surface: "governance", reasons: NO_REASONS },
  agent_inventory_limit_breaches: { surface: "market", reasons: NO_REASONS },
  agent_quotes_published: { surface: "market", reasons: NO_REASONS },
  ai_store_version_conflicts: { surface: "ai", reasons: NO_REASONS },
  bonding_curve_burn: { surface: "market", reasons: NO_REASONS },
  bonding_curve_mint: { surface: "market", reasons: NO_REASONS },
  buyback_burn_executed: { surface: "market", reasons: NO_REASONS },
  curator_citation_rejected: { surface: "ai", reasons: NO_REASONS },
  curator_draft_reused: { surface: "ai", reasons: NO_REASONS },
  curator_exhibitions_drafted: { surface: "ai", reasons: NO_REASONS },
  curator_exhibitions_published: { surface: "ai", reasons: NO_REASONS },
  curator_owner_cap_applied: { surface: "ai", reasons: NO_REASONS },
  curator_owner_unverified_excluded: { surface: "ai", reasons: NO_REASONS },
  curator_text_fallback: { surface: "ai", reasons: NO_REASONS },
  curator_wash_tokens_excluded: { surface: "ai", reasons: NO_REASONS },
  drop_claim_rejected: { surface: "market", reasons: NO_REASONS },
  dutch_quote_stale_rejected: { surface: "market", reasons: NO_REASONS },
  lore_audits_performed: { surface: "ai", reasons: NO_REASONS },
  lore_contradictions_detected: { surface: "ai", reasons: NO_REASONS },
  mcp_tool_calls_executed: { surface: "ai", reasons: NO_REASONS },
  mcp_tools_listed: { surface: "ai", reasons: NO_REASONS },
  moderation_appeals: { surface: "moderation", reasons: NO_REASONS },
  moderation_classifier_failed: { surface: "moderation", reasons: NO_REASONS },
  moderation_injection_detected: { surface: "moderation", reasons: NO_REASONS },
  moderation_override_agree: { surface: "moderation", reasons: NO_REASONS },
  moderation_override_disagree: { surface: "moderation", reasons: NO_REASONS },
  moderation_auto_allow: { surface: "moderation", reasons: NO_REASONS },
  moderation_human_review: { surface: "moderation", reasons: NO_REASONS },
  moderation_auto_hold: { surface: "moderation", reasons: NO_REASONS },
  moderation_scored: { surface: "moderation", reasons: MODERATION_DECISIONS },
  prediction_market_created: { surface: "market", reasons: NO_REASONS },
  prediction_market_resolved: { surface: "market", reasons: NO_REASONS },
  prediction_payout_claimed: { surface: "market", reasons: NO_REASONS },
  prediction_position_opened: { surface: "market", reasons: NO_REASONS },
  pricing_citation_rejected: { surface: "market", reasons: NO_REASONS },
  pricing_insufficient_comps: { surface: "market", reasons: NO_REASONS },
  pricing_outcome_recorded: { surface: "market", reasons: NO_REASONS },
  pricing_outcome_replay: { surface: "market", reasons: NO_REASONS },
  pricing_outlier_comps_dropped: { surface: "market", reasons: NO_REASONS },
  pricing_self_comps_excluded: { surface: "market", reasons: NO_REASONS },
  pricing_suggestions_total: { surface: "market", reasons: NO_REASONS },
  pricing_wash_comps_discounted: { surface: "market", reasons: NO_REASONS },
  quest_arc_claim_unfunded: { surface: "ai", reasons: NO_REASONS },
  quest_arc_steps_claimed: { surface: "ai", reasons: NO_REASONS },
  quest_arcs_generated: { surface: "ai", reasons: NO_REASONS },
  quest_arcs_rejected_farmable: { surface: "ai", reasons: NO_REASONS },
  quest_arcs_rejected_identity: { surface: "ai", reasons: NO_REASONS },
  quest_arcs_superseded: { surface: "ai", reasons: NO_REASONS },
  staked_fee_discount_applied: { surface: "market", reasons: NO_REASONS },
  support_bot_errors_diagnosed: { surface: "ai", reasons: NO_REASONS },
  support_bot_queries_total: { surface: "ai", reasons: NO_REASONS },
  qr_generated_receive: { surface: "wallet", reasons: NO_REASONS },
  qr_generated_referral: { surface: "wallet", reasons: NO_REASONS },
  qr_scanned_success: { surface: "wallet", reasons: NO_REASONS },
  qr_scanned_invalid: { surface: "wallet", reasons: NO_REASONS },
  qr_camera_denied: { surface: "wallet", reasons: NO_REASONS },
  wc_session_restored: { surface: "wallet", reasons: NO_REASONS },
  wc_session_expired: { surface: "wallet", reasons: NO_REASONS },
  wc_reconnect_success: { surface: "wallet", reasons: NO_REASONS },
  wc_reconnect_failed: { surface: "wallet", reasons: NO_REASONS },
  wc_chain_mismatch_blocked: { surface: "wallet", reasons: NO_REASONS },
  xbull_connect_success: { surface: "wallet", reasons: NO_REASONS },
  xbull_sign_requested: { surface: "wallet", reasons: NO_REASONS },
  xbull_sign_success: { surface: "wallet", reasons: NO_REASONS },
  xbull_sign_rejected: { surface: "wallet", reasons: NO_REASONS },
  xbull_trustline_signed: { surface: "wallet", reasons: NO_REASONS },
  xbull_trustline_success: { surface: "wallet", reasons: NO_REASONS },
  xbull_error_mapped: { surface: "wallet", reasons: NO_REASONS },
  ledger_clear_signing_reviewed: { surface: "wallet", reasons: NO_REASONS },
  ledger_clear_signing_approved: { surface: "wallet", reasons: NO_REASONS },
  ledger_clear_signing_rejected: { surface: "wallet", reasons: NO_REASONS },
  ledger_blind_signing_blocked: { surface: "wallet", reasons: NO_REASONS },
  ledger_gate13_preempted: { surface: "wallet", reasons: NO_REASONS },
  log_pipeline_enqueued: { surface: "operations", reasons: NO_REASONS },
  log_pipeline_sampled_out: { surface: "operations", reasons: NO_REASONS },
  log_pipeline_dropped: { surface: "operations", reasons: NO_REASONS },
  log_pipeline_redacted: { surface: "operations", reasons: NO_REASONS },
  log_pipeline_flush_ok: { surface: "operations", reasons: NO_REASONS },
  log_pipeline_flush_failed: { surface: "operations", reasons: NO_REASONS },
  backup_snapshot_created: { surface: "operations", reasons: NO_REASONS },
  backup_snapshot_verified: { surface: "operations", reasons: NO_REASONS },
  backup_snapshot_corrupt: { surface: "operations", reasons: NO_REASONS },
  backup_restore_completed: { surface: "operations", reasons: NO_REASONS },
  backup_restore_blocked: { surface: "operations", reasons: NO_REASONS },
  db_parity_checked: { surface: "operations", reasons: NO_REASONS },
  db_parity_mismatch: { surface: "operations", reasons: NO_REASONS },
  db_dual_write_ok: { surface: "operations", reasons: NO_REASONS },
  db_dual_write_drift: { surface: "operations", reasons: NO_REASONS },
  db_dual_write_shed: { surface: "operations", reasons: NO_REASONS },
  preview_isolation_violation: { surface: "deployment", reasons: NO_REASONS },
  preview_cron_blocked: { surface: "deployment", reasons: NO_REASONS },
  leaderboard_entries_ingested: { surface: "growth", reasons: NO_REASONS },
  leaderboard_scored: { surface: "growth", reasons: NO_REASONS },
  leaderboard_farm_penalized: { surface: "growth", reasons: NO_REASONS },
  leaderboard_sybil_discounted: { surface: "growth", reasons: NO_REASONS },
  leaderboard_integrity_verified: { surface: "operations", reasons: NO_REASONS },
  leaderboard_wallet_excluded: { surface: "operations", reasons: NO_REASONS },
  retention_sweep_runs: { surface: "privacy", reasons: NO_REASONS },
  retention_records_expired: { surface: "privacy", reasons: NO_REASONS },
  gdpr_erasure_completed: { surface: "privacy", reasons: NO_REASONS },
  gdpr_erasure_blocked: { surface: "privacy", reasons: NO_REASONS },
  gdpr_erasure_records: { surface: "privacy", reasons: NO_REASONS },
  warehouse_export_runs: { surface: "operations", reasons: NO_REASONS },
  warehouse_records_redacted: { surface: "operations", reasons: NO_REASONS },
  warehouse_export_failed: { surface: "operations", reasons: NO_REASONS },
  flag_ops_version_conflict: { surface: "operations", reasons: NO_REASONS },
  flag_kill_switch_activated: { surface: "operations", reasons: NO_REASONS },
  flag_kill_switch_lifted: { surface: "operations", reasons: NO_REASONS },
  flag_ops_stale_fallback: { surface: "operations", reasons: NO_REASONS },
  flag_kill_switch_drill_passed: { surface: "operations", reasons: NO_REASONS },
  lp_quotes_served: { surface: "liquidity", reasons: NO_REASONS },
  lp_quote_stale_rejected: { surface: "liquidity", reasons: NO_REASONS },
  lp_deposit_prepared: { surface: "liquidity", reasons: NO_REASONS },
  lp_withdraw_prepared: { surface: "liquidity", reasons: NO_REASONS },
  lp_triple_trustline_required: { surface: "liquidity", reasons: NO_REASONS },
  lp_pool_cap_breached: { surface: "liquidity", reasons: NO_REASONS },
  lp_pool_self_provision_flagged: { surface: "liquidity", reasons: NO_REASONS },
  lp_pool_self_swap_flagged: { surface: "liquidity", reasons: NO_REASONS },
  lp_pool_volume_excluded: { surface: "liquidity", reasons: NO_REASONS },
  lp_router_address_drift: { surface: "liquidity", reasons: NO_REASONS },
  lp_reserve_stale_on_error: { surface: "liquidity", reasons: NO_REASONS },
  lp_swap_slippage_rejected: { surface: "liquidity", reasons: NO_REASONS },
  deep_link_rejected: { surface: "wallet", reasons: NO_REASONS },
  deep_link_resolved: { surface: "wallet", reasons: NO_REASONS },
  compliance_webhook_replay: { surface: "compliance", reasons: NO_REASONS },
  compliance_unavailable: { surface: "compliance", reasons: NO_REASONS },
  compliance_denied: { surface: "compliance", reasons: NO_REASONS },
  compliance_allowed: { surface: "compliance", reasons: NO_REASONS },
  dep_cadence_audit_passed: { surface: "operations", reasons: NO_REASONS },
  dep_cadence_skew_detected: { surface: "operations", reasons: NO_REASONS },
  dep_sdk_parity_verified: { surface: "operations", reasons: NO_REASONS },
  dep_wasm_bytecode_drift: { surface: "operations", reasons: NO_REASONS },
  tax_event_recorded: { surface: "market", reasons: NO_REASONS },
  tax_exported: { surface: "market", reasons: NO_REASONS },
  anomaly_checks_run: { surface: "operations", reasons: NO_REASONS },
  anomaly_volume_breaches: { surface: "operations", reasons: NO_REASONS },
  anomaly_counter_breaches: { surface: "operations", reasons: NO_REASONS },
  anomaly_balance_breaches: { surface: "operations", reasons: NO_REASONS },
  anomaly_alerts_routed: { surface: "operations", reasons: NO_REASONS },
  phase_stream_closed: { surface: "operations", reasons: NO_REASONS },
  phase_stream_read_timeouts: { surface: "operations", reasons: NO_REASONS },
  admin_bad_json: { surface: "operations", reasons: NO_REASONS },
  admin_destructive_action_unconfirmed: { surface: "operations", reasons: NO_REASONS },
  admin_feature_flags_accessed: { surface: "operations", reasons: NO_REASONS },
  admin_unauthorized_access: { surface: "operations", reasons: NO_REASONS },
  admin_action_feature_flag_toggle: { surface: "operations", reasons: NO_REASONS },
  admin_action_feature_flag_toggle_failed: { surface: "operations", reasons: NO_REASONS },
  admin_action_feature_flag_kill_switch: { surface: "operations", reasons: NO_REASONS },
  admin_action_feature_flag_kill_switch_failed: { surface: "operations", reasons: NO_REASONS },
  admin_action_quest_create: { surface: "operations", reasons: NO_REASONS },
  admin_action_quest_create_failed: { surface: "operations", reasons: NO_REASONS },
  admin_action_quest_delete: { surface: "operations", reasons: NO_REASONS },
  admin_action_quest_delete_failed: { surface: "operations", reasons: NO_REASONS },
  admin_action_webhook_test: { surface: "operations", reasons: NO_REASONS },
  admin_action_webhook_test_failed: { surface: "operations", reasons: NO_REASONS },
  admin_action_wallet_allowlist: { surface: "operations", reasons: NO_REASONS },
  admin_action_wallet_allowlist_failed: { surface: "operations", reasons: NO_REASONS },
  admin_action_wallet_denylist: { surface: "operations", reasons: NO_REASONS },
  admin_action_wallet_denylist_failed: { surface: "operations", reasons: NO_REASONS },
  ai_step_success: { surface: "ai", reasons: NO_REASONS },
  ai_step_validation_failure: { surface: "ai", reasons: NO_REASONS },
  ai_step_safety_block: { surface: "ai", reasons: NO_REASONS },
  ai_step_timeout: { surface: "ai", reasons: NO_REASONS },
  ai_step_error: { surface: "ai", reasons: NO_REASONS },
  ai_step_fallback: { surface: "ai", reasons: NO_REASONS },
  bulk_listing_accepted: { surface: "market", reasons: NO_REASONS },
  bulk_listing_invalid_count: { surface: "market", reasons: NO_REASONS },
  bulk_listing_parse_error: { surface: "market", reasons: NO_REASONS },
  bulk_listing_too_large: { surface: "market", reasons: NO_REASONS },
  bulk_listing_validation_failed: { surface: "market", reasons: NO_REASONS },
  nft_verification_success: { surface: "market", reasons: NO_REASONS },
  nft_verification_not_found: { surface: "market", reasons: NO_REASONS },
  nft_verification_rpc_error: { surface: "market", reasons: NO_REASONS },
  custodian_release_total: { surface: "custody", reasons: CUSTODIAN_RELEASE_REASONS },
  custodian_release_success: { surface: "custody", reasons: NO_REASONS },
  custodian_release_forged: { surface: "custody", reasons: NO_REASONS },
  custodian_release_replay: { surface: "custody", reasons: NO_REASONS },
  custodian_release_already_released: { surface: "custody", reasons: NO_REASONS },
  collab_split_dust_rounded: { surface: "market", reasons: NO_REASONS },
  collab_split_recorded: { surface: "market", reasons: NO_REASONS },
  drop_queue_ticket_issued: { surface: "market", reasons: NO_REASONS },
  market_accept_conflict: { surface: "market", reasons: NO_REASONS },
  edge_store_degraded: { surface: "operations", reasons: NO_REASONS },
  sybil_decision_recorded: { surface: "governance", reasons: SYBIL_DECISION_REASONS },
  pre_credit_gate_decision: { surface: "faucet", reasons: PRE_CREDIT_GATE_REASONS },
  security_counter_label_rejected: { surface: "operations", reasons: LABEL_REJECTION_REASONS },
  x402_dead_letter_enqueued: { surface: "operations", reasons: NO_REASONS },
  x402_replay_attempted: { surface: "operations", reasons: NO_REASONS },
  x402_replay_rejected: { surface: "operations", reasons: NO_REASONS },
  nft_index_invalidated: { surface: "operations", reasons: NO_REASONS },
  nft_index_event_malformed: { surface: "operations", reasons: NO_REASONS },
} as const satisfies Record<string, CounterSpec>

export type SecurityCounterName = keyof typeof SECURITY_COUNTER_REGISTRY

const counters = new Map<SecurityCounterName, number>()
const reasonCounters = new Map<string, number>()

export function isSecurityCounterTaxonomyEnabled(): boolean {
  return isFeatureEnabled("phase-267")
}

export function isRegisteredSecurityCounter(name: unknown): name is SecurityCounterName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SECURITY_COUNTER_REGISTRY, name)
}

const LABEL_SHAPE = /^[a-z][a-z0-9_]{0,63}$/
/** Shapes of unbounded identifiers that must never become a label value. */
const PII_SHAPES: readonly RegExp[] = [
  /^[gcm][a-z2-7]{55}$/i, // Stellar account, contract or muxed key
  /^s[a-z2-7]{55}$/i, // Stellar secret seed
  /^0x[0-9a-f]{40}$/i, // EVM address
  /^qm[1-9a-z]{44}$/i, // CIDv0
  /^b[a-z2-7]{50,}$/i, // CIDv1 base32
  /^[0-9a-f]{32,}$/i, // hashes, tx ids
  /\d{6,}/, // token ids, amounts, timestamps
  /@/, // email
]

/** True when `label` could carry a wallet, CID, hash, prompt or other unbounded value. */
export function isPiiShapedLabel(label: string): boolean {
  return !LABEL_SHAPE.test(label) || PII_SHAPES.some((shape) => shape.test(label))
}

export type SecurityLabelCheck =
  | { ok: true }
  | { ok: false; reason: (typeof LABEL_REJECTION_REASONS)[number] }

/** Checks a counter emission against the registry without recording it. */
export function checkSecurityCounterLabel(name: unknown, by: unknown = 1, reason?: unknown): SecurityLabelCheck {
  if (typeof name === "string" && isPiiShapedLabel(name)) return { ok: false, reason: "pii_label" }
  if (!isRegisteredSecurityCounter(name)) return { ok: false, reason: "unknown_counter" }
  if (typeof by !== "number" || !Number.isSafeInteger(by) || by < 0) return { ok: false, reason: "invalid_increment" }
  if (reason !== undefined) {
    if (typeof reason !== "string" || isPiiShapedLabel(reason)) return { ok: false, reason: "pii_label" }
    const allowed: readonly string[] = SECURITY_COUNTER_REGISTRY[name].reasons
    if (!allowed.includes(reason)) return { ok: false, reason: "unknown_reason" }
  }
  return { ok: true }
}

function bump(name: SecurityCounterName, by: number, reason?: SecurityReasonCode): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
  if (reason !== undefined) {
    const key = `${name}|${reason}`
    reasonCounters.set(key, (reasonCounters.get(key) ?? 0) + by)
  }
}

/**
 * Records a security event. Returns false when phase-267 rejected the label;
 * the caller's request path is never interrupted by a bad label.
 */
export function incSecurityCounter(name: SecurityCounterName, by = 1, reason?: SecurityReasonCode): boolean {
  if (!isSecurityCounterTaxonomyEnabled()) {
    counters.set(name, (counters.get(name) ?? 0) + by)
    return true
  }
  const check = checkSecurityCounterLabel(name, by, reason)
  if (!check.ok) {
    bump("security_counter_label_rejected", 1, check.reason)
    return false
  }
  bump(name, by, reason)
  return true
}

export const recordSecurityCounter = incSecurityCounter

export function getSecurityCounter(name: SecurityCounterName): number {
  return counters.get(name) ?? 0
}

export function getSecurityCounterReason(name: SecurityCounterName, reason: SecurityReasonCode): number {
  return reasonCounters.get(`${name}|${reason}`) ?? 0
}

export function snapshotSecurityCounters(): Record<SecurityCounterName, number> {
  const out = {} as Record<SecurityCounterName, number>
  for (const [name, value] of counters) out[name] = value
  return out
}

export type SecuritySurfaceSnapshot = {
  surface: SecuritySurface
  total: number
  counters: Partial<Record<SecurityCounterName, number>>
  reasons: Partial<Record<SecurityReasonCode, number>>
}

/**
 * Counters grouped by surface, with reason totals in the shared vocabulary, so
 * a dashboard can compare e.g. "replay" or "network_mismatch" across surfaces.
 * Every surface is present (zeroed when idle), keeping the shape stable.
 */
export function snapshotSecurityCountersBySurface(): Record<SecuritySurface, SecuritySurfaceSnapshot> {
  const out = {} as Record<SecuritySurface, SecuritySurfaceSnapshot>
  for (const surface of SECURITY_SURFACES) out[surface] = { surface, total: 0, counters: {}, reasons: {} }
  for (const [name, value] of counters) {
    const entry = out[SECURITY_COUNTER_REGISTRY[name].surface]
    entry.total += value
    entry.counters[name] = value
  }
  for (const [key, value] of reasonCounters) {
    const [name, reason] = key.split("|") as [SecurityCounterName, SecurityReasonCode]
    const entry = out[SECURITY_COUNTER_REGISTRY[name].surface]
    entry.reasons[reason] = (entry.reasons[reason] ?? 0) + value
  }
  return out
}

export function resetSecurityCounters(): void {
  counters.clear()
  reasonCounters.clear()
}

/**
 * Map a `verifyViewerSignature` failure code onto the counter that tracks it,
 * so the verify route does not carry a switch statement.
 */
export function recordPreviewVerifyFailure(code: string): void {
  const reason = (PREVIEW_VERIFY_REASONS as readonly string[]).includes(code)
    ? (code as (typeof PREVIEW_VERIFY_REASONS)[number])
    : "malformed"
  incSecurityCounter("preview_verify_total", 1, reason)
  switch (code) {
    case "expired":
      incSecurityCounter("preview_verify_expired")
      break
    case "replay":
      incSecurityCounter("preview_jti_replay")
      break
    case "bad_signature":
      incSecurityCounter("preview_bad_signature")
      break
    case "network_mismatch":
      incSecurityCounter("preview_network_mismatch")
      break
    case "missing_claims":
    case "malformed":
      incSecurityCounter("preview_token_id_mismatch")
      break
  }
}
