import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import {
  followUser,
  unfollowUser,
  getFollowCounts,
  getFollowSuggestions,
  isFollowing,
  isPhase118Enabled,
  isPhase138Enabled,
  recordRequestCost,
  getRequestCost,
  FollowSuggestionQuerySchema,
  validateSep50MetadataBeforePin,
  getFollowSuggestions,
  FollowSuggestionQuerySchema,
} from "@/lib/follow-store";
import { createNotification } from "@/lib/notification-store";
import { getProfile } from "@/lib/profile-store";
import { checkAndUnlock } from "@/lib/achievement-store";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** phase-138: stable id to attribute a request's infra cost against. */
function requestCostId(request: NextRequest): string {
  return (
    request.headers.get("x-correlation-id")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    randomUUID()
  ).slice(0, 128);
}

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
  if (!wallet || !StrKey.isValidEd25519PublicKey(wallet)) {
    return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
  }
  if (request.nextUrl.searchParams.get("mode") === "suggestions") {
    if (!isFeatureEnabled("phase-88")) {
      return NextResponse.json(
        { error: "Follow suggestions are disabled" },
        { status: 404 },
      );
    }
    const parsed = FollowSuggestionQuerySchema.safeParse({
      wallet,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        { status: 400 },
      );
    }

    // Get search query for typo-tolerant filtering
    const searchQuery =
      request.nextUrl.searchParams.get("search")?.trim() ?? "";

    let suggestions = await getFollowSuggestions(
      parsed.data.wallet,
      parsed.data.limit,
    );

    // Apply typo-tolerant search if query provided
    if (searchQuery) {
      const { searchFollowSuggestionsWithTypoTolerance } =
        await import("@/lib/follow-store");
      suggestions = searchFollowSuggestionsWithTypoTolerance(
        searchQuery,
        suggestions,
        0.5,
      );
    }

    const enriched = await Promise.all(
      suggestions.map(async (suggestion) => {
        const profile = await getProfile(suggestion.wallet);
        return { ...suggestion, displayName: profile?.display_name };
      }),
    );

    // phase-138: attribute the Horizon fan-out + profile enrichment cost to this request
    if (isPhase138Enabled()) {
      const costId = requestCostId(request);
      recordRequestCost({ requestId: costId, operation: "follow.suggestions", source: "api" });
      recordRequestCost({ requestId: costId, operation: "horizon.account_lookup", source: "horizon" });
      recordRequestCost({ requestId: costId, operation: "horizon.asset_holders", source: "horizon" });
      if (enriched.length > 0) {
        recordRequestCost({
          requestId: costId,
          operation: "profile.enrichment",
          count: enriched.length,
          source: "store",
        });
      }
      const costUnits = getRequestCost(costId).totalUnits;
      return NextResponse.json(
        { suggestions: enriched, costUnits },
        { headers: { "X-Phase138-Cost-Units": String(costUnits) } },
      );
    }
    return NextResponse.json({ suggestions: enriched });
  }
  const viewer = request.nextUrl.searchParams.get("viewer")?.trim() ?? "";
  const counts = await getFollowCounts(wallet);
  const viewing =
    viewer && StrKey.isValidEd25519PublicKey(viewer) && viewer !== wallet
      ? await isFollowing(viewer, wallet)
      : null;
  return NextResponse.json({ ...counts, isFollowing: viewing });
}

type FollowBody = {
  from?: unknown;
  to?: unknown;
  action?: unknown;
  metadata?: unknown;
};

export async function POST(request: NextRequest) {
  let body: FollowBody;
  try {
    body = (await request.json()) as FollowBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.from !== "string" ||
    !StrKey.isValidEd25519PublicKey(body.from)
  ) {
    return NextResponse.json({ error: "Invalid from wallet" }, { status: 400 });
  }
  if (typeof body.to !== "string" || !StrKey.isValidEd25519PublicKey(body.to)) {
    return NextResponse.json({ error: "Invalid to wallet" }, { status: 400 });
  }
  if (body.from === body.to) {
    return NextResponse.json(
      { error: "Cannot follow yourself" },
      { status: 400 },
    );
  }
  if (body.action !== "follow" && body.action !== "unfollow") {
    return NextResponse.json(
      { error: "action must be follow or unfollow" },
      { status: 400 },
    );
  }
  if (isPhase118Enabled() && body.metadata !== undefined) {
    const validation = validateSep50MetadataBeforePin(body.metadata);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: validation.error.message,
          code: validation.error.code,
          details: validation.error.details,
        },
        { status: 400 },
      );
    }
  }

  const costId = requestCostId(request);

  if (body.action === "follow") {
    await followUser(body.from, body.to);
    if (isPhase138Enabled()) {
      recordRequestCost({ requestId: costId, operation: "follow.write", source: "api", wallet: body.from });
      recordRequestCost({ requestId: costId, operation: "notification.create", source: "api" });
    }
    // Fire-and-forget: notify the followed user
    void (async () => {
      try {
        const fromProfile = await getProfile(body.from as string);
        const fromName =
          fromProfile?.display_name ?? `${(body.from as string).slice(0, 6)}…`;
        await createNotification(body.to as string, "new_follower", {
          from_wallet: body.from,
          from_name: fromName,
        });
        await checkAndUnlock(body.to as string, { follower_delta: 1 });
      } catch {
        /* silent */
      }
    })();
  } else {
    await unfollowUser(body.from, body.to);
    if (isPhase138Enabled()) {
      recordRequestCost({ requestId: costId, operation: "follow.write", source: "api", wallet: body.from });
    }
  }

  const counts = await getFollowCounts(body.to);
  return NextResponse.json({
    ok: true,
    ...counts,
    metadata_validation_enabled: isPhase118Enabled(),
    ...(isPhase138Enabled() ? { costUnits: getRequestCost(costId).totalUnits } : {}),
  });
}
