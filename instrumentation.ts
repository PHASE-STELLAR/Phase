/**
 * Next.js runs `register()` once when a server instance starts, including on
 * preview deployments. phase-266 (issue #724) validates the environment here so
 * a misconfigured deployment fails at boot instead of on its first request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { enforceEnvAtStartup } = await import("@/lib/env-validation")
  enforceEnvAtStartup()
}
