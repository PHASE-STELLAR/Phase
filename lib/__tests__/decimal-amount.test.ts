import assert from "node:assert/strict"
import { afterEach, describe, it } from "vitest"
import {
  bpsShare,
  DecimalAmountError,
  formatDecimalAmount,
  MAX_STELLAR_STROOPS,
  meetsRequiredStroops,
  numberToStroops,
  parseDecimalAmount,
  phaselqToStroopString,
  tryParseDecimalAmount,
} from "@/lib/decimal-amount"
import { liqToStroops, stroopsToLiqDisplay } from "@/lib/phase-protocol"
import { computeCollabSplits, computeRoyaltySplit } from "@/lib/market-store"
import { previewEscrowFanOut } from "@/lib/escrow-settlement"
import { decimalToStroops as poolDecimalToStroops } from "@/lib/liquidity-pool"

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof DecimalAmountError, `expected DecimalAmountError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected the parser to throw")
}

afterEach(() => {
  delete process.env.FEATURE_PHASE_265
})

describe("phase-265 parseDecimalAmount", () => {
  it("parses plain decimals into stroops exactly", () => {
    assert.equal(parseDecimalAmount("1"), 10_000_000n)
    assert.equal(parseDecimalAmount("0.1"), 1_000_000n)
    assert.equal(parseDecimalAmount("0.0000001"), 1n)
    assert.equal(parseDecimalAmount(" 12.5 "), 125_000_000n)
    assert.equal(parseDecimalAmount(".5"), 5_000_000n)
    assert.equal(parseDecimalAmount("1.2300000000"), 12_300_000n)
  })

  it("keeps JS numbers at the value written in the JSON body", () => {
    assert.equal(parseDecimalAmount(0.1), 1_000_000n)
    assert.equal(parseDecimalAmount(0.3), 3_000_000n)
    assert.equal(parseDecimalAmount(1e-7), 1n)
    assert.equal(parseDecimalAmount(123456.789), 1_234_567_890_000n)
    // 0.1 + 0.2 is 0.30000000000000004; it must not silently become 0.3.
    assert.equal(code(() => parseDecimalAmount(0.1 + 0.2)), "TOO_MANY_DECIMALS")
    assert.equal(parseDecimalAmount(0.1 + 0.2, { rounding: "half-up" }), 3_000_000n)
  })

  it("rejects scientific notation, hex, blanks and junk", () => {
    assert.equal(code(() => parseDecimalAmount("1e7")), "SCIENTIFIC_NOTATION")
    assert.equal(code(() => parseDecimalAmount("1.5E-3")), "SCIENTIFIC_NOTATION")
    assert.equal(code(() => parseDecimalAmount("0x10")), "MALFORMED")
    assert.equal(code(() => parseDecimalAmount("")), "MALFORMED")
    assert.equal(code(() => parseDecimalAmount("1,000.5")), "MALFORMED")
    assert.equal(code(() => parseDecimalAmount("1.")), "MALFORMED")
    assert.equal(code(() => parseDecimalAmount("Infinity")), "MALFORMED")
    assert.equal(code(() => parseDecimalAmount("12abc")), "MALFORMED")
    assert.equal(code(() => parseDecimalAmount(Number.NaN)), "NOT_A_NUMBER")
    assert.equal(code(() => parseDecimalAmount(null)), "NOT_A_NUMBER")
    assert.equal(code(() => parseDecimalAmount({})), "NOT_A_NUMBER")
  })

  it("accepts a comma decimal separator only when asked", () => {
    assert.equal(code(() => parseDecimalAmount("1,5")), "MALFORMED")
    assert.equal(parseDecimalAmount("1,5", { acceptComma: true }), 15_000_000n)
  })

  it("rejects zero and negatives unless allowed", () => {
    assert.equal(code(() => parseDecimalAmount("0")), "ZERO")
    assert.equal(code(() => parseDecimalAmount("-0.0000000")), "ZERO")
    assert.equal(parseDecimalAmount("0", { allowZero: true }), 0n)
    assert.equal(code(() => parseDecimalAmount("-1")), "NEGATIVE")
    assert.equal(parseDecimalAmount("-1.5", { allowNegative: true }), -15_000_000n)
  })

  it("enforces the int64 stroop ceiling at the boundary", () => {
    assert.equal(parseDecimalAmount("922337203685.4775807"), MAX_STELLAR_STROOPS)
    assert.equal(code(() => parseDecimalAmount("922337203685.4775808")), "OVERFLOW")
    assert.equal(code(() => parseDecimalAmount("9".repeat(40))), "OVERFLOW")
    assert.equal(parseDecimalAmount("5", { max: 50_000_000n }), 50_000_000n)
    assert.equal(code(() => parseDecimalAmount("5.0000001", { max: 50_000_000n })), "OVERFLOW")
  })

  it("rejects extra decimals by default and applies each rounding mode exactly", () => {
    assert.equal(code(() => parseDecimalAmount("0.00000015")), "TOO_MANY_DECIMALS")
    const cases: Array<[string, Record<string, bigint>]> = [
      ["0.00000015", { floor: 1n, ceil: 2n, "half-up": 2n, "half-even": 2n }],
      ["0.00000025", { floor: 2n, ceil: 3n, "half-up": 3n, "half-even": 2n }],
      ["0.000000251", { floor: 2n, ceil: 3n, "half-up": 3n, "half-even": 3n }],
      ["0.00000014999", { floor: 1n, ceil: 2n, "half-up": 1n, "half-even": 1n }],
      ["-0.00000015", { floor: -2n, ceil: -1n, "half-up": -2n, "half-even": -2n }],
    ]
    for (const [input, expected] of cases) {
      for (const [mode, value] of Object.entries(expected)) {
        assert.equal(
          parseDecimalAmount(input, { rounding: mode as "floor", allowNegative: true }),
          value,
          `${input} ${mode}`,
        )
      }
    }
  })

  it("parses integers with decimals: 0", () => {
    assert.equal(parseDecimalAmount("100000000", { decimals: 0 }), 100_000_000n)
    assert.equal(code(() => parseDecimalAmount("1.5", { decimals: 0 })), "TOO_MANY_DECIMALS")
    assert.equal(parseDecimalAmount("7.000", { decimals: 0 }), 7n)
  })

  it("returns errors without throwing from tryParseDecimalAmount", () => {
    const bad = tryParseDecimalAmount("1e3")
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.error.code, "SCIENTIFIC_NOTATION")
    const good = tryParseDecimalAmount("2")
    assert.deepEqual(good, { ok: true, units: 20_000_000n })
  })
})

describe("phase-265 formatting and splits", () => {
  it("formats minor units without a double", () => {
    assert.equal(formatDecimalAmount(MAX_STELLAR_STROOPS), "922337203685.4775807")
    assert.equal(formatDecimalAmount(1n), "0.0000001")
    assert.equal(formatDecimalAmount(-15_000_000n), "-1.5000000")
    assert.equal(formatDecimalAmount(12_345_000n, { fractionDigits: 2 }), "1.23")
    assert.equal(formatDecimalAmount(12_350_000n, { fractionDigits: 2 }), "1.24")
    assert.equal(formatDecimalAmount(12_350_000n, { fractionDigits: 2, rounding: "half-even" }), "1.24")
    assert.equal(formatDecimalAmount(12_250_000n, { fractionDigits: 2, rounding: "half-even" }), "1.22")
    assert.equal(formatDecimalAmount(49_999n, { fractionDigits: 2 }), "0.00")
    assert.equal(formatDecimalAmount(7n, { decimals: 0 }), "7")
  })

  it("round-trips parse and format", () => {
    for (const value of ["0.0000001", "1.0000000", "123.4567890", "922337203685.4775807"]) {
      assert.equal(formatDecimalAmount(parseDecimalAmount(value)), value)
    }
  })

  it("splits by basis points with explicit rounding", () => {
    assert.equal(bpsShare(10n, 2_500), 2n)
    assert.equal(bpsShare(10n, 2_500, "half-up"), 3n)
    assert.equal(bpsShare(10n, 2_500, "ceil"), 3n)
    assert.equal(bpsShare(MAX_STELLAR_STROOPS, 10_000), MAX_STELLAR_STROOPS)
    assert.throws(() => bpsShare(10n, 10_001), RangeError)
    assert.throws(() => bpsShare(10n, 1.5), RangeError)
  })

  it("converts stored numbers to stroops at the seventh place", () => {
    assert.equal(numberToStroops(0.1 + 0.2), 3_000_000n)
    assert.equal(numberToStroops(0), 0n)
  })

  it("compares x402 amounts as integer stroops and fails closed", () => {
    assert.equal(meetsRequiredStroops("100000000", "100000000"), true)
    assert.equal(meetsRequiredStroops(100000001, "100000000"), true)
    assert.equal(meetsRequiredStroops("99999999", "100000000"), false)
    assert.equal(meetsRequiredStroops("1e9", "100000000"), false)
    assert.equal(meetsRequiredStroops("0x5F5E100", "100000000"), false)
    assert.equal(meetsRequiredStroops("100000000.5", "100000000"), false)
    assert.equal(meetsRequiredStroops("", "100000000"), false)
    assert.equal(meetsRequiredStroops("100000000", "garbage"), false)
    assert.equal(meetsRequiredStroops("100000000", "0"), false)
    // Above 2^53 a double would round both sides to the same value.
    assert.equal(meetsRequiredStroops("9007199254740993", "9007199254740993"), true)
    assert.equal(meetsRequiredStroops("9007199254740992", "9007199254740993"), false)
  })
})

describe("phase-265 call sites", () => {
  it("liqToStroops: legacy float rounding when off, exact when on", () => {
    assert.equal(liqToStroops("1,5"), "15000000")
    assert.equal(liqToStroops("1e2"), "1000000000")
    assert.equal(liqToStroops("12abc"), "120000000")
    process.env.FEATURE_PHASE_265 = "1"
    assert.equal(liqToStroops("1,5"), "15000000")
    assert.equal(liqToStroops("1e2"), "0")
    assert.equal(liqToStroops("12abc"), "0")
    assert.equal(liqToStroops("0.00000015"), "2")
    assert.equal(liqToStroops("922337203685.4775807"), "9223372036854775807")
    assert.equal(liqToStroops("922337203685.4775808"), "0")
  })

  it("stroopsToLiqDisplay: exact two-place rounding when on", () => {
    assert.equal(stroopsToLiqDisplay("12abc"), "0.00")
    process.env.FEATURE_PHASE_265 = "1"
    assert.equal(stroopsToLiqDisplay("100000000"), "10.00")
    assert.equal(stroopsToLiqDisplay("125000"), "0.01")
    assert.equal(stroopsToLiqDisplay("9223372036854775807"), "922337203685.48")
    assert.equal(stroopsToLiqDisplay("12abc"), "0.00")
  })

  it("royalty split: seller + royalty always equals the sale", () => {
    const listing = { seller_wallet: "SELLER", creator_wallet: "CREATOR", royalty_bps: 333 }
    process.env.FEATURE_PHASE_265 = "1"
    for (const sale of [0.1, 0.3, 1.2345678, 200, 999_999.9999999]) {
      const split = computeRoyaltySplit(listing, sale)
      assert.equal(
        numberToStroops(split.royalty_amount_phaselq) + numberToStroops(split.seller_amount_phaselq),
        numberToStroops(sale),
        `sale ${sale}`,
      )
    }
    const split = computeRoyaltySplit({ ...listing, royalty_bps: 750 }, 200)
    assert.equal(split.royalty_amount_phaselq, 15)
    assert.equal(split.seller_amount_phaselq, 185)
  })

  it("royalty split: the legacy path drifts, the exact path does not", () => {
    const listing = { seller_wallet: "SELLER", creator_wallet: "CREATOR", royalty_bps: 1_000 }
    const legacy = computeRoyaltySplit(listing, 0.7)
    assert.equal(legacy.seller_amount_phaselq, 0.6299999999999999)
    process.env.FEATURE_PHASE_265 = "1"
    const exact = computeRoyaltySplit(listing, 0.7)
    assert.equal(exact.royalty_amount_phaselq, 0.07)
    assert.equal(exact.seller_amount_phaselq, 0.63)
  })

  it("collab and escrow splits conserve every stroop", () => {
    process.env.FEATURE_PHASE_265 = "1"
    const payees = [
      { wallet: "A", bps: 3_333 },
      { wallet: "B", bps: 3_333 },
      { wallet: "C", bps: 3_334 },
    ]
    for (const sale of [0.0000001, 1, 10.0000001, 123_456.7654321]) {
      const collab = computeCollabSplits(sale, payees)
      const escrow = previewEscrowFanOut(sale, payees)
      const total = numberToStroops(sale)
      assert.equal(collab.reduce((sum, p) => sum + numberToStroops(p.amount_phaselq), 0n), total)
      assert.equal(escrow.reduce((sum, p) => sum + numberToStroops(p.amount), 0n), total)
    }
  })

  it("tax amounts: same stroops either way for ordinary values", () => {
    assert.equal(phaselqToStroopString(12.5), "125000000")
    process.env.FEATURE_PHASE_265 = "1"
    assert.equal(phaselqToStroopString(12.5), "125000000")
    assert.equal(phaselqToStroopString(0.1 + 0.2), "3000000")
  })

  it("liquidity pool parsing: truncates when off, rejects when on", () => {
    assert.equal(poolDecimalToStroops("1.00000019"), 10_000_001n)
    assert.throws(() => poolDecimalToStroops("1e3"))
    process.env.FEATURE_PHASE_265 = "1"
    assert.throws(() => poolDecimalToStroops("1.00000019"), /more than 7 decimal places/)
    assert.throws(() => poolDecimalToStroops("922337203685.4775808"), /maximum/)
    assert.equal(poolDecimalToStroops("0.0000000"), 0n)
    assert.equal(poolDecimalToStroops("2.5"), 25_000_000n)
  })
})
