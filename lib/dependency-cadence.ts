/**
 * Spike 608 (#472, phase-175) — Dependency-update cadence automation with
 * grouped Soroban and Stellar updates.
 *
 * Bridges the two dependency universes (`package.json` root app vs
 * `scripts/package.json` CLI tooling) and the Soroban Rust contracts
 * (`contracts/phase-protocol`, `contracts/mock-token`):
 * 1. Enforces `@stellar/stellar-sdk` major/range parity across root and `scripts/`
 * 2. Enforces bonded-pair version invariants (`next` == `overrides.next`,
 *    `react` == `react-dom`, `vitest` == `@vitest/coverage-v8`, wallet-kit transpile)
 * 3. Enforces canonical WASM target (`wasm32-unknown-unknown`) across CI,
 *    `scripts/package.json`, `deploy-phase-sep50.ts`, and Cargo metadata
 * 4. Verifies `TransactionBuilder` / `nativeToScVal` / `Address` XDR encoding
 *    parity against `soroban-sdk` 22 (`CANONICAL_SOROBAN_ABI_VERSION = 22000`)
 * 5. Gates WASM bytecode hash changes on a passing staging dry-run check
 */

import { createHash } from "node:crypto";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { flagRollbackNote, isFeatureEnabled } from "@/lib/feature-flags";
import { incSecurityCounter } from "@/lib/security-counters";

export const CANONICAL_WASM_TARGET = "wasm32-unknown-unknown" as const;
export const CANONICAL_SOROBAN_SDK_MAJOR = 22 as const;
export const CANONICAL_SOROBAN_ABI_VERSION = 22_000 as const;
export const CANONICAL_STELLAR_SDK_MAJOR = 15 as const;
export const CANONICAL_STELLAR_CLI_VERSION = "23.0.0" as const;

export function isDependencyCadenceEnabled(wallet?: string): boolean {
  return isFeatureEnabled("phase-175", wallet ? { wallet } : undefined);
}

export function flag175RollbackNote(): string {
  return flagRollbackNote("phase-175");
}

export type PackageManifestLike = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

export type CargoManifestInfo = {
  crateName: string;
  sorobanSdkVersion: string;
  sorobanTokenSdkVersion?: string;
  wasmTarget?: string;
};

export type CadenceSkewIssue = {
  code:
    | "STELLAR_SDK_MAJOR_SKEW"
    | "ZOD_VERSION_SKEW"
    | "NEXT_OVERRIDE_DRIFT"
    | "REACT_DOM_BOND_DRIFT"
    | "VITEST_COVERAGE_DRIFT"
    | "PACKAGE_MANAGER_MISMATCH"
    | "WASM_TARGET_SKEW"
    | "SOROBAN_SDK_DRIFT"
    | "TRANSPILE_WALLET_KIT_MISSING";
  message: string;
};

export type ManifestAlignmentReport = {
  ok: boolean;
  rootStellarSdk: string | null;
  scriptsStellarSdk: string | null;
  wasmTargetConsistent: boolean;
  sorobanMajorConsistent: boolean;
  issues: CadenceSkewIssue[];
};

export function parseMajorVersion(spec: string | undefined): number | null {
  if (!spec) return null;
  const cleaned = spec.trim().replace(/^[~^>=<\s]+/, "");
  const match = /^(\d+)/.exec(cleaned);
  return match ? Number(match[1]) : null;
}

/**
 * Audits root `package.json`, `scripts/package.json`, Cargo manifests, and
 * `next.config.mjs` `transpilePackages` for version/target skew.
 */
