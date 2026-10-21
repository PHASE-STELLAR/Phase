import { StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"

export const taxExportSchema = z.object({
  wallet: z.string().refine(StrKey.isValidEd25519PublicKey),
  from: z.string().datetime(), to: z.string().datetime(), policy: z.enum(["FIFO", "HIFO"]),
  exp: z.number().int(), nonce: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
}).strict().refine(v => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= 10 * 366 * 86400_000)
export type TaxExportRequest = z.infer<typeof taxExportSchema>
export function taxExportMessage(input: TaxExportRequest, network: string): string {
  return ["phase-tax:v1", network, input.wallet, input.from, input.to, input.policy, input.exp, input.nonce].join("|")
}
