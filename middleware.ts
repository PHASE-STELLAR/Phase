import { NextRequest, NextResponse } from "next/server"
import { isFeatureEnabled } from "@/lib/feature-flags"

function getPhaseEnvironment(): string {
  if (typeof process === "undefined" || !process.env) return "production"
  const env = process.env.NEXT_PUBLIC_PHASE_ENV ?? process.env.NODE_ENV ?? "production"
  return env
}

function buildCSP(): string {
  const environment = getPhaseEnvironment()
  const isDev = environment === "development"

  const cspParts = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' 'unsafe-inline'${isDev ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.stellar.org https://soroban-testnet.stellar.org wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]

  return cspParts.join("; ")
}

export function middleware(request: NextRequest): NextResponse {
  let response = NextResponse.next()
  if (isFeatureEnabled("phase-175") && request.nextUrl.pathname.startsWith("/link/")) {
    const parts = request.nextUrl.pathname.split("/").filter(Boolean)
    const target = parts[1] === "collection" ? "/chamber" : parts[1] === "quest" ? "/forge" : "/dashboard"
    const rewritten = request.nextUrl.clone()
    rewritten.pathname = target
    rewritten.search = ""
    rewritten.searchParams.set("phase_link", request.nextUrl.pathname + request.nextUrl.search)
    if (parts[1] === "collection" && /^[1-9]\d*$/.test(parts[2] ?? "")) rewritten.searchParams.set("collection", parts[2])
    response = NextResponse.rewrite(rewritten)
    response.headers.set("Cache-Control", "private, no-store")
  }
  const csp = buildCSP()

  response.headers.set("Content-Security-Policy", csp)
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("X-Frame-Options", "DENY")
  response.headers.set("X-XSS-Protection", "1; mode=block")

  return response
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
}
