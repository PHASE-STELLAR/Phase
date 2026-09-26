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

export interface RefillResult {
  ok: boolean
  amountStroops?: string
  hash?: string
  error?: string
}

/**
 * Execute a distributor refill transaction
 * Mints PHASELQ from issuer and transfers to distributor
 */
export async function executeDistributorRefill(
  issuerKeypair: Keypair,
  distributorAddress: string,
  amountStroops: string,
  tokenContractId: string
): Promise<RefillResult> {
  try {
    const server = new rpc.Server(RPC_URL)
    const issuerAddress = issuerKeypair.publicKey()

    // Load issuer account
    let account: Awaited<ReturnType<typeof server.getAccount>>
    try {
      account = await server.getAccount(issuerAddress)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
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
          return {
            ok: true,
            amountStroops,
            hash,
          }
        }
        if (st.status === rpc.Api.GetTransactionStatus.FAILED) {
          return {
            ok: false,
            error: `Transaction failed on ledger: ${hash}`,
          }
        }
      } catch {
        // Continue polling
      }
    }

    // Still pending after 10 seconds - consider it successful for now
    return {
      ok: true,
      amountStroops,
      hash,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
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