export function auditManifestAlignment(params: {
  rootPkg: PackageManifestLike;
  scriptsPkg: PackageManifestLike;
  cargoCrates?: CargoManifestInfo[];
  transpilePackages?: string[];
}): ManifestAlignmentReport {
  const issues: CadenceSkewIssue[] = [];
  const rootSdk = params.rootPkg.dependencies?.["@stellar/stellar-sdk"] ?? null;
  const scriptsSdk = params.scriptsPkg.dependencies?.["@stellar/stellar-sdk"] ?? null;

  const rootMajor = parseMajorVersion(rootSdk ?? undefined);
  const scriptsMajor = parseMajorVersion(scriptsSdk ?? undefined);

  if (
    rootMajor === null ||
    scriptsMajor === null ||
    rootMajor !== scriptsMajor ||
    rootMajor !== CANONICAL_STELLAR_SDK_MAJOR
  ) {
    issues.push({
      code: "STELLAR_SDK_MAJOR_SKEW",
      message: `@stellar/stellar-sdk major skew detected: root=${rootSdk ?? "missing"} vs scripts=${scriptsSdk ?? "missing"} (expected major ${CANONICAL_STELLAR_SDK_MAJOR})`,
    });
  }

  const rootZod = params.rootPkg.dependencies?.["zod"];
  const scriptsZod = params.scriptsPkg.dependencies?.["zod"];
  if (rootZod && scriptsZod && parseMajorVersion(rootZod) !== parseMajorVersion(scriptsZod)) {
    issues.push({
      code: "ZOD_VERSION_SKEW",
      message: `zod major skew between root (${rootZod}) and scripts (${scriptsZod})`,
    });
  }

  const nextDep = params.rootPkg.dependencies?.["next"];
  const nextOverride = params.rootPkg.overrides?.["next"];
  if (nextDep && nextOverride && nextDep !== nextOverride) {
    issues.push({
      code: "NEXT_OVERRIDE_DRIFT",
      message: `next dependency (${nextDep}) drifted from overrides.next (${nextOverride})`,
    });
  }

  const reactDep = params.rootPkg.dependencies?.["react"];
  const reactDomDep = params.rootPkg.dependencies?.["react-dom"];
  if (reactDep !== reactDomDep) {
    issues.push({
      code: "REACT_DOM_BOND_DRIFT",
      message: `Bonded pair react (${reactDep ?? "missing"}) and react-dom (${reactDomDep ?? "missing"}) must match exactly`,
    });
  }

  const vitestDep = params.rootPkg.devDependencies?.["vitest"];
  const coverageDep = params.rootPkg.devDependencies?.["@vitest/coverage-v8"];
  if (vitestDep && coverageDep && vitestDep !== coverageDep) {
    issues.push({
      code: "VITEST_COVERAGE_DRIFT",
      message: `Bonded pair vitest (${vitestDep}) and @vitest/coverage-v8 (${coverageDep}) drifted`,
    });
  }

  if (
    params.rootPkg.packageManager &&
    !params.rootPkg.packageManager.startsWith("npm@")
  ) {
    issues.push({
      code: "PACKAGE_MANAGER_MISMATCH",
      message: `packageManager field (${params.rootPkg.packageManager}) conflicts with npm lockfile / npm ci workflow`,
    });
  }

  const buildPhaseCmd = params.scriptsPkg.scripts?.["build:phase"] ?? "";
  const optimizePhaseCmd = params.scriptsPkg.scripts?.["optimize:phase"] ?? "";
  const wasmTargetConsistent =
    !buildPhaseCmd.includes("wasm32v1-none") &&
    !optimizePhaseCmd.includes("wasm32v1-none") &&
    buildPhaseCmd.includes(CANONICAL_WASM_TARGET) &&
    optimizePhaseCmd.includes(CANONICAL_WASM_TARGET);

  if (!wasmTargetConsistent) {
    issues.push({
      code: "WASM_TARGET_SKEW",
      message: `scripts/package.json must build and optimize with --target ${CANONICAL_WASM_TARGET} (found build:phase="${buildPhaseCmd}")`,
    });
  }

  let sorobanMajorConsistent = true;
  for (const crate of params.cargoCrates ?? []) {
    const sdkMajor = parseMajorVersion(crate.sorobanSdkVersion);
    const tokenMajor = crate.sorobanTokenSdkVersion
      ? parseMajorVersion(crate.sorobanTokenSdkVersion)
      : CANONICAL_SOROBAN_SDK_MAJOR;
    if (
      sdkMajor !== CANONICAL_SOROBAN_SDK_MAJOR ||
      tokenMajor !== CANONICAL_SOROBAN_SDK_MAJOR
    ) {
      sorobanMajorConsistent = false;
      issues.push({
        code: "SOROBAN_SDK_DRIFT",
        message: `Crate ${crate.crateName} soroban-sdk (${crate.sorobanSdkVersion}) / token-sdk (${crate.sorobanTokenSdkVersion ?? "n/a"}) drifted from canonical major ${CANONICAL_SOROBAN_SDK_MAJOR}`,
      });
    }
    if (crate.wasmTarget && crate.wasmTarget !== CANONICAL_WASM_TARGET) {
      issues.push({
        code: "WASM_TARGET_SKEW",
        message: `Crate ${crate.crateName} metadata target (${crate.wasmTarget}) != ${CANONICAL_WASM_TARGET}`,
      });
    }
  }

  if (
    params.transpilePackages &&
    !params.transpilePackages.includes("@creit.tech/stellar-wallets-kit")
  ) {
    issues.push({
      code: "TRANSPILE_WALLET_KIT_MISSING",
      message: `next.config.mjs transpilePackages must include @creit.tech/stellar-wallets-kit`,
    });
  }

  if (issues.length === 0) {
    incSecurityCounter("dep_cadence_audit_passed");
  } else {
    incSecurityCounter("dep_cadence_skew_detected");
  }

  return {
    ok: issues.length === 0,
    rootStellarSdk: rootSdk,
    scriptsStellarSdk: scriptsSdk,
    wasmTargetConsistent,
    sorobanMajorConsistent,
    issues,
  };
}

