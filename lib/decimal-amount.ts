import { isFeatureEnabled } from "@/lib/feature-flags"

/** Stellar amounts use seven decimal places; never round through floating point. */
export function decimalToStroops(value: string): string {
  if (!/^\d{1,30}(\.\d{1,7})?$/.test(value)) throw new Error("INVALID_AMOUNT")
  const [whole, fraction = ""] = value.split(".")
  return (BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"))).toString()
}
export function formatStroops(value: string): string {
  const n = BigInt(value)
  const absolute = n < 0n ? -n : n
  return `${n < 0n ? "-" : ""}${absolute / 10_000_000n}.${(absolute % 10_000_000n).toString().padStart(7, "0")}`
}

// ─── phase-265: one decimal-amount parser (issue #723) ─────────────────────
//
// Forge, market and x402 each parsed amounts their own way (`parseFloat`,
// `Number(...)`, `Math.round(n * 1e7)`), so the same input could round
// differently per surface and large values lost precision in a double.
// Everything below works on bigint minor units.
//
// Feature flag: phase-265 (NEXT_PUBLIC_FEATURE_PHASE_265 / FEATURE_PHASE_265)
// Rollback: unset the flag; call sites go back to their legacy parsing. No
// stored data changes shape, so there is nothing to migrate back.

export const STELLAR_DECIMALS = 7
/** Largest amount a classic Stellar operation can carry: int64 stroops. */
export const MAX_STELLAR_STROOPS = 9_223_372_036_854_775_807n

export type DecimalRoundingMode = "reject" | "floor" | "ceil" | "half-up" | "half-even"

export type DecimalAmountErrorCode =
  | "NOT_A_NUMBER"
  | "MALFORMED"
  | "SCIENTIFIC_NOTATION"
  | "TOO_MANY_DECIMALS"
  | "NEGATIVE"
  | "ZERO"
  | "OVERFLOW"

export class DecimalAmountError extends Error {
  readonly code: DecimalAmountErrorCode
  constructor(code: DecimalAmountErrorCode, message: string) {
    super(message)
    this.name = "DecimalAmountError"
    this.code = code
  }
}

export type ParseDecimalAmountOptions = {
  /** Decimal places of the minor unit (7 = stroops, 0 = integer). Default 7. */
  decimals?: number
  /** What to do with digits beyond `decimals`. Default "reject". */
  rounding?: DecimalRoundingMode
  /** Accept `,` as the decimal separator (es-locale UI input). Default false. */
  acceptComma?: boolean
  allowNegative?: boolean
  allowZero?: boolean
  /** Inclusive upper bound on the magnitude in minor units. Default int64 max. */
  max?: bigint
}

const PLAIN_DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/
const LEADING_DOT_DECIMAL = /^([+-]?)()\.(\d+)$/
const SCIENTIFIC = /^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i
const NUMBER_EXPONENT = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/

/**
 * A JS number's shortest round-trip form is what was written in the JSON body,
 * so expanding that string (rather than multiplying the double) keeps `0.1` as
 * exactly one tenth. Small numbers stringify with an exponent ("1e-7"); expand
 * those exactly instead of rejecting them as scientific notation.
 */
function numberToPlainDecimal(value: number): string {
  if (!Number.isFinite(value)) throw new DecimalAmountError("NOT_A_NUMBER", "Amount must be a finite number")
  const text = String(value)
  const exp = NUMBER_EXPONENT.exec(text)
  if (!exp) return text
  const [, sign, lead, rest = "", expText] = exp
  const digits = lead + rest
  const pointAt = 1 + Number(expText)
  if (pointAt <= 0) return `${sign}0.${"0".repeat(-pointAt)}${digits}`
  if (pointAt >= digits.length) return `${sign}${digits}${"0".repeat(pointAt - digits.length)}`
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`
}

function roundQuotient(
  quotient: bigint,
  dropped: string,
  negative: boolean,
  mode: Exclude<DecimalRoundingMode, "reject">,
): bigint {
  if (/^0*$/.test(dropped)) return quotient
  const first = dropped.charCodeAt(0) - 48
  const tail = !/^0*$/.test(dropped.slice(1))
  let up: boolean
  switch (mode) {
    case "floor":
      up = negative
      break
    case "ceil":
      up = !negative
      break
    case "half-up":
      up = first >= 5
      break
    case "half-even":
      up = first > 5 || (first === 5 && (tail || quotient % 2n === 1n))
      break
  }
  return up ? quotient + 1n : quotient
}

/**
 * Parses a decimal amount into integer minor units. Rejects scientific
 * notation, hex, blanks, more fraction digits than `decimals` (unless a
 * rounding mode is given) and anything over `max`.
 */
export function parseDecimalAmount(input: unknown, options: ParseDecimalAmountOptions = {}): bigint {
  const decimals = options.decimals ?? STELLAR_DECIMALS
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError("decimals must be an integer between 0 and 36")
  }
  const rounding = options.rounding ?? "reject"
  const max = options.max ?? MAX_STELLAR_STROOPS

  let text: string
  if (typeof input === "number") text = numberToPlainDecimal(input)
  else if (typeof input === "bigint") text = input.toString()
  else if (typeof input === "string") text = input.trim()
  else throw new DecimalAmountError("NOT_A_NUMBER", "Amount must be a decimal string or number")

  if (options.acceptComma && /^[+-]?\d*,\d+$/.test(text)) text = text.replace(",", ".")
  if (SCIENTIFIC.test(text)) {
    throw new DecimalAmountError("SCIENTIFIC_NOTATION", "Scientific notation is not accepted for amounts")
  }
  const match = PLAIN_DECIMAL.exec(text) ?? LEADING_DOT_DECIMAL.exec(text)
  if (!match) throw new DecimalAmountError("MALFORMED", "Amount must be a plain decimal number")

  const [, sign, whole, fraction = ""] = match
  const negative = sign === "-"
  const kept = fraction.slice(0, decimals)
  const dropped = fraction.slice(decimals)
  if (dropped.length > 0 && !/^0*$/.test(dropped) && rounding === "reject") {
    throw new DecimalAmountError("TOO_MANY_DECIMALS", `Amount has more than ${decimals} decimal places`)
  }
  let magnitude = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(kept.padEnd(decimals, "0") || "0")
  if (rounding !== "reject") magnitude = roundQuotient(magnitude, dropped, negative, rounding)

  if (magnitude > max) throw new DecimalAmountError("OVERFLOW", "Amount exceeds the maximum allowed value")
  if (magnitude === 0n) {
    if (!options.allowZero) throw new DecimalAmountError("ZERO", "Amount must be greater than zero")
    return 0n
  }
  if (negative && !options.allowNegative) throw new DecimalAmountError("NEGATIVE", "Amount must not be negative")
  return negative ? -magnitude : magnitude
}

/** Non-throwing variant for call sites that map failures to their own response. */
export function tryParseDecimalAmount(
  input: unknown,
  options: ParseDecimalAmountOptions = {},
): { ok: true; units: bigint } | { ok: false; error: DecimalAmountError } {
  try {
    return { ok: true, units: parseDecimalAmount(input, options) }
  } catch (error) {
    if (error instanceof DecimalAmountError) return { ok: false, error }
    throw error
  }
}

export type FormatDecimalAmountOptions = {
  decimals?: number
  /** Fraction digits to show; extra digits are rounded with `rounding`. Default `decimals`. */
  fractionDigits?: number
  rounding?: Exclude<DecimalRoundingMode, "reject">
}

/** Formats integer minor units as a decimal string without going through a double. */
export function formatDecimalAmount(units: bigint, options: FormatDecimalAmountOptions = {}): string {
  const decimals = options.decimals ?? STELLAR_DECIMALS
  const digits = options.fractionDigits ?? decimals
  if (!Number.isInteger(digits) || digits < 0 || digits > decimals) {
    throw new RangeError("fractionDigits must be between 0 and decimals")
  }
  const negative = units < 0n
  let magnitude = negative ? -units : units
  const scale = 10n ** BigInt(decimals - digits)
  if (scale > 1n) {
    const dropped = (magnitude % scale).toString().padStart(decimals - digits, "0")
    magnitude = roundQuotient(magnitude / scale, dropped, negative, options.rounding ?? "half-up")
  }
  const base = 10n ** BigInt(digits)
  const whole = magnitude / base
  const fraction = digits > 0 ? `.${(magnitude % base).toString().padStart(digits, "0")}` : ""
  return `${negative && magnitude !== 0n ? "-" : ""}${whole}${fraction}`
}

/**
 * The market stores amounts as JS numbers. This is the closest double to an
 * exact stroop amount, which is the best a number field can hold without a
 * data migration.
 */
export function stroopsToNumber(units: bigint): number {
  return Number(formatDecimalAmount(units))
}

/** `units * bps / 10_000`, rounded with `rounding`; the caller keeps the remainder. */
export function bpsShare(
  units: bigint,
  bps: number,
  rounding: Exclude<DecimalRoundingMode, "reject"> = "floor",
): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError("bps must be an integer 0-10000")
  const product = units * BigInt(bps)
  const negative = product < 0n
  const magnitude = negative ? -product : product
  const dropped = (magnitude % 10_000n).toString().padStart(4, "0")
  const share = roundQuotient(magnitude / 10_000n, dropped, negative, rounding)
  return negative ? -share : share
}

/** Stroops for a stored JS-number PHASELQ amount, rounded half-up at the seventh place. */
export function numberToStroops(value: number): bigint {
  return parseDecimalAmount(value, { rounding: "half-up", allowZero: true, allowNegative: true })
}

export function isDecimalAmountParsingEnabled(): boolean {
  return isFeatureEnabled("phase-265")
}

/**
 * True when `amount` (integer stroops, string or number) is at least
 * `requiredStroops`. Malformed, fractional, scientific or hex amounts never
 * satisfy a payment, and an unparseable requirement fails closed.
 */
export function meetsRequiredStroops(amount: unknown, requiredStroops: string): boolean {
  const required = tryParseDecimalAmount(requiredStroops, { decimals: 0, max: 2n ** 127n })
  const paid = tryParseDecimalAmount(amount, { decimals: 0, allowZero: true, max: 2n ** 127n })
  return required.ok && paid.ok && paid.units >= required.units
}

/** Stroop string for a stored PHASELQ number; legacy `toFixed(7)` path when phase-265 is off. */
export function phaselqToStroopString(value: number): string {
  if (isDecimalAmountParsingEnabled()) return numberToStroops(value).toString()
  return decimalToStroops(value.toFixed(7))
}
