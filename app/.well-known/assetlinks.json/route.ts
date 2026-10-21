import { NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"
export function GET() {
  if (!isFeatureEnabled("phase-175")) return new NextResponse(null, { status: 404 })
  const packageName = process.env.PHASE_ANDROID_PACKAGE
  const fingerprints = (process.env.PHASE_ANDROID_SHA256_CERTS ?? "").split(",").map(s => s.trim()).filter(s => /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(s))
  return NextResponse.json(packageName && fingerprints.length ? [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: fingerprints } }] : [])
}
