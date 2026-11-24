import { NextRequest } from "next/server"
import { createApiRequestContext } from "@/lib/api-observability"
import { checkAdminKey } from "@/lib/admin-key"
import { getPricingExperimentStats, isPricingOracleEnabled } from "@/lib/pricing-oracle"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** GET — operator A/B readout: accept rate and time-to-sale per arm. */
export async function GET(request: NextRequest) {
  const api = createApiRequestContext(request, "/api/market/price-suggestion/stats")
  if (!isPricingOracleEnabled()) {
    return api.json({ error: "PRICING_DISABLED" }, { status: 404, event: "pricing.disabled" })
  }
  const auth = checkAdminKey(request)
  if (auth !== "ok") {
    return api.json(
      { error: auth === "unconfigured" ? "ADMIN_NOT_CONFIGURED" : "UNAUTHORIZED" },
      { status: auth === "unconfigured" ? 503 : 401, event: "pricing.stats_unauthorized" },
    )
  }
  const since = Math.max(0, Number(request.nextUrl.searchParams.get("since") ?? 0) || 0)
  return api.json({ arms: getPricingExperimentStats(since), since }, { event: "pricing.stats", headers: { "Cache-Control": "no-store" } })
}
