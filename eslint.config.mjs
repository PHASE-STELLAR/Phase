import { builtinModules } from "node:module"
import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

// phase-268 (issue #726): code that runs on the edge runtime, and the shared
// modules it may import, must not use Node-only APIs. Keep this list in sync
// with EDGE_SAFE_MODULES in lib/edge-bundle.ts (a unit test checks both).
const EDGE_FILES = [
  "middleware.ts",
  "proxy.ts",
  "lib/feature-flags.ts",
  "lib/security-counters.ts",
  "lib/decimal-amount.ts",
  "lib/stellar-network.ts",
  "lib/deep-links.ts",
  "lib/ipfs-fallback.ts",
  "lib/edge-runtime.ts",
  "lib/edge-store.ts",
  "lib/dependency-cadence-shared.ts",
]
const EDGE_MESSAGE = "Not available on the edge runtime; move Node-only code to a module edge code does not import (see lib/edge-bundle.ts)."

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: EDGE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.map((name) => ({ name, message: EDGE_MESSAGE })),
          patterns: [{ group: ["node:*"], message: EDGE_MESSAGE }],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["Buffer", "__dirname", "__filename", "require", "setImmediate"].map((name) => ({ name, message: EDGE_MESSAGE })),
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "contracts/**",
    "scripts/**",
  ]),
])

export default eslintConfig
