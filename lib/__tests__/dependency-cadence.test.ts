/**
 * Spike 608 (#472, phase-175) — Dependency-update cadence automation with
 * grouped Soroban and Stellar updates.
 *
 * NOTE: Written as part of the spike implementation (not executed).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_SOROBAN_ABI_VERSION,
  CANONICAL_WASM_TARGET,
  auditManifestAlignment,
  evaluateWasmBytecodeDiffGate,
  verifyStellarSdkSorobanEncodingParity,
  type PackageManifestLike,
} from "@/lib/dependency-cadence";
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters";

describe("dependency-update cadence (Spike 608 / phase-175)", () => {
  beforeEach(() => {
    resetSecurityCounters();
  });

  it("verifies repository root and scripts/ manifests have zero SDK or WASM target skew", () => {
    const rootPkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as PackageManifestLike;
    const scriptsPkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "scripts", "package.json"), "utf8"),
    ) as PackageManifestLike;

    const report = auditManifestAlignment({
      rootPkg,
      scriptsPkg,
      cargoCrates: [
        {
          crateName: "phase-protocol",
          sorobanSdkVersion: "22.0.0",
          sorobanTokenSdkVersion: "22.0.0",
          wasmTarget: CANONICAL_WASM_TARGET,
        },
        {
          crateName: "mock-token",
          sorobanSdkVersion: "22.0.0",
          wasmTarget: CANONICAL_WASM_TARGET,
        },
      ],
      transpilePackages: ["@creit.tech/stellar-wallets-kit"],
    });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.wasmTargetConsistent).toBe(true);
    expect(report.sorobanMajorConsistent).toBe(true);
    expect(getSecurityCounter("dep_cadence_audit_passed")).toBe(1);
  });

  it("flags @stellar/stellar-sdk major skew, wasm32v1-none target skew, and bonded pair drift", () => {
    const report = auditManifestAlignment({
      rootPkg: {
        packageManager: "yarn@1.22.22",
        dependencies: {
          "@stellar/stellar-sdk": "^15.0.1",
          next: "16.2.2",
          react: "19.2.0",
          "react-dom": "19.1.0",
        },
        overrides: {
          next: "16.1.0",
        },
        devDependencies: {
          vitest: "^3.2.7",
          "@vitest/coverage-v8": "^2.0.0",
        },
      },
      scriptsPkg: {
        dependencies: {
          "@stellar/stellar-sdk": "^12.0.0",
        },
        scripts: {
          "build:phase": "cargo build --target wasm32v1-none --release",
          "optimize:phase": "stellar contract optimize --wasm target/wasm32v1-none/release/phase.wasm",
        },
      },
      cargoCrates: [
        {
          crateName: "phase-protocol",
          sorobanSdkVersion: "21.0.0",
          sorobanTokenSdkVersion: "22.0.0",
        },
      ],
      transpilePackages: [],
    });

    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("STELLAR_SDK_MAJOR_SKEW");
    expect(codes).toContain("NEXT_OVERRIDE_DRIFT");
    expect(codes).toContain("REACT_DOM_BOND_DRIFT");
    expect(codes).toContain("VITEST_COVERAGE_DRIFT");
    expect(codes).toContain("PACKAGE_MANAGER_MISMATCH");
    expect(codes).toContain("WASM_TARGET_SKEW");
    expect(codes).toContain("SOROBAN_SDK_DRIFT");
    expect(codes).toContain("TRANSPILE_WALLET_KIT_MISSING");
    expect(getSecurityCounter("dep_cadence_skew_detected")).toBe(1);
  });

  it("verifies Stellar SDK v15 Soroban mint & transfer XDR encoding parity", () => {
    const probe = verifyStellarSdkSorobanEncodingParity();
    expect(probe.ok).toBe(true);
    expect(probe.mintXdrLength).toBeGreaterThan(64);
    expect(probe.transferXdrLength).toBeGreaterThan(64);
    expect(probe.sorobanAbiVersion).toBe(CANONICAL_SOROBAN_ABI_VERSION);
    expect(getSecurityCounter("dep_sdk_parity_verified")).toBe(1);
  });

  it("enforces WASM bytecode-diff and ABI version gate unless staging dry-run passed", () => {
    const same = evaluateWasmBytecodeDiffGate({
      crateName: "phase-protocol",
      baselineWasm: "wasm-bytes-v1",
      candidateWasm: "wasm-bytes-v1",
      sorobanAbiVersion: CANONICAL_SOROBAN_ABI_VERSION,
    });
    expect(same.allowed).toBe(true);
    expect(same.reason).toBe("identical_bytecode");

    const blocked = evaluateWasmBytecodeDiffGate({
      crateName: "phase-protocol",
      baselineWasm: "wasm-bytes-v1",
      candidateWasm: "wasm-bytes-v2",
      sorobanAbiVersion: CANONICAL_SOROBAN_ABI_VERSION,
      stagingDryRunPassed: false,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("blocked_missing_staging_dry_run");

    const approved = evaluateWasmBytecodeDiffGate({
      crateName: "phase-protocol",
      baselineWasm: "wasm-bytes-v1",
      candidateWasm: "wasm-bytes-v2",
      sorobanAbiVersion: CANONICAL_SOROBAN_ABI_VERSION,
      stagingDryRunPassed: true,
    });
    expect(approved.allowed).toBe(true);
    expect(approved.reason).toBe("changed_with_staging_dry_run");

    const abiMismatch = evaluateWasmBytecodeDiffGate({
      crateName: "mock-token",
      baselineWasm: "wasm-bytes-v1",
      candidateWasm: "wasm-bytes-v1",
      sorobanAbiVersion: 20_000,
    });
    expect(abiMismatch.allowed).toBe(false);
    expect(abiMismatch.reason).toBe("blocked_abi_mismatch");
  });
});
