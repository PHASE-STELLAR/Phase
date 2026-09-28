import { NextRequest, NextResponse } from "next/server"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { fetchDistributorBalance, distributorNeedsTopup } from "@/lib/distributor-topup"
import { sendWebhookAlert, WebhookAlertType } from "@/lib/webhook-alerts"
import { executeDistributorRefill } from "@/lib/distributor-refill"
import { getDistributorHealthStatus, recordHealthCheck } from "@/lib/distributor-health-store"

/**
 * Automated Faucet Distributor Health Monitor
 * 
 * This cron endpoint monitors the distributor wallet balance and:
 * 1. Checks PHASELQ and XLM balances
 * 2. Auto-refills from issuer when below threshold
 * 3. Sends webhook alerts when issuer is low
 * 4. Records health status for UI display
 * 
 * Configure in vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/cron/faucet-health",
 *     "schedule": "0 * * * *"
 *   }]
 * }
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Thresholds
const DISTRIBUTOR_PHASELQ_MIN_STROOPS = 1_000_000_000n // 100 PHASELQ
const DISTRIBUTOR_XLM_MIN = 50 // 50 XLM
const ISSUER_PHASELQ_ALERT_THRESHOLD = 10_000_000_000n // 1000 PHASELQ
const ISSUER_XLM_ALERT_THRESHOLD = 100 // 100 XLM
const AUTO_REFILL_AMOUNT_STROOPS = 5_000_000_000n // 500 PHASELQ

function validateCronAuth(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET?.trim()
  
  // In development, allow unauthenticated access
  if (process.env.NODE_ENV === "development" && !cronSecret) {
    return true
  }
  
  // Vercel Cron sends this header
  const vercelCronHeader = req.headers.get("x-vercel-cron")
  if (vercelCronHeader) {
    return true
  }
  
  if (!cronSecret) {
    console.warn("[cron/faucet-health] CRON_SECRET not configured")
    return false
  }
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false
  }
  
  const token = authHeader.substring(7)
  return token === cronSecret
}

function faucetUsesDistributorTransfer(): boolean {
  const s = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY?.trim()
  return Boolean(s && s.length >= 20)
}

async function checkIssuerBalance(issuerAddress: string, tokenContractId: string) {
  try {
    const { fetchDistributorBalance: fetchBalance } = await import("@/lib/distributor-topup")
    const balance = await fetchBalance(issuerAddress, tokenContractId)
    return balance
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  if (!validateCronAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized - valid cron secret required" },
      { status: 401 }
    )
  }

  // Only run health checks in transfer mode
  if (!faucetUsesDistributorTransfer()) {
    return NextResponse.json({
      ok: true,
      message: "Faucet runs in mint mode - no distributor health check needed",
      mode: "mint",
    })
  }

  const distributorSecret = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY?.trim()
  const issuerSecret = process.env.ADMIN_SECRET_KEY?.trim()
  const tokenContractId = process.env.NEXT_PUBLIC_PHASER_LIQ_TOKEN_CONTRACT?.trim()

  if (!distributorSecret || !issuerSecret || !tokenContractId) {
    return NextResponse.json(
      { error: "Missing required configuration: FAUCET_DISTRIBUTOR_SECRET_KEY, ADMIN_SECRET_KEY, or token contract" },
      { status: 503 }
    )
  }

  let distributorKp: Keypair
  let issuerKp: Keypair
  
  try {
    distributorKp = Keypair.fromSecret(distributorSecret)
    issuerKp = Keypair.fromSecret(issuerSecret)
  } catch {
    return NextResponse.json(
      { error: "Invalid secret keys" },
      { status: 500 }
    )
  }

  const distributorAddress = distributorKp.publicKey()
  const issuerAddress = issuerKp.publicKey()

  const results: {
    distributorCheck: any
    issuerCheck: any
    refillAttempt?: any
    alerts: string[]
  } = {
    distributorCheck: null,
    issuerCheck: null,
    alerts: [],
  }

  // Check distributor balance
  const distBalance = await fetchDistributorBalance(distributorAddress, tokenContractId)
  if (!distBalance) {
    results.alerts.push("⚠️ Could not fetch distributor balance")
    await recordHealthCheck({
      distributorAddress,
      issuerAddress,
      distributorPhaseLiqStroops: null,
      distributorXlm: null,
      issuerPhaseLiqStroops: null,
      issuerXlm: null,
      status: "error",
      message: "Could not fetch distributor balance",
      checkedAt: Date.now(),
    })
    return NextResponse.json({ ok: false, error: "Could not fetch distributor balance", results })
  }

  results.distributorCheck = {
    address: `${distributorAddress.slice(0, 8)}...${distributorAddress.slice(-4)}`,
    phaseLiqStroops: distBalance.phaseLiqStroops.toString(),
    phaseLiq: (Number(distBalance.phaseLiqStroops) / 10_000_000).toFixed(2),
    xlm: distBalance.nativeXlm.toFixed(2),
    checkedAt: new Date(distBalance.checkedAt).toISOString(),
  }

  // Check issuer balance
  const issuerBalance = await checkIssuerBalance(issuerAddress, tokenContractId)
  if (issuerBalance) {
    results.issuerCheck = {
      address: `${issuerAddress.slice(0, 8)}...${issuerAddress.slice(-4)}`,
      phaseLiqStroops: issuerBalance.phaseLiqStroops.toString(),
      phaseLiq: (Number(issuerBalance.phaseLiqStroops) / 10_000_000).toFixed(2),
      xlm: issuerBalance.nativeXlm.toFixed(2),
    }
  }

  // Determine health status
  let status: "healthy" | "warning" | "critical" = "healthy"
  let message = "All systems operational"

  // Check distributor levels
  const distLowPhaseLiq = distBalance.phaseLiqStroops < DISTRIBUTOR_PHASELQ_MIN_STROOPS
  const distLowXlm = distBalance.nativeXlm < DISTRIBUTOR_XLM_MIN

  if (distLowPhaseLiq || distLowXlm) {
    status = "warning"
    if (distLowPhaseLiq) {
      message = `Distributor PHASELQ low: ${results.distributorCheck.phaseLiq} PHASELQ`
      results.alerts.push(`🟡 Distributor PHASELQ below threshold: ${results.distributorCheck.phaseLiq} PHASELQ`)
    }
    if (distLowXlm) {
      message = `Distributor XLM low: ${distBalance.nativeXlm.toFixed(2)} XLM`
      results.alerts.push(`🟡 Distributor XLM below threshold: ${distBalance.nativeXlm.toFixed(2)} XLM`)
      
      // Send critical alert for XLM since we can't auto-refill it
      await sendWebhookAlert("critical", {
        title: "🔴 Distributor XLM Critical",
        message: `Distributor has only ${distBalance.nativeXlm.toFixed(2)} XLM. Manual funding required.`,
        distributorAddress,
        distributorXlm: distBalance.nativeXlm,
        threshold: DISTRIBUTOR_XLM_MIN,
      })
    }

    // Attempt auto-refill for PHASELQ
    if (distLowPhaseLiq && distributorNeedsTopup(distBalance, DISTRIBUTOR_PHASELQ_MIN_STROOPS)) {
      try {
        const refillResult = await executeDistributorRefill(
          issuerKp,
          distributorAddress,
          AUTO_REFILL_AMOUNT_STROOPS.toString(),
          tokenContractId
        )
        
        if (refillResult.ok) {
          results.refillAttempt = {
            success: true,
            amountStroops: refillResult.amountStroops,
            hash: refillResult.hash,
            message: `Auto-refilled ${(Number(refillResult.amountStroops) / 10_000_000).toFixed(2)} PHASELQ`,
          }
          results.alerts.push(`✅ Auto-refilled distributor with ${(Number(refillResult.amountStroops) / 10_000_000).toFixed(2)} PHASELQ`)
          status = "healthy"
          message = "Auto-refill successful"
          
          await sendWebhookAlert("info", {
            title: "✅ Distributor Auto-Refilled",
            message: `Successfully refilled distributor with ${(Number(refillResult.amountStroops) / 10_000_000).toFixed(2)} PHASELQ`,
            distributorAddress,
            amountStroops: refillResult.amountStroops,
            hash: refillResult.hash,
          })
        } else {
          results.refillAttempt = {
            success: false,
            error: refillResult.error,
          }
          results.alerts.push(`❌ Auto-refill failed: ${refillResult.error}`)
          status = "critical"
          
          await sendWebhookAlert("critical", {
            title: "❌ Distributor Auto-Refill Failed",
            message: `Failed to refill distributor: ${refillResult.error}`,
            distributorAddress,
            error: refillResult.error,
          })
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        results.refillAttempt = { success: false, error: errMsg }
        results.alerts.push(`❌ Auto-refill exception: ${errMsg}`)
        status = "critical"
      }
    }
  }

  // Check issuer levels and send advance warnings
  if (issuerBalance) {
    if (issuerBalance.phaseLiqStroops < ISSUER_PHASELQ_ALERT_THRESHOLD) {
      status = status === "healthy" ? "warning" : status
      results.alerts.push(`🟠 Issuer PHASELQ low: ${results.issuerCheck.phaseLiq} PHASELQ`)
      
      await sendWebhookAlert("warning", {
        title: "🟠 Issuer PHASELQ Low",
        message: `Issuer balance: ${results.issuerCheck.phaseLiq} PHASELQ. Consider minting more tokens.`,
        issuerAddress,
        issuerPhaseLiq: results.issuerCheck.phaseLiq,
        threshold: Number(ISSUER_PHASELQ_ALERT_THRESHOLD) / 10_000_000,
      })
    }
    
    if (issuerBalance.nativeXlm < ISSUER_XLM_ALERT_THRESHOLD) {
      status = status === "healthy" ? "warning" : status
      results.alerts.push(`🟠 Issuer XLM low: ${issuerBalance.nativeXlm.toFixed(2)} XLM`)
      
      await sendWebhookAlert("warning", {
        title: "🟠 Issuer XLM Low",
        message: `Issuer has ${issuerBalance.nativeXlm.toFixed(2)} XLM. Fund with Friendbot before operations fail.`,
        issuerAddress,
        issuerXlm: issuerBalance.nativeXlm,
        threshold: ISSUER_XLM_ALERT_THRESHOLD,
      })
    }
  }

  // Record health check
  await recordHealthCheck({
    distributorAddress,
    issuerAddress,
    distributorPhaseLiqStroops: distBalance.phaseLiqStroops.toString(),
    distributorXlm: distBalance.nativeXlm,
    issuerPhaseLiqStroops: issuerBalance?.phaseLiqStroops.toString() ?? null,
    issuerXlm: issuerBalance?.nativeXlm ?? null,
    status,
    message,
    checkedAt: Date.now(),
  })

  return NextResponse.json({
    ok: true,
    status,
    message,
    results,
    timestamp: new Date().toISOString(),
  })
}
