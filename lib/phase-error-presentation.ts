/**
 * phase-214 — presentation bridge between the typed error taxonomy and the
 * existing user-facing copy tables.
 *
 * Callers previously used `humanizePhaseHostErrorMessage` directly (string
 * parsing only). With phase-214 enabled they get a typed transport descriptor
 * with a localized message from `lib/phase-copy.ts`; contract codes keep using
 * the code-stable `lines` array. With the flag off behaviour is byte-for-byte
 * identical to the legacy helper — zero regression on rollback.
 */

import { pickTransportErrorCopy } from "@/lib/phase-copy"
import { humanizePhaseHostErrorMessage } from "@/lib/phase-host-error"
import { mapPhaseContractError } from "@/lib/phase-error-taxonomy"
import {
  classifyTransportError,
  isPhase214Enabled,
  phase214RollbackNote,
} from "@/lib/phase-transport-error"

export { phase214RollbackNote }

export function humanizePhaseError(
  raw: unknown,
  lines: readonly string[],
  unknownTpl: string,
  lang: unknown = "en",
): string | null {
  // Flag off: legacy string helpers, exactly as before.
  if (!isPhase214Enabled()) return humanizePhaseHostErrorMessage(raw, lines, unknownTpl)

  const transport = classifyTransportError(raw)
  if (transport) {
    const descriptor = transport.descriptor
    return (
      pickTransportErrorCopy(lang, descriptor.userMessageKey) ??
      pickTransportErrorCopy("en", descriptor.userMessageKey) ??
      null
    )
  }

  // Contract errors remain code-stable; the copy arrays are indexed by code.
  const contract = mapPhaseContractError(raw)
  if (contract && lines[contract.code]) return lines[contract.code]

  return humanizePhaseHostErrorMessage(raw, lines, unknownTpl)
}
