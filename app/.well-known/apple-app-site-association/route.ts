import { NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
export function GET() {
  if (!isFeatureEnabled("phase-175")) return new NextResponse(null, { status: 404 })
  const appID = process.env.PHASE_IOS_APP_ID
  return NextResponse.json({ applinks: { apps: [], details: appID && /^[A-Z0-9]{10}\.[a-zA-Z0-9.-]+$/.test(appID) ? [{ appID, paths: ["/link/*"] }] : [] } })
}
