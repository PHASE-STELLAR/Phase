// @ts-nocheck
/**
 * Distributor Auto-Refill Engine
 * 
 * Executes automatic PHASELQ transfers from issuer to distributor
 * when distributor balance falls below threshold.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk"
import { NETWORK_PASSPHRASE, RPC_URL } from "@/lib/phase-protocol"
import { incSecurityCounter } from "@/lib/security-counters"

export interface RefillResult {
  ok: boolean
  amountStroops?: string
  hash?: string
  error?: string
  code?: string
  holdId?: string
  availableStroops?: string
}

/**
 * Execute a distributor refill transaction
 * Mints PHASELQ from issuer and transfers to distributor
 *
 * Issue #231: the refill is now guarded by a ledger reservation. The
 * balance check and the hold happen in one IMMEDIATE transaction
 * (`reserveFunds`), so two concurrent refills cannot both read the same
 * available balance and both submit — the double-spend this issue
 * describes. The hold is committed once the transaction reaches the
 * ledger and released if the submission fails, so a failed refill does
 * not leave funds reserved forever.
 */
export async function executeDistributorRefill(
  issuerKeypair: Keypair,
  distributorAddress: string,
  amountStroops: string,
  tokenContractId: string
): Promise<RefillResult> {
  // Issue #231: take the reservation before touching the network. If the
  // distributor cannot cover the refill, this returns without a single RPC
  // call, and a concurrent caller that got here first has already consumed the
  // available balance so this one is refused rather than racing it.
  const { ensureDistributorLedger, reserveFunds, commitRefill, releaseRefill } =
    await import("@/lib/distributor-ledger")
  ensureDistributorLedger(distributorAddress)
  const reservation = reserveFunds({
    distributor: distributorAddress,
    amountStroops,
    purpose: "auto_refill",
  })
  if (!reservation.ok) {
    return {
      ok: false,
      code: reservation.code,
      error: `refill refused: ${reservation.reason}`,
      availableStroops: reservation.available,
    }
  }
  const holdId = reservation.holdId

  try {
    const server = new rpc.Server(RPC_URL)
    const issuerAddress = issuerKeypair.publicKey()

    // Load issuer account
    let account: Awaited<ReturnType<typeof server.getAccount>>
    try {
      account = await server.getAccount(issuerAddress)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Issue #231: release the hold so a failed refill does not strand funds.
      releaseRefill(holdId)
      return {
        ok: false,
        error: `Could not load issuer account: ${msg}`,
      }
    }

    // Build mint transaction (issuer -> distributor)
    const contract = new Contract(tokenContractId)
    const amountSc = nativeToScVal(BigInt(amountStroops), { type: "i128" })

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "mint",
          Address.fromString(distributorAddress).toScVal(),
          amountSc
        )
      )
      .setTimeout(30)
      .build()

    // Prepare and sign
    const prepared = await server.prepareTransaction(tx)
    prepared.sign(issuerKeypair)

    // Submit
    const send = await server.sendTransaction(prepared)
    if (send.status === "ERROR") {
      const err = (send as { errorResult?: unknown }).errorResult
      if (String(err ?? send).toLowerCase().includes("underfunded")) {
        incSecurityCounter("distributor_op_underfunded")
      }
      releaseRefill(holdId)
      return {
        ok: false,
        error: `RPC rejected transaction: ${String(err ?? send)}`,
      }
    }

    const hash = send.hash as string

    // Poll for result (max 10 seconds)
    for (let i = 0; i < 10; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1000))
      }

      try {
        const st = await server.getTransaction(hash)
        if (st.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          // Issue #231: commit the hold only once the tx is on the ledger.
          commitRefill(holdId, hash)
          return {
            ok: true,
            amountStroops,
            hash,
            holdId,
          }
        }
        if (st.status === rpc.Api.GetTransactionStatus.FAILED) {
          releaseRefill(holdId)
          return {
            ok: false,
            error: `Transaction failed on ledger: ${hash}`,
          }
        }
      } catch {
        // Continue polling
      }
    }

    // Still pending after 10 seconds. The hold stays reserved: the transaction
    // may still land, and releasing it here would let a concurrent refill
    // authorise against funds this one is about to consume.
    return {
      ok: true,
      amountStroops,
      hash,
      holdId,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    releaseRefill(holdId)
    return {
      ok: false,
      error: msg,
    }
  }
}

/**
 * Execute a classic payment refill (for classic liquidity mode)
 * Uses Horizon and classic payment operations
 */
export async function executeClassicDistributorRefill(
  issuerKeypair: Keypair,
  distributorAddress: string,
  amount: string,
  assetCode: string
): Promise<RefillResult> {
  try {
    const { Horizon, Asset, Operation, Networks } = await import("@stellar/stellar-sdk")
    const { HORIZON_URL } = await import("@/lib/phase-protocol")

    const server = new Horizon.Server(HORIZON_URL)
    const issuerAddress = issuerKeypair.publicKey()

    // Load issuer account
    let account: Horizon.AccountResponse
    try {
      account = await server.loadAccount(issuerAddress)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        error: `Could not load issuer account: ${msg}`,
      }
    }

    // Build payment transaction
    const asset = new Asset(assetCode, issuerAddress)
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: distributorAddress,
          asset,
          amount,
        })
      )
      .setTimeout(30)
      .build()

    tx.sign(issuerKeypair)

    // Submit
    const result = await server.submitTransaction(tx)
    
    return {
      ok: true,
      amountStroops: (parseFloat(amount) * 10_000_000).toString(),
      hash: result.hash,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: msg,
    }
  }
}

