import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { processSupportQuery } from "@/lib/support-bot";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isFeatureEnabled("phase-150")) {
    return NextResponse.json({ error: "Feature phase-150 disabled" }, { status: 404 });
  }

  try {
    const body = await req.json();
    if (!body || typeof body.query !== "string" || !body.query.trim()) {
      return NextResponse.json({ error: "Missing required query string" }, { status: 400 });
    }

    const result = processSupportQuery(body.query);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to process query" }, { status: 500 });
  }
}
