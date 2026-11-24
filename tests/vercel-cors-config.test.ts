import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("vercel.json CORS Security Configuration (#727)", () => {
  const vercelJsonPath = path.join(process.cwd(), "vercel.json");
  let content: any;

  it("vercel.json must exist and be valid JSON", () => {
    assert.ok(fs.existsSync(vercelJsonPath), "vercel.json must exist");
    content = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
    assert.ok(
      Array.isArray(content.headers),
      "vercel.json must have a headers array",
    );
  });

  it("no wildcard origin on credentialed routes (#727)", () => {
    content = content ?? JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
    for (const rule of content.headers) {
      let allowOrigin: string | null = null;
      let allowCredentials: string | null = null;

      for (const h of rule.headers ?? []) {
        if (h.key === "Access-Control-Allow-Origin") allowOrigin = h.value;
        if (h.key === "Access-Control-Allow-Credentials")
          allowCredentials = h.value;
      }

      assert.ok(
        !(allowOrigin === "*" && allowCredentials === "true"),
        `CORS violation on route ${rule.source}: wildcard origin (*) must not be combined with credentials=true`,
      );
    }
  });

  it("credentialed routes use an explicit allow-list origin, not wildcard (#727)", () => {
    content = content ?? JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
    for (const rule of content.headers) {
      let allowOrigin: string | null = null;
      let allowCredentials: string | null = null;

      for (const h of rule.headers ?? []) {
        if (h.key === "Access-Control-Allow-Origin") allowOrigin = h.value;
        if (h.key === "Access-Control-Allow-Credentials")
          allowCredentials = h.value;
      }

      if (allowCredentials === "true") {
        assert.notEqual(
          allowOrigin,
          "*",
          `Route ${rule.source} sets credentials=true but still uses wildcard origin`,
        );
        assert.ok(
          allowOrigin && allowOrigin.startsWith("https://"),
          `Route ${rule.source} must specify an explicit HTTPS origin when credentials=true, got: ${allowOrigin}`,
        );
      }
    }
  });

  it("preflight OPTIONS headers are present on credentialed routes (#727)", () => {
    content = content ?? JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
    for (const rule of content.headers) {
      let allowCredentials: string | null = null;
      let allowMethods: string | null = null;
      let allowHeaders: string | null = null;

      for (const h of rule.headers ?? []) {
        if (h.key === "Access-Control-Allow-Credentials")
          allowCredentials = h.value;
        if (h.key === "Access-Control-Allow-Methods") allowMethods = h.value;
        if (h.key === "Access-Control-Allow-Headers") allowHeaders = h.value;
      }

      if (allowCredentials === "true") {
        assert.ok(
          allowMethods && allowMethods.includes("OPTIONS"),
          `Route ${rule.source} with credentials must include OPTIONS in Allow-Methods`,
        );
        assert.ok(
          allowHeaders,
          `Route ${rule.source} with credentials must declare Access-Control-Allow-Headers`,
        );
      }
    }
  });
});
