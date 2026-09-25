import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

describe("vercel.json CORS Security Configuration (Issue #166)", () => {
  it("ensures vercel.json contains secure CORS rules without wildcard credentials bypass", () => {
    const vercelJsonPath = path.join(process.cwd(), "vercel.json")
    assert.ok(fs.existsSync(vercelJsonPath), "vercel.json must exist")
    const content = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"))

    assert.ok(Array.isArray(content.headers), "vercel.json must specify headers array")
    
    for (const rule of content.headers) {
      let allowOrigin: string | null = null
      let allowCredentials: string | null = null

      for (const h of rule.headers || []) {
        if (h.key === "Access-Control-Allow-Origin") {
          allowOrigin = h.value
        }
        if (h.key === "Access-Control-Allow-Credentials") {
          allowCredentials = h.value
        }
      }

      // Security requirement: If Access-Control-Allow-Origin is *, Access-Control-Allow-Credentials MUST NOT be "true"
      if (allowOrigin === "*") {
        assert.notEqual(
          allowCredentials,
          "true",
          "SECURITY AUDIT FAIL: vercel.json allows credentials with wildcard origin (*)! This creates a CORS bypass vulnerability.",
        )
      }
    }
  })
})
