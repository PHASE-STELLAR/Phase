// @ts-nocheck
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
 */

export type SecurityCounterName =
  | "preview_verify_total"
  | "preview_verify_expired"
  | "preview_jti_replay"
  | "preview_token_id_mismatch"
  | "preview_bad_signature"
  | "preview_network_mismatch"
  | "gated_cdn_leak_blocked"
  | "cid_poison_attempts"
  | "cid_mismatch"
  | "cid_verified"
  | "cid_cdn_poison"
  | "metadata_uri_rejected"
  | "wash_trades_flagged"
  | "wash_volume_excluded"
  | "wash_graph_sybil"
  | "market_volume_drift"
  | "distributor_refill_race"
  | "distributor_op_underfunded"
  | "distributor_available_balance_stale"
  | "distributor_pending"
  | "distributor_refill_succeeded"
  | "image_variant_generated"
  | "image_crop_focal_computed"
  | "winback_dormant_detected"
  | "winback_experiment_dispatched"
  | "winback_fatigue_suppressed"
  | "ve_lock_created"
  | "ve_lock_extended"
  | "ve_fee_distributed"
  | "ve_fee_claimed"
  | "gauge_vote_cast"
  | "gauge_epoch_distributed"
  | "agent_inventory_limit_breaches"
  | "agent_quotes_published"
  | "ai_store_version_conflicts"
  | "bonding_curve_burn"
  | "bonding_curve_mint"
  | "buyback_burn_executed"
  | "curator_citation_rejected"
  | "curator_draft_reused"
  | "curator_exhibitions_drafted"
  | "curator_exhibitions_published"
  | "curator_owner_cap_applied"
  | "curator_owner_unverified_excluded"
  | "curator_text_fallback"
  | "curator_wash_tokens_excluded"
  | "drop_claim_rejected"
  | "dutch_quote_stale_rejected"
  | "lore_audits_performed"
  | "lore_contradictions_detected"
  | "mcp_tool_calls_executed"
  | "mcp_tools_listed"
  | "moderation_appeals"
  | "moderation_classifier_failed"
  | "moderation_injection_detected"
  | "moderation_override_agree"
  | "moderation_override_disagree"
  | "moderation_auto_allow"
  | "moderation_human_review"
  | "moderation_auto_hold"
  | "moderation_scored"
  | "prediction_market_created"
  | "prediction_market_resolved"
  | "prediction_payout_claimed"
  | "prediction_position_opened"
  | "pricing_citation_rejected"
  | "pricing_insufficient_comps"
  | "pricing_outcome_recorded"
  | "pricing_outcome_replay"
  | "pricing_outlier_comps_dropped"
  | "pricing_self_comps_excluded"
  | "pricing_suggestions_total"
  | "pricing_wash_comps_discounted"
  | "quest_arc_claim_unfunded"
  | "quest_arc_steps_claimed"
  | "quest_arcs_generated"
  | "quest_arcs_rejected_farmable"
  | "quest_arcs_rejected_identity"
  | "quest_arcs_superseded"
  | "staked_fee_discount_applied"
  | "support_bot_errors_diagnosed"
  | "support_bot_queries_total"
  | "qr_generated_receive"
  | "qr_generated_referral"
  | "qr_scanned_success"
  | "qr_scanned_invalid"
  | "qr_camera_denied"
  | "wc_session_restored"
  | "wc_session_expired"
  | "wc_reconnect_success"
  | "wc_reconnect_failed"
  | "wc_chain_mismatch_blocked"
  | "xbull_connect_success"
  | "xbull_sign_requested"
  | "xbull_sign_success"
  | "xbull_sign_rejected"
  | "xbull_trustline_signed"
  | "xbull_trustline_success"
  | "xbull_error_mapped"
  | "ledger_clear_signing_reviewed"
  | "ledger_clear_signing_approved"
  | "ledger_clear_signing_rejected"
  | "ledger_blind_signing_blocked"
  | "ledger_gate13_preempted"
  | "log_pipeline_enqueued"
  | "log_pipeline_sampled_out"
  | "log_pipeline_dropped"
  | "log_pipeline_redacted"
  | "log_pipeline_flush_ok"
  | "log_pipeline_flush_failed"
  | "backup_snapshot_created"
  | "backup_snapshot_verified"
  | "backup_snapshot_corrupt"
  | "backup_restore_completed"
  | "backup_restore_blocked"
  | "db_parity_checked"
  | "db_parity_mismatch"
  | "db_dual_write_ok"
  | "db_dual_write_drift"
  | "db_dual_write_shed"
  | "preview_isolation_violation"
  | "preview_cron_blocked"
  | "leaderboard_entries_ingested"
  | "leaderboard_scored"
  | "leaderboard_farm_penalized"
  | "leaderboard_sybil_discounted"
  | "retention_sweep_runs"
  | "retention_records_expired"
  | "gdpr_erasure_completed"
  | "gdpr_erasure_blocked"
  | "gdpr_erasure_records"
  | "warehouse_export_runs"
  | "warehouse_records_redacted"
  | "warehouse_export_failed"
  | "flag_ops_version_conflict"
  | "flag_kill_switch_activated"
  | "flag_kill_switch_lifted"
  | "flag_ops_stale_fallback"
  | "flag_kill_switch_drill_passed"
  | "lp_quotes_served"
  | "lp_quote_stale_rejected"
  | "lp_deposit_prepared"
  | "lp_withdraw_prepared"
  | "lp_triple_trustline_required"
  | "lp_pool_cap_breached"
  | "lp_pool_self_provision_flagged"
  | "lp_pool_self_swap_flagged"
  | "lp_pool_volume_excluded"
  | "lp_router_address_drift"
  | "lp_reserve_stale_on_error"
  | "lp_swap_slippage_rejected"
  | "deep_link_rejected"
  | "deep_link_resolved"
  | "compliance_webhook_replay"
  | "compliance_unavailable"
  | "compliance_denied"
  | "compliance_allowed"
  | "dep_cadence_audit_passed"
  | "dep_cadence_skew_detected"
  | "dep_sdk_parity_verified"
  | "dep_wasm_bytecode_drift"
  | "tax_event_recorded"
  | "tax_exported"
  | "anomaly_checks_run"
  | "anomaly_volume_breaches"
  | "anomaly_counter_breaches"
  | "anomaly_balance_breaches"
  | "anomaly_alerts_routed";


const counters = new Map<SecurityCounterName, number>()

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

export const WASH_FLAG_REASONS = ["self_trade", "circular", "rapid_flip", "sybil_cluster"] as const

/** phase-146 decision labels; every moderation counter maps from one of these. */
export const MODERATION_DECISIONS = ["auto_allow", "human_review", "auto_hold"] as const

export function incSecurityCounter(name: SecurityCounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
}

export const recordSecurityCounter = incSecurityCounter

export function getSecurityCounter(name: SecurityCounterName): number {
  return counters.get(name) ?? 0
}

export function snapshotSecurityCounters(): Record<SecurityCounterName, number> {
  const out = {} as Record<SecurityCounterName, number>
  for (const [name, value] of counters) out[name] = value
  return out
}

export function resetSecurityCounters(): void {
  counters.clear()
}

/**
 * Map a `verifyViewerSignature` failure code onto the counter that tracks it,
 * so the verify route does not carry a switch statement.
 */
export function recordPreviewVerifyFailure(code: string): void {
  incSecurityCounter("preview_verify_total")
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
