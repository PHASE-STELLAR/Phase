import { NextRequest, NextResponse } from "next/server"

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
  const response = NextResponse.next()
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
