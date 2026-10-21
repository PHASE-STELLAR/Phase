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
