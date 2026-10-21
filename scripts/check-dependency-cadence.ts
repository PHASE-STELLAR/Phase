/**
 * Spike 608 (#472, phase-175): CLI gate for dependency-update cadence,
 * root vs scripts/@stellar/stellar-sdk parity, and WASM target alignment.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CANONICAL_WASM_TARGET,
  auditManifestAlignment,
  verifyStellarSdkSorobanEncodingParity,
  type PackageManifestLike,
} from "../lib/dependency-cadence";

const rootDir = process.cwd();
const rootPkg = JSON.parse(
  readFileSync(path.join(rootDir, "package.json"), "utf8"),
) as PackageManifestLike;
const scriptsPkg = JSON.parse(
  readFileSync(path.join(rootDir, "scripts", "package.json"), "utf8"),
) as PackageManifestLike;

const phaseCargo = readFileSync(
  path.join(rootDir, "contracts", "phase-protocol", "Cargo.toml"),
  "utf8",
);
const tokenCargo = readFileSync(
  path.join(rootDir, "contracts", "mock-token", "Cargo.toml"),
  "utf8",
);

function extractCargoDepVersion(toml: string, dep: string): string {
  const m = new RegExp(`${dep}\\s*=\\s*"([^"]+)"`).exec(toml);
  return m?.[1] ?? "0.0.0";
}

const alignment = auditManifestAlignment({
  rootPkg,
  scriptsPkg,
  cargoCrates: [
    {
      crateName: "phase-protocol",
      sorobanSdkVersion: extractCargoDepVersion(phaseCargo, "soroban-sdk"),
      sorobanTokenSdkVersion: extractCargoDepVersion(phaseCargo, "soroban-token-sdk"),
      wasmTarget: CANONICAL_WASM_TARGET,
    },
    {
      crateName: "mock-token",
      sorobanSdkVersion: extractCargoDepVersion(tokenCargo, "soroban-sdk"),
      wasmTarget: CANONICAL_WASM_TARGET,
    },
  ],
  transpilePackages: ["@creit.tech/stellar-wallets-kit"],
});

const sdkParity = verifyStellarSdkSorobanEncodingParity();

console.log(
  JSON.stringify({
    event: "dependency_cadence_audit",
    ok: alignment.ok && sdkParity.ok,
    alignment,
    sdkParity,
  }),
);

if (!alignment.ok || !sdkParity.ok) {
  process.exit(1);
}
