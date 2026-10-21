/**
 * Interpreta diagnósticos del host Soroban `HostError: Error(Contract, #N)` del contrato PHASE
 * (`PhaseError` en contracts/phase-protocol).
 */

/**
 * Sanitiza mensajes de error previniendo la exposición accidental de claves privadas (Stellar S...)
 * o tokens en logs de diagnóstico o mensajes de usuario.
 */
export function redactHostErrorMessage(raw: string): string {
  if (!raw || typeof raw !== "string") return ""
  return raw
    .replace(/\bS[A-Z0-9]{55}\b/g, "[REDACTED_SECRET_KEY]")
    .replace(/(DISTRIBUTOR_SECRET|SECRET_KEY|API_KEY)\s*[:=]\s*["']?[^"'\s]+["']?/gi, "$1=[REDACTED]")
}

export function parsePhaseContractErrorCode(raw: unknown): number | null {
  if (typeof raw !== "string") {
    if (raw instanceof Error) {
      raw = raw.message
    } else {
      return null
    }
  }
  const clean = redactHostErrorMessage(raw as string)
  const m = clean.match(/Error\s*\(\s*Contract\s*,\s*#(\d+)\s*\)/i)
  if (m) return parseInt(m[1], 10)
  const m2 = clean.match(/\bContract\s*,\s*#(\d+)\b/i)
  return m2 ? parseInt(m2[1], 10) : null
}

/**
 * @param lines longitud ≥ 14; índice 0 vacío; 1..13 = discriminant PhaseError
 */
export function humanizePhaseHostErrorMessage(
  raw: unknown,
  lines: readonly string[],
  unknownTpl: string,
): string | null {
  const code = parsePhaseContractErrorCode(raw)
  if (code == null) return null
  if (code >= 1 && code < lines.length) {
    const line = lines[code]
    if (line && line.length > 0) return line
  }
  return unknownTpl.replace(/\{code\}/g, String(code))
}

/**
 * Interprets Ledger hardware error codes and device status responses.
 * Detects blind signing disabled (0x6b0c / 0x6a15), user rejection (0x6985), and USB timeout (0x6e00).
 */
export function humanizeLedgerHardwareErrorMessage(raw: unknown): string | null {
  if (!raw) return null
  const msg = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : JSON.stringify(raw)
  const lower = msg.toLowerCase()
  if (lower.includes("0x6b0c") || lower.includes("0x6a15") || lower.includes("blind signing") || lower.includes("clear signing")) {
    return "Blind signing is disabled in Ledger Stellar app. Open Stellar app on your device, navigate to Settings → Blind signing, and set to Enabled."
  }
  if (lower.includes("0x6985") || lower.includes("user rejected") || lower.includes("denied by user")) {
    return "Transaction was rejected on your Ledger device."
  }
  if (lower.includes("0x6e00") || lower.includes("locked") || lower.includes("disconnected") || lower.includes("timeout")) {
    return "Ledger device is locked or disconnected. Please unlock your device, open the Stellar app, and try again."
  }
  return null
}

