import { NextRequest, NextResponse } from "next/server"
import { getJob, listJobs } from "@/lib/forge/job-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Issue #299 fix: Add authentication to prevent unauthorized access to internal job data
function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization")
  const apiKey = process.env.FORGE_AGENT_API_KEY?.trim()
  
  // If no API key is configured, block all access
  if (!apiKey) {
    console.warn("[forge-agent/status] FORGE_AGENT_API_KEY not configured - denying access")
    return false
  }
  
  if (!authHeader) return false
  
  const token = authHeader.replace(/^Bearer\s+/i, "").trim()
  return token === apiKey
}

export async function GET(request: NextRequest) {
  // Require authentication
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { 
        status: 401,
        headers: {
          "WWW-Authenticate": "Bearer",
        }
      }
    )
  }

  const id = request.nextUrl.searchParams.get("id")?.trim()
  if (id) {
    const job = getJob(id)
    if (!job) return NextResponse.json({ success: false, error: "job not found" }, { status: 404 })
    return NextResponse.json({ success: true, job })
  }
  return NextResponse.json({ success: true, jobs: listJobs().slice(0, 20) })
}