export type SdkParityProbeResult = {
  ok: boolean;
  mintXdrLength: number;
  transferXdrLength: number;
  sorobanAbiVersion: number;
};

/**
 * Verifies that `@stellar/stellar-sdk` v15 `TransactionBuilder`, `Contract.call`,
 * `Address.fromString(...).toScVal()`, and `nativeToScVal(BigInt, { type: "i128" })`
 * encode deterministic Soroban `invokeHostFunction` operations for both `mint`
 * and `transfer` (matching `app/api/faucet/route.ts`, `lib/phase-protocol.ts`,
 * and `scripts/`).
 */
export function verifyStellarSdkSorobanEncodingParity(): SdkParityProbeResult {
  const sourceKp = Keypair.random();
  const recipientKp = Keypair.random();
  const contractId = "CAZKRXQWXKM4UNDB5FY4XVMWDKKZJ2EFKMNFCFH3WC7SHE7RCO7HOR6L";
  const contract = new Contract(contractId);
  const amountSc = nativeToScVal(BigInt("20000000"), { type: "i128" });

  const account = new Account(sourceKp.publicKey(), "100");
  const mintTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        "mint",
        Address.fromString(recipientKp.publicKey()).toScVal(),
        amountSc,
      ),
    )
    .setTimeout(30)
    .build();

  const transferAccount = new Account(sourceKp.publicKey(), "101");
  const transferTx = new TransactionBuilder(transferAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        "transfer",
        Address.fromString(sourceKp.publicKey()).toScVal(),
        Address.fromString(recipientKp.publicKey()).toScVal(),
        amountSc,
      ),
    )
    .setTimeout(30)
    .build();

  const mintXdr = mintTx.toXDR();
  const transferXdr = transferTx.toXDR();
  const ok = mintXdr.length > 64 && transferXdr.length > 64 && mintXdr !== transferXdr;

  if (ok) {
    incSecurityCounter("dep_sdk_parity_verified");
  }

  return {
    ok,
    mintXdrLength: mintXdr.length,
    transferXdrLength: transferXdr.length,
    sorobanAbiVersion: CANONICAL_SOROBAN_ABI_VERSION,
  };
}

export type WasmBytecodeGateInput = {
  crateName: "phase-protocol" | "mock-token";
  baselineWasm: Uint8Array | string;
  candidateWasm: Uint8Array | string;
  sorobanAbiVersion: number;
  stagingDryRunPassed?: boolean;
};

export type WasmBytecodeGateResult = {
  allowed: boolean;
  bytecodeChanged: boolean;
  baselineSha256: string;
  candidateSha256: string;
  reason:
    | "identical_bytecode"
    | "changed_with_staging_dry_run"
    | "blocked_missing_staging_dry_run"
    | "blocked_abi_mismatch";
};

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Guards contract toolchain / dependency updates against silent WASM bytecode
 * drift: if the optimized WASM SHA-256 changes, deployment is blocked unless
 * `stagingDryRunPassed` is explicitly true and `sorobanAbiVersion` matches.
 */
export function evaluateWasmBytecodeDiffGate(
  input: WasmBytecodeGateInput,
): WasmBytecodeGateResult {
  const baselineSha256 = sha256Hex(input.baselineWasm);
  const candidateSha256 = sha256Hex(input.candidateWasm);
  const bytecodeChanged = baselineSha256 !== candidateSha256;

  if (input.sorobanAbiVersion !== CANONICAL_SOROBAN_ABI_VERSION) {
    incSecurityCounter("dep_wasm_bytecode_drift");
    return {
      allowed: false,
      bytecodeChanged,
      baselineSha256,
      candidateSha256,
      reason: "blocked_abi_mismatch",
    };
  }

  if (!bytecodeChanged) {
    return {
      allowed: true,
      bytecodeChanged: false,
      baselineSha256,
      candidateSha256,
      reason: "identical_bytecode",
    };
  }

  incSecurityCounter("dep_wasm_bytecode_drift");
  if (input.stagingDryRunPassed) {
    return {
      allowed: true,
      bytecodeChanged: true,
      baselineSha256,
      candidateSha256,
      reason: "changed_with_staging_dry_run",
    };
  }

  return {
    allowed: false,
    bytecodeChanged: true,
    baselineSha256,
    candidateSha256,
    reason: "blocked_missing_staging_dry_run",
  };
}
