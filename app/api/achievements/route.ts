import { NextRequest } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { getAchievements, getWalletData, getAchievementTimeline, isTimelineVisualizationEnabled } from "@/lib/achievement-store"
import { createApiRequestContext } from "@/lib/api-observability"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const api = createApiRequestContext(request, "/api/achievements")
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? ""

  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return api.json(
      { error: "valid wallet required" },
      { status: 400, event: "achievements.validation_failed", metadata: { reason: "wallet" } },
    )
  }

  try {
    const [achievements, data] = await Promise.all([
      getAchievements(wallet),
      getWalletData(wallet),
    ])

    const timeline = isTimelineVisualizationEnabled() ? await getAchievementTimeline(wallet) : undefined

    return api.json(
      {
        achievements,
        ...(timeline !== undefined ? { timeline } : {}),
        counters: {
          mint_count: data.mint_count ?? 0,
          daily_streak: data.daily_streak ?? 0,
          total_upvotes: data.total_upvotes ?? 0,
          follower_count: data.follower_count ?? 0,
          narrator_count: data.narrator_count ?? 0,
        },
      },
      { event: "achievements.loaded", metadata: { wallet } },
    )
  } catch (error) {
    return api.errorJson(error, 500, "achievements.load_failed")
  }
}