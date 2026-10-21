import { incSecurityCounter } from "@/lib/security-counters";

export type SupportErrorDiagnosis = {
  code: string;
  category: "PROTOCOL_GATE" | "AUTH_ERROR" | "NETWORK_TIMEOUT" | "CONCURRENCY_CONFLICT" | "PAYMENT_REQUIRED" | "GENERAL_ERROR";
  retryable: boolean;
  explanation: string;
  runbookSteps: string[];
};

export type SupportBotResult = {
  answer: string;
  citations: string[];
  diagnosis?: SupportErrorDiagnosis;
  redactedQuery: string;
  escalateToHuman: boolean;
};

/** Redacts Stellar private seed keys (S...) and 64-char hex strings from query/logs */
export function redactSensitiveData(input: string): string {
  return input
    .replace(/\bS[A-Z0-9]{55}\b/g, "[REDACTED_STELLAR_SEED]")
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[REDACTED_PRIVATE_KEY]");
}

/** Error taxonomy pattern recognizer */
export function diagnoseErrorTrace(logText: string): SupportErrorDiagnosis | null {
  const text = logText.toLowerCase();

  if (text.includes("biometric_trust_gate_closed") || text.includes("gate #13") || text.includes("gate_closed")) {
    incSecurityCounter("support_bot_errors_diagnosed");
    return {
      code: "BIOMETRIC_TRUST_GATE_CLOSED",
      category: "PROTOCOL_GATE",
      retryable: false,
      explanation: "On-chain biometric trust gate #13 rejected the transaction. The target wallet has not satisfied proof requirements.",
      runbookSteps: [
        "Verify biometric attestation status in chamber profile.",
        "Check trustline activation on Stellar testnet for PHASERLIQ.",
        "Request distributor re-verification via support channel.",
      ],
    };
  }

  if (text.includes("version_conflict") || text.includes("409") || text.includes("if-match")) {
    incSecurityCounter("support_bot_errors_diagnosed");
    return {
      code: "STALE_VERSION_CONFLICT",
      category: "CONCURRENCY_CONFLICT",
      retryable: true,
      explanation: "A concurrent writer updated the record before this request committed. The CAS check aborted to prevent clobbering.",
      runbookSteps: [
        "Fetch the latest record version with updated ETag/version.",
        "Re-apply local changes on top of the newer state.",
        "Retry the submission with the refreshed If-Match header.",
      ],
    };
  }

  if (text.includes("402") || text.includes("payment_required") || text.includes("settle")) {
    incSecurityCounter("support_bot_errors_diagnosed");
    return {
      code: "X402_PAYMENT_REQUIRED",
      category: "PAYMENT_REQUIRED",
      retryable: true,
      explanation: "Endpoint requires micro-payment settlement via PHASERLIQ or valid x402 payment proof.",
      runbookSteps: [
        "Inspect the 402 challenge header for required fee stroops.",
        "Submit payment transaction to Soroban token contract.",
        "Include settlement receipt in X-Payment-Receipt header and retry.",
      ],
    };
  }

  if (text.includes("ipfs") && (text.includes("timeout") || text.includes("504") || text.includes("gateway"))) {
    incSecurityCounter("support_bot_errors_diagnosed");
    return {
      code: "IPFS_GATEWAY_TIMEOUT",
      category: "NETWORK_TIMEOUT",
      retryable: true,
      explanation: "The primary IPFS gateway failed to respond within the 8-second SLA window.",
      runbookSteps: [
        "Allow automatic fallback to secondary pinning gateway.",
        "Verify CID multihash integrity with lib/cid-verification.",
        "Retry request with exponential backoff.",
      ],
    };
  }

  return null;
}

/** Processes a user query against docs retrieval and structured error diagnosis */
export function processSupportQuery(rawQuery: string): SupportBotResult {
  incSecurityCounter("support_bot_queries_total");
  const cleaned = redactSensitiveData(rawQuery);
  const diagnosis = diagnoseErrorTrace(cleaned);

  const citations: string[] = [];
  let answer = "";
  let escalateToHuman = false;

  if (diagnosis) {
    citations.push("lib/phase-host-error.ts", "docs/TECHNICAL.md §5.3");
    answer = `Diagnosed Error: ${diagnosis.code} (${diagnosis.category}). ${diagnosis.explanation} Recommended steps:\n` +
      diagnosis.runbookSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  } else {
    const qLower = cleaned.toLowerCase();
    if (qLower.includes("trustline") || qLower.includes("horizon")) {
      citations.push("lib/classic-liq.ts", "docs/SETUP_ENV.md");
      answer = "PHASERLIQ classic trustlines are submitted through Horizon using changeTrust operations with batch rate-limiting enabled (phase-134). Ensure your testnet account has at least 1.5 XLM reserve.";
    } else if (qLower.includes("forge") || qLower.includes("agent")) {
      citations.push("docs/AGENT_PAYMENTS.md", "PROJECT_ARCHITECTURE.md §3");
      answer = "The Forge autonomous agent pipeline operates using server-held agent keys and client-signed x402 micro-settlements. Long-running generations are capped at 180s on serverless.";
    } else if (qLower.includes("signal") || qLower.includes("lore") || qLower.includes("crdt")) {
      citations.push("PROJECT_ARCHITECTURE.md §3.2", "docs/TECHNICAL.md §5.3");
      answer = "Signals and replies are persisted in SQLite (WAL mode) with CAS version guards. Collaborative lore drafting uses Yjs CRDT synchronization with HTTP state vectors.";
    } else {
      answer = "Your inquiry has been logged. No automated diagnostic runbook matched your query, so this ticket has been flagged for human moderator review.";
      escalateToHuman = true;
      citations.push("docs/HOW_IT_WORKS.md");
    }
  }

  return {
    answer,
    citations,
    diagnosis: diagnosis ?? undefined,
    redactedQuery: cleaned,
    escalateToHuman,
  };
}
