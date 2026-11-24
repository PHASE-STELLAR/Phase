/**
 * phase-215 — SSRF fence for outbound webhook subscribers.
 *
 * Three layers:
 *   1. Static URL validation: https only, no embedded credentials, no
 *      localhost/internal hostnames, no private IP literals.
 *   2. DNS resolution: every resolved address must be a public unicast IP —
 *      this catches hostnames that point at 127.0.0.1 / 10.x / link-local.
 *   3. Pinning: delivery uses the resolved address via `https.request`'s
 *      `lookup` callback while keeping the original hostname for TLS SNI, so
 *      the address that was checked is the address that is contacted.
 *
 * The endpoint is re-checked before every attempt, so a DNS change cannot
 * silently route a later retry into a private network.
 *
 * Flag: phase-215. Rollback: unset flag — subscriptions are inert, no URL is
 * contacted. No persisted state beyond the subscription rows themselves.
 */

import { lookup } from "node:dns/promises"
import { request, type RequestOptions } from "node:https"
import { isIP } from "node:net"

export type SafeEndpoint = {
  url: URL
  hostname: string
  addresses: string[]
  /** Safe to log: no query string, userinfo or path parameters. */
  logLabel: string
}

export class SsrfFenceError extends Error {
  readonly reason:
    | "malformed"
    | "insecure_protocol"
    | "credentials"
    | "loopback_hostname"
    | "ip_literal"
    | "private_address"
    | "no_public_address"
    | "dns_failure"
  constructor(reason: SsrfFenceError["reason"], message: string) {
    super(message)
    this.name = "SsrfFenceError"
    this.reason = reason
  }
}

const BLOCKED_HOST_SUFFIXES = [
  ".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".test", ".invalid",
]

function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "")
  if (lower === "localhost" || lower === "localhost.localdomain") return true
  if (lower === "metadata.google.internal" || lower === "metadata") return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums
}

/** Public unicast only. Covers loopback, private, link-local, CGNAT and docs/test ranges. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase()
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7)
    return isPrivateAddress(mapped)
  }
  if (ip === "::" || ip === "::1") return true
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true // fc00::/7
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true // fe80::/10
  if (ip.startsWith("ff")) return true // multicast
  if (/^2001:0?db8:/i.test(ip)) return true // documentation
  if (ip.includes(":")) return false

  const o = ipv4Octets(ip)
  if (!o) return true
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && (b === 168 || b === 0 || b === 2)) return true
  if (a === 198 && (b === 18 || b === 19 || b === 51 || b === 100)) return true
  if (a === 203 && b === 0 && o[2] === 113) return true
  return false
}

/** Static validation that needs no DNS. Safe to call at subscription creation. */
export function validateWebhookUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new SsrfFenceError("malformed", "webhook url must be a non-empty string")
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfFenceError("malformed", "webhook url is not a valid URL")
  }
  if (url.protocol !== "https:") {
    throw new SsrfFenceError("insecure_protocol", "webhook url must use https")
  }
  if (url.username || url.password) {
    throw new SsrfFenceError("credentials", "webhook url must not contain credentials")
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (isBlockedHostname(host)) {
    throw new SsrfFenceError("loopback_hostname", "webhook hostname is loopback/internal")
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new SsrfFenceError("ip_literal", "webhook url must not use a private IP literal")
  }
  return url
}

/** Resolve and verify all addresses; returns the pinned set for delivery. */
export async function resolveSafeEndpoint(raw: unknown): Promise<SafeEndpoint> {
  const url = validateWebhookUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  let addresses: string[]
  try {
    addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((entry) => entry.address)
  } catch {
    throw new SsrfFenceError("dns_failure", "webhook hostname could not be resolved")
  }
  if (addresses.length === 0) {
    throw new SsrfFenceError("no_public_address", "webhook hostname resolved to no addresses")
  }
  if (addresses.some(isPrivateAddress)) {
    throw new SsrfFenceError("private_address", "webhook hostname resolves to a private address")
  }
  return {
    url,
    hostname: host,
    addresses,
    logLabel: `${url.protocol}//${url.hostname}${url.pathname}`,
  }
}

export type PinnedResponse = { ok: boolean; status: number | null }

/**
 * POST to the already-verified endpoint using the pinned address. Redirects
 * are rejected: a 30x to a private host would bypass the DNS check.
 */
export function postToPinnedEndpoint(
  endpoint: SafeEndpoint,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<PinnedResponse> {
  return new Promise((resolve) => {
    const pinned = endpoint.addresses[0]
    const family = isIP(pinned) === 6 ? 6 : 4
    const options: RequestOptions = {
      protocol: "https:",
      hostname: pinned,
      port: endpoint.url.port ? Number(endpoint.url.port) : 443,
      path: `${endpoint.url.pathname}${endpoint.url.search}`,
      method: "POST",
      headers: {
        ...headers,
        host: endpoint.url.host,
        "content-length": Buffer.byteLength(body),
      },
      servername: endpoint.hostname, // TLS SNI stays on the verified hostname
      lookup: (_hostname, _opts, callback) => callback(null, pinned, family),
      timeout: timeoutMs,
      rejectUnauthorized: true,
    }
    const req = request(options, (res) => {
      // Drain the response so the socket is freed.
      res.resume()
      resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode ?? null })
    })
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", () => resolve({ ok: false, status: null }))
    req.write(body)
    req.end()
  })
}
