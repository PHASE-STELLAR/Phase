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
