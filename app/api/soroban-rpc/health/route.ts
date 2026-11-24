import { NextResponse } from "next/server"
import { getCircuitBreakerHealth } from "@/app/api/soroban-rpc/route"

/**
 * Health check endpoint for Soroban RPC circuit breaker (issue #738).
 * Exposes breaker state without PII.
 * Useful for monitoring and diagnostics.
 */
export async function GET() {
  const health = getCircuitBreakerHealth()
  return NextResponse.json(health, { status: 200 })
}
