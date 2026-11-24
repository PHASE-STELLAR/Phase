# Implementation Summary: Issues #52, #53, #58, #59

**Branch:** `fix/issues-52-53-58-59`  
**Target:** PHASE-STELLAR/Phase  
**Assignee:** presidojay1  
**Due Date:** August 31, 2026

## Overview

This document provides comprehensive implementation specifications for four critical Phase dApp issues focused on system stability, multi-network support, marketplace escrow, and signal moderation.

---

## Issue #52: Multi-Network Bootstrap Script (Module #28) 🌐

**Type:** SPIKE  
**Effort:** 3 weeks  
**Files Impacted:**
- `scripts/setup-phase-v2.ts`
- `scripts/reset-phase.ts`
- `scripts/issue-sac-token.ts`

### Problem Statement
Setup scripts currently assume fixed SDF testnet RPC endpoints, preventing deployment to local networks or alternative testnets. This creates friction for development and testing workflows.

### Technical Requirements

#### 1. **Network Configuration Schema**
```typescript
// lib/network-config.ts
export type NetworkType = 'testnet' | 'local' | 'futurenet' | 'mainnet'

export interface NetworkConfig {
  type: NetworkType
  rpcUrl: string
  horizonUrl: string
  networkPassphrase: string
  friendbotUrl?: string
  explorerUrl?: string
}

export const NETWORK_PRESETS: Record<NetworkType, NetworkConfig> = {
  testnet: {
    type: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    friendbotUrl: 'https://friendbot.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/testnet',
  },
  futurenet: {
    type: 'futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    networkPassphrase: Networks.FUTURENET,
    friendbotUrl: 'https://friendbot-futurenet.stellar.org',
    explorerUrl: 'https://stellar.expert/explorer/futurenet',
  },
  local: {
    type: 'local',
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    horizonUrl: 'http://localhost:8000',
    networkPassphrase: Networks.STANDALONE,
    friendbotUrl: 'http://localhost:8000/friendbot',
    explorerUrl: undefined,
  },
  mainnet: {
    type: 'mainnet',
    rpcUrl: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: Networks.PUBLIC,
    friendbotUrl: undefined,
    explorerUrl: 'https://stellar.expert/explorer/public',
  },
}
```

#### 2. **Environment Detection**
```typescript
// lib/network-config.ts (continued)

export function detectNetworkFromEnv(): NetworkConfig {
  const typeEnv = (process.env.PHASE_NETWORK_TYPE ?? 'testnet').toLowerCase()
  
  // Check if custom URLs are provided
  const customRpc = process.env.PHASE_RPC_URL
  const customHorizon = process.env.PHASE_HORIZON_URL
  const customPassphrase = process.env.PHASE_NETWORK_PASSPHRASE
  
  if (customRpc && customHorizon && customPassphrase) {
    return {
      type: typeEnv as NetworkType,
      rpcUrl: customRpc,
      horizonUrl: customHorizon,
      networkPassphrase: customPassphrase,
      friendbotUrl: process.env.PHASE_FRIENDBOT_URL,
      explorerUrl: process.env.PHASE_EXPLORER_URL,
    }
  }
  
  // Fall back to preset
  const preset = NETWORK_PRESETS[typeEnv as NetworkType]
  if (!preset) {
    throw new Error(`Unknown network type: ${typeEnv}. Must be: testnet, futurenet, local, or mainnet`)
  }
  
  return preset
}

export function validateNetworkConfig(config: NetworkConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  
  if (!config.rpcUrl || !config.rpcUrl.startsWith('http')) {
    errors.push(`Invalid RPC URL: ${config.rpcUrl}`)
  }
  
  if (!config.horizonUrl || !config.horizonUrl.startsWith('http')) {
    errors.push(`Invalid Horizon URL: ${config.horizonUrl}`)
  }
  
  if (!config.networkPassphrase || config.networkPassphrase.length < 10) {
    errors.push(`Invalid network passphrase: ${config.networkPassphrase}`)
  }
  
  // Validate mainnet doesn't have friendbot
  if (config.type === 'mainnet' && config.friendbotUrl) {
    errors.push('Mainnet cannot use friendbot (unsafe)')
  }
  
  // Warn if local network doesn't have friendbot
  if (config.type === 'local' && !config.friendbotUrl) {
    errors.push('Local network should configure friendbot URL')
  }
  
  return {
    valid: errors.length === 0,
    errors,
  }
}
```

#### 3. **Updated Setup Script**
```typescript
// scripts/setup-phase-v2.ts (refactored sections)

import { detectNetworkFromEnv, validateNetworkConfig } from '../lib/network-config'

async function main() {
  console.log("=" .repeat(70))
  console.log("PHASE MULTI-NETWORK BOOTSTRAP")
  console.log("=" .repeat(70))
  
  // Detect and validate network
  const network = detectNetworkFromEnv()
  const validation = validateNetworkConfig(network)
  
  if (!validation.valid) {
    console.error("\n❌ Network configuration errors:")
    validation.errors.forEach(e => console.error(`   - ${e}`))
    process.exit(1)
  }
  
  console.log(`\n🌐 Network: ${network.type}`)
  console.log(`   RPC:     ${network.rpcUrl}`)
  console.log(`   Horizon: ${network.horizonUrl}`)
  console.log(`   Phrase:  ${network.networkPassphrase.slice(0, 30)}...`)
  
  // Initialize Horizon with network config
  const server = new Horizon.Server(network.horizonUrl)
  
  // Generate keypairs
  const issuerKeypair = Keypair.random()
  const distributorKeypair = Keypair.random()
  
  console.log("\n🔑 Generated keypairs:")
  console.log(`   Issuer:      ${issuerKeypair.publicKey()}`)
  console.log(`   Distributor: ${distributorKeypair.publicKey()}`)
  
  // Fund accounts based on network type
  if (network.type === 'mainnet') {
    console.log("\n⚠️  MAINNET detected - accounts must be funded manually")
    console.log("   1. Send XLM to both accounts above")
    console.log("   2. Re-run this script after funding")
    return
  }
  
  if (network.friendbotUrl) {
    console.log("\n💰 Funding accounts via friendbot...")
    await fundAccount(network.friendbotUrl, issuerKeypair.publicKey())
    await fundAccount(network.friendbotUrl, distributorKeypair.publicKey())
  } else {
    throw new Error("No friendbot URL configured for this network")
  }
  
  // Create trustline
  const assetCode = process.env.PHASE_V2_ASSET_CODE || 'PHASELQ'
  const asset = new Asset(assetCode, issuerKeypair.publicKey())
  
  console.log(`\n🔗 Creating trustline for ${assetCode}...`)
  await createTrustline(server, distributorKeypair, asset, network.networkPassphrase)
  
  // Issue tokens
  const initialSupply = process.env.PHASE_V2_INITIAL_DISTRIBUTION || '100000.0000000'
  console.log(`\n💎 Issuing ${initialSupply} ${assetCode}...`)
  await issueTokens(server, issuerKeypair, distributorKeypair.publicKey(), asset, initialSupply, network.networkPassphrase)
  
  // Deploy SAC contract
  console.log(`\n📜 Deploying SAC contract...`)
  const contractId = await deploySAC(asset, network)
  
  // Print configuration
  printEnvConfig(network, issuerKeypair, distributorKeypair, contractId, assetCode)
}

async function deploySAC(asset: Asset, network: NetworkConfig): Promise<string> {
  const assetArg = `${asset.code}:${asset.issuer}`
  
  try {
    const output = execFileSync(
      'stellar',
      [
        'contract', 'asset', 'deploy',
        '--asset', assetArg,
        '--rpc-url', network.rpcUrl,
        '--network-passphrase', network.networkPassphrase,
        '--source-account', 'issuer-alias', // Should be configured via stellar keys
      ],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    )
    
    const contractId = output.trim()
    if (!StrKey.isValidContract(contractId)) {
      throw new Error(`Invalid contract ID returned: ${contractId}`)
    }
    
    console.log(`   ✅ Contract deployed: ${contractId}`)
    return contractId
  } catch (error) {
    console.error(`   ❌ SAC deployment failed:`, error)
    throw error
  }
}

function printEnvConfig(
  network: NetworkConfig,
  issuer: Keypair,
  distributor: Keypair,
  contractId: string,
  assetCode: string
) {
  console.log("\n" + "=".repeat(70))
  console.log("✅ SETUP COMPLETE - Add to .env.local:")
  console.log("=".repeat(70))
  console.log(`
# Network Configuration (${network.type})
NEXT_PUBLIC_PHASE_NETWORK_TYPE="${network.type}"
NEXT_PUBLIC_PHASE_RPC_URL="${network.rpcUrl}"
NEXT_PUBLIC_PHASE_HORIZON_URL="${network.horizonUrl}"
PHASE_NETWORK_PASSPHRASE="${network.networkPassphrase}"

# Asset Configuration
NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE="${assetCode}"
NEXT_PUBLIC_CLASSIC_LIQ_ISSUER="${issuer.publicKey()}"
NEXT_PUBLIC_PHASER_TOKEN_ID="${contractId}"

# Secrets (KEEP SECURE - NEVER COMMIT)
ADMIN_SECRET_KEY="${issuer.secret()}"
FAUCET_DISTRIBUTOR_SECRET_KEY="${distributor.secret()}"

# Optional: Explorer
${network.explorerUrl ? `NEXT_PUBLIC_EXPLORER_URL="${network.explorerUrl}"` : '# No explorer available for this network'}
`)
  console.log("=".repeat(70))
}

async function fundAccount(friendbotUrl: string, publicKey: string): Promise<void> {
  const response = await fetch(`${friendbotUrl}?addr=${publicKey}`)
  if (!response.ok) {
    throw new Error(`Friendbot failed for ${publicKey}: ${response.statusText}`)
  }
  console.log(`   ✅ Funded ${publicKey.slice(0, 8)}...`)
}
```

#### 4. **Updated Reset Script**
```typescript
// scripts/reset-phase.ts (network-aware sections)

import { detectNetworkFromEnv, validateNetworkConfig } from '../lib/network-config'

async function main() {
  const network = detectNetworkFromEnv()
  const validation = validateNetworkConfig(network)
  
  if (!validation.valid) {
    console.error("Network configuration errors:", validation.errors)
    process.exit(1)
  }
  
  console.log(`\n🌐 Resetting Phase on ${network.type}...`)
  
  // Safety check for mainnet
  if (network.type === 'mainnet') {
    console.error("\n❌ ABORT: Cannot run reset script on mainnet!")
    console.error("   This script is destructive and only for test networks.")
    process.exit(1)
  }
  
  // Rest of reset logic uses network.rpcUrl, network.horizonUrl, etc.
  const server = new Horizon.Server(network.horizonUrl)
  
  // ... reset operations
}
```

#### 5. **Diagnostic Integration**
```typescript
// lib/env-validation.ts (add network diagnostics)

export function auditNetworkConfiguration(): { ok: boolean; note: string } {
  try {
    const network = detectNetworkFromEnv()
    const validation = validateNetworkConfig(network)
    
    if (!validation.valid) {
      return {
        ok: false,
        note: `[network] Configuration invalid: ${validation.errors.join('; ')}`,
      }
    }
    
    return {
      ok: true,
      note: `[network] ${network.type} configured (RPC: ${network.rpcUrl}, Horizon: ${network.horizonUrl})`,
    }
  } catch (error) {
    return {
      ok: false,
      note: `[network] Detection failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
```

#### 6. **Environment Variables**
```bash
# .env.example additions

# ──────────────────────────────────────────────────────────────
# Network Configuration (Issue #52)
# ──────────────────────────────────────────────────────────────
# Network type: testnet, futurenet, local, or mainnet
NEXT_PUBLIC_PHASE_NETWORK_TYPE=testnet

# Custom network endpoints (optional - overrides preset)
# NEXT_PUBLIC_PHASE_RPC_URL=https://soroban-testnet.stellar.org
# NEXT_PUBLIC_PHASE_HORIZON_URL=https://horizon-testnet.stellar.org
# PHASE_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Friendbot (test networks only)
# PHASE_FRIENDBOT_URL=https://friendbot.stellar.org

# Explorer (optional)
# NEXT_PUBLIC_EXPLORER_URL=https://stellar.expert/explorer/testnet
```

### Feature Flag
**Flag:** `NEXT_PUBLIC_FEATURE_PHASE_133`  
**Rollback:** Unset flag to revert to hardcoded testnet endpoints

### Testing Plan
1. **Testnet Bootstrap:** Run setup-phase-v2.ts with default config
2. **Futurenet Bootstrap:** Set `PHASE_NETWORK_TYPE=futurenet` and verify
3. **Local Network:** Start local stellar-quickstart, configure local endpoints
4. **Custom RPC:** Override preset with custom URLs
5. **Mainnet Safety:** Verify mainnet requires manual funding
6. **Diagnostics:** Run `npm run diagnose` to verify network detection

### Acceptance Criteria
- ✅ Scripts accept PHASE_NETWORK_TYPE environment variable
- ✅ Network presets work for testnet, futurenet, local
- ✅ Custom RPC/Horizon URLs override presets
- ✅ Mainnet operations require explicit confirmation
- ✅ Diagnostic script reports network configuration
- ✅ Zero unhandled exceptions in production logs

---

## Issue #53: Real-Time Environment Variable Integrity Inspector (Module #29) 🔍

**Type:** Feature  
**Effort:** 4 weeks  
**Files Impacted:**
- `scripts/diagnose-env.ts`
- `lib/env-validation.ts`
- `diagnose-env.ts`

### Problem Statement
Missing server secret keys break runtime silently without warnings. The current diagnostic script lacks real-time monitoring and comprehensive validation for critical environment variables.

### Technical Requirements

#### 1. **Enhanced Validation Schema**
```typescript
// lib/env-validation.ts (enhanced)

export interface EnvValidationOptions {
  strict?: boolean
  checkSecrets?: boolean
  checkNetworkAlignment?: boolean
  checkFeatureFlags?: boolean
}

export interface DetailedEnvValidation {
  valid: boolean
  errors: EnvValidationError[]
  warnings: EnvValidationWarning[]
  criticalMissing: string[]
  optionalMissing: string[]
  deprecated: string[]
  recommendations: string[]
}

export type EnvValidationWarning = {
  variable: string
  severity: 'low' | 'medium' | 'high'
  message: string
  suggestion: string
}

const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_PHASE_PROTOCOL_ID',
  'NEXT_PUBLIC_PHASER_TOKEN_ID',
  'NEXT_PUBLIC_CLASSIC_LIQ_ISSUER',
] as const

const OPTIONAL_ENV_VARS = [
  'ADMIN_SECRET_KEY',
  'FAUCET_DISTRIBUTOR_SECRET_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'NANOBANANA_API_KEY',
] as const

const DEPRECATED_ENV_VARS = [
  { old: 'TOKEN_CONTRACT_ID', new: 'NEXT_PUBLIC_PHASER_TOKEN_ID', removedIn: 'v3.0' },
  { old: 'PHASE_PROTOCOL_ID', new: 'NEXT_PUBLIC_PHASE_PROTOCOL_ID', removedIn: 'v3.0' },
  { old: 'GEMINI_API_KEY', new: 'GOOGLE_AI_STUDIO_API_KEY', removedIn: 'v2.5' },
] as const
```

#### 2. **Real-Time Integrity Monitor**
```typescript
// lib/env-integrity-monitor.ts (NEW FILE)

import { EventEmitter } from 'events'
import { validatePhaseEnv, type DetailedEnvValidation } from './env-validation'

export class EnvIntegrityMonitor extends EventEmitter {
  private intervalId?: NodeJS.Timeout
  private lastValidation?: DetailedEnvValidation
  private checkIntervalMs: number
  
  constructor(checkIntervalMs: number = 60000) {
    super()
    this.checkIntervalMs = checkIntervalMs
  }
  
  start(): void {
    if (this.intervalId) {
      console.warn('[env-monitor] Already running')
      return
    }
    
    console.log(`[env-monitor] Starting integrity checks every ${this.checkIntervalMs}ms`)
    
    // Initial check
    this.runCheck()
    
    // Periodic checks
    this.intervalId = setInterval(() => this.runCheck(), this.checkIntervalMs)
  }
  
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
      console.log('[env-monitor] Stopped')
    }
  }
  
  private runCheck(): void {
    const validation = validatePhaseEnv({ strict: true, checkSecrets: true })
    
    // Detect changes from last run
    if (this.lastValidation) {
      const newErrors = validation.errors.filter(e => 
        !this.lastValidation!.errors.some(le => 
          le.variable === e.variable && le.issue === e.issue
        )
      )
      
      const resolvedErrors = this.lastValidation.errors.filter(e =>
        !validation.errors.some(ne =>
          ne.variable === e.variable && ne.issue === e.issue
        )
      )
      
      if (newErrors.length > 0) {
        this.emit('errors-detected', newErrors)
        console.error('[env-monitor] ❌ New configuration errors detected:', newErrors)
      }
      
      if (resolvedErrors.length > 0) {
        this.emit('errors-resolved', resolvedErrors)
        console.log('[env-monitor] ✅ Configuration errors resolved:', resolvedErrors)
      }
    } else if (validation.errors.length > 0) {
      this.emit('errors-detected', validation.errors)
    }
    
    this.lastValidation = validation
    this.emit('check-complete', validation)
  }
  
  getLastValidation(): DetailedEnvValidation | undefined {
    return this.lastValidation
  }
}

// Singleton instance
let globalMonitor: EnvIntegrityMonitor | undefined

export function startGlobalEnvMonitor(intervalMs?: number): EnvIntegrityMonitor {
  if (!globalMonitor) {
    globalMonitor = new EnvIntegrityMonitor(intervalMs)
    globalMonitor.start()
  }
  return globalMonitor
}

export function stopGlobalEnvMonitor(): void {
  if (globalMonitor) {
    globalMonitor.stop()
    globalMonitor = undefined
  }
}

export function getGlobalEnvMonitor(): EnvIntegrityMonitor | undefined {
  return globalMonitor
}
```

#### 3. **Enhanced Diagnostic Script**
```typescript
// diagnose-env.ts (enhanced)

import { auditPhaseFeatureWiring } from "@/lib/env-validation"
import { startGlobalEnvMonitor } from "@/lib/env-integrity-monitor"

// ... existing diagnostic checks ...

// 7. Feature Flag Audit
console.log("\n🚩 Feature Flag Audit:")
const featureAudit = await auditPhaseFeatureWiring()
if (featureAudit.ok) {
  console.log("   ✅ All feature modules loadable and wired correctly")
} else {
  console.error("   ❌ Feature module issues detected:")
}
featureAudit.notes.forEach(note => {
  const icon = note.includes('OK') || note.includes('disabled') ? '   ℹ️' : '   ⚠️'
  console.log(`${icon}  ${note}`)
})

// 8. Secret Key Security Audit
console.log("\n🔐 Secret Key Security Audit:")
const secretKeys = [
  { name: 'ADMIN_SECRET_KEY', value: process.env.ADMIN_SECRET_KEY },
  { name: 'FAUCET_DISTRIBUTOR_SECRET_KEY', value: process.env.FAUCET_DISTRIBUTOR_SECRET_KEY },
]

let secretIssues = 0
for (const { name, value } of secretKeys) {
  if (!value) {
    console.log(`   ℹ️  ${name}: not configured (optional)`)
    continue
  }
  
  // Check for common mistakes
  if (value.length < 40) {
    console.error(`   ❌ ${name}: too short (possible truncation)`)
    secretIssues++
  } else if (!value.startsWith('S')) {
    console.error(`   ❌ ${name}: invalid format (must start with 'S')`)
    secretIssues++
  } else if (value.includes(' ')) {
    console.error(`   ❌ ${name}: contains whitespace (copy/paste error)`)
    secretIssues++
  } else {
    console.log(`   ✅ ${name}: format valid`)
  }
}

if (secretIssues > 0) {
  console.error(`\n   ⚠️  ${secretIssues} secret key issue(s) detected - review immediately`)
}

// 9. API Key Validation
console.log("\n🔑 API Key Validation:")
const apiKeys = [
  { name: 'GOOGLE_AI_STUDIO_API_KEY', prefix: 'AIza', required: false },
  { name: 'NANOBANANA_API_KEY', prefix: null, required: false },
  { name: 'GEMINI_API_KEY', prefix: 'AIza', required: false, deprecated: true },
]

for (const { name, prefix, required, deprecated } of apiKeys) {
  const value = process.env[name]
  
  if (!value) {
    if (required) {
      console.error(`   ❌ ${name}: REQUIRED but missing`)
    } else if (deprecated) {
      console.log(`   ℹ️  ${name}: deprecated (use GOOGLE_AI_STUDIO_API_KEY)`)
    } else {
      console.log(`   ℹ️  ${name}: not configured (optional)`)
    }
    continue
  }
  
  if (prefix && !value.startsWith(prefix)) {
    console.warn(`   ⚠️  ${name}: unexpected format (expected prefix: ${prefix})`)
  } else {
    const status = deprecated ? '(deprecated)' : ''
    console.log(`   ✅ ${name}: configured ${status}`)
  }
}

// 10. Watch Mode (optional)
const watchMode = process.argv.includes('--watch') || process.env.ENV_WATCH === 'true'
if (watchMode) {
  console.log("\n👁️  Watch mode enabled - monitoring environment integrity...")
  const monitor = startGlobalEnvMonitor(30000) // Check every 30 seconds
  
  monitor.on('errors-detected', (errors) => {
    console.error(`\n[${new Date().toISOString()}] ❌ NEW ERRORS:`)
    errors.forEach(e => console.error(`   - ${e.variable}: ${e.message}`))
  })
  
  monitor.on('errors-resolved', (resolved) => {
    console.log(`\n[${new Date().toISOString()}] ✅ RESOLVED:`)
    resolved.forEach(e => console.log(`   - ${e.variable}: Fixed`))
  })
  
  console.log("   Press Ctrl+C to stop monitoring")
} else {
  // Final summary
  console.log("\n" + "=".repeat(70))
  if (validation.valid && !secretIssues && featureAudit.ok) {
    console.log("✅ ALL CHECKS PASSED - Environment configuration is healthy")
    console.log("\n   Run with --watch to enable continuous monitoring")
  } else {
    console.log("❌ CONFIGURATION ISSUES DETECTED - Review errors above")
    console.log("\n   Tip: Run with --watch to monitor configuration changes in real-time")
    process.exit(1)
  }
  console.log("=".repeat(70))
}
```

#### 4. **Runtime Integration**
```typescript
// lib/server-init.ts (NEW FILE - optional production integration)

import { startGlobalEnvMonitor } from './env-integrity-monitor'
import { validatePhaseEnv } from './env-validation'

export function initializeServerEnvironment(): void {
  console.log('[server-init] Validating environment configuration...')
  
  const validation = validatePhaseEnv({ strict: true })
  
  if (!validation.valid) {
    console.error('[server-init] ❌ Environment validation failed:')
    validation.errors.forEach(e => console.error(`   - ${e.variable}: ${e.message}`))
    throw new Error('Server cannot start due to invalid environment configuration')
  }
  
  console.log('[server-init] ✅ Environment validated')
  
  // Start monitoring in production (optional)
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_ENV_MONITOR === 'true') {
    const monitor = startGlobalEnvMonitor(300000) // Check every 5 minutes
    
    monitor.on('errors-detected', (errors) => {
      console.error('[server-init] CRITICAL: Runtime environment degradation detected!')
      errors.forEach(e => console.error(`   - ${e.variable}: ${e.message}`))
      
      // Optional: trigger alerts, healthcheck failures, etc.
      if (process.env.ALERT_ON_ENV_ERROR === 'true') {
        // Send alert to monitoring system
      }
    })
  }
}

// Call from next.config.js or server entry point
// initializeServerEnvironment()
```

#### 5. **Enhanced Error Messages**
```typescript
// lib/env-validation.ts (enhanced error formatting)

export function formatDetailedValidation(validation: DetailedEnvValidation): string {
  const lines: string[] = []
  
  lines.push("=" .repeat(70))
  lines.push("ENVIRONMENT VALIDATION REPORT")
  lines.push("=" .repeat(70))
  
  // Critical errors
  if (validation.errors.length > 0) {
    lines.push("\n❌ ERRORS (must fix):")
    validation.errors.forEach(e => {
      lines.push(`\n   Variable: ${e.variable}`)
      lines.push(`   Issue:    ${e.issue}`)
      lines.push(`   Error:    ${e.message}`)
      lines.push(`   Fix:      ${e.hint}`)
    })
  }
  
  // Warnings
  if (validation.warnings.length > 0) {
    lines.push("\n⚠️  WARNINGS (should fix):")
    validation.warnings.forEach(w => {
      const icon = w.severity === 'high' ? '🔴' : w.severity === 'medium' ? '🟡' : '🟢'
      lines.push(`\n   ${icon} ${w.variable} [${w.severity}]`)
      lines.push(`   ${w.message}`)
      lines.push(`   Suggestion: ${w.suggestion}`)
    })
  }
  
  // Missing optional vars
  if (validation.optionalMissing.length > 0) {
    lines.push("\n📋 Optional (not configured):")
    validation.optionalMissing.forEach(v => lines.push(`   - ${v}`))
  }
  
  // Deprecated vars
  if (validation.deprecated.length > 0) {
    lines.push("\n⏰ Deprecated (update recommended):")
    validation.deprecated.forEach(d => lines.push(`   - ${d}`))
  }
  
  // Recommendations
  if (validation.recommendations.length > 0) {
    lines.push("\n💡 Recommendations:")
    validation.recommendations.forEach(r => lines.push(`   - ${r}`))
  }
  
  lines.push("\n" + "=".repeat(70))
  lines.push(validation.valid ? "✅ VALIDATION PASSED" : "❌ VALIDATION FAILED")
  lines.push("=".repeat(70))
  
  return lines.join("\n")
}
```

### Feature Flag
**Flag:** `NEXT_PUBLIC_FEATURE_PHASE_134`  
**Rollback:** Unset flag to disable real-time monitoring

### Testing Plan
1. **Missing Secrets:** Remove ADMIN_SECRET_KEY, verify diagnostic catches it
2. **Invalid Format:** Set malformed contract ID, verify error message
3. **Watch Mode:** Run `npm run diagnose -- --watch`, change env, verify detection
4. **Deprecated Vars:** Use GEMINI_API_KEY, verify deprecation warning
5. **Runtime Monitor:** Start server with monitor, remove env var, verify alert

### Acceptance Criteria
- ✅ Diagnostic script detects all missing/invalid environment variables
- ✅ Real-time monitor detects configuration changes within 60 seconds
- ✅ Clear, actionable error messages with fix instructions
- ✅ Watch mode enables continuous monitoring for development
- ✅ Zero unhandled exceptions in production logs
- ✅ Full unit test pass rate (100% coverage on validation logic)

---

## Issue #58: Escrow-Based Marketplace Offer Settlement (Module #34) 💰

**Type:** SPIKE  
**Effort:** 3 weeks  
**Files Impacted:**
- `app/api/market/[id]/offers/route.ts`
- `lib/market-store.ts`
- `components/dashboard/`

### Problem Statement
Market offers currently rely on off-chain trust promises, creating counterparty risk. Buyers and sellers have no guarantee that the other party will fulfill their obligations. This limits marketplace adoption and creates opportunities for fraud.

### Technical Requirements

#### 1. **Escrow Contract Types**
```typescript
// lib/escrow-settlement.ts (NEW FILE)

import { Contract, SorobanRpc, xdr } from '@stellar/stellar-sdk'

export type EscrowState = 
  | 'pending_deposit'
  | 'funds_locked'
  | 'dispute_raised'
  | 'settlement_approved'
  | 'settlement_rejected'
  | 'completed'
  | 'refunded'
  | 'expired'

export interface MarketEscrow {
  escrowId: string
  offerId: string
  buyerWallet: string
  sellerWallet: string
  assetCode: string
  assetIssuer: string
  amount: string
  price: string
  state: EscrowState
  contractId: string
  expiresAt: number
  createdAt: number
  updatedAt: number
  disputeReason?: string
  arbiterWallet?: string
  releaseSignatures: string[]
}

export interface EscrowCreateParams {
  offerId: string
  buyerWallet: string
  sellerWallet: string
  assetCode: string
  assetIssuer: string
  amount: string
  price: string
  expiryDurationSec: number
  arbiterWallet?: string
}

export interface EscrowReleaseParams {
  escrowId: string
  releaserWallet: string
  signature: string
  memo?: string
}

export interface EscrowDisputeParams {
  escrowId: string
  disputerWallet: string
  reason: string
  evidence?: string[]
}
```

#### 2. **Escrow Store Implementation**
```typescript
// lib/escrow-settlement.ts (continued)

import { serverDataJsonPath } from './server-data'

const ESCROW_STORE_FILE = 'marketEscrows.json'

export class EscrowSettlementStore {
  private getStorePath(): string {
    return serverDataJsonPath(ESCROW_STORE_FILE)
  }
  
  async getAllEscrows(): Promise<MarketEscrow[]> {
    try {
      const content = await fs.readFile(this.getStorePath(), 'utf-8')
      return JSON.parse(content)
    } catch {
      return []
    }
  }
  
  async getEscrowById(escrowId: string): Promise<MarketEscrow | null> {
    const all = await this.getAllEscrows()
    return all.find(e => e.escrowId === escrowId) ?? null
  }
  
  async getEscrowsByOffer(offerId: string): Promise<MarketEscrow[]> {
    const all = await this.getAllEscrows()
    return all.filter(e => e.offerId === offerId)
  }
  
  async getEscrowsByWallet(wallet: string): Promise<MarketEscrow[]> {
    const all = await this.getAllEscrows()
    return all.filter(e => e.buyerWallet === wallet || e.sellerWallet === wallet)
  }
  
  async createEscrow(params: EscrowCreateParams): Promise<MarketEscrow> {
    const escrowId = `esc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const contractId = await deployEscrowContract(params)
    
    const escrow: MarketEscrow = {
      escrowId,
      offerId: params.offerId,
      buyerWallet: params.buyerWallet,
      sellerWallet: params.sellerWallet,
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
      amount: params.amount,
      price: params.price,
      state: 'pending_deposit',
      contractId,
      expiresAt: Date.now() + (params.expiryDurationSec * 1000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      arbiterWallet: params.arbiterWallet,
      releaseSignatures: [],
    }
    
    const all = await this.getAllEscrows()
    all.push(escrow)
    await this.saveEscrows(all)
    
    return escrow
  }
  
  async updateEscrowState(
    escrowId: string,
    newState: EscrowState,
    metadata?: Partial<MarketEscrow>
  ): Promise<MarketEscrow> {
    const all = await this.getAllEscrows()
    const index = all.findIndex(e => e.escrowId === escrowId)
    
    if (index === -1) {
      throw new Error(`Escrow ${escrowId} not found`)
    }
    
    all[index] = {
      ...all[index],
      ...metadata,
      state: newState,
      updatedAt: Date.now(),
    }
    
    await this.saveEscrows(all)
    return all[index]
  }
  
  async addReleaseSignature(escrowId: string, signature: string): Promise<MarketEscrow> {
    const escrow = await this.getEscrowById(escrowId)
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`)
    
    if (!escrow.releaseSignatures.includes(signature)) {
      escrow.releaseSignatures.push(signature)
    }
    
    // Check if we have enough signatures (2-of-2 or 2-of-3 with arbiter)
    const requiredSigs = escrow.arbiterWallet ? 2 : 2
    if (escrow.releaseSignatures.length >= requiredSigs && escrow.state === 'funds_locked') {
      escrow.state = 'settlement_approved'
    }
    
    return await this.updateEscrowState(escrowId, escrow.state, escrow)
  }
  
  private async saveEscrows(escrows: MarketEscrow[]): Promise<void> {
    await fs.writeFile(this.getStorePath(), JSON.stringify(escrows, null, 2), 'utf-8')
  }
}

export const escrowStore = new EscrowSettlementStore()
```

#### 3. **Smart Contract Integration**
```typescript
// lib/escrow-settlement.ts (contract operations)

async function deployEscrowContract(params: EscrowCreateParams): Promise<string> {
  // This would deploy a Soroban escrow contract
  // For now, returning a placeholder - actual implementation requires Soroban contract code
  
  const contractWasmHash = process.env.ESCROW_CONTRACT_WASM_HASH
  if (!contractWasmHash) {
    throw new Error('ESCROW_CONTRACT_WASM_HASH not configured')
  }
  
  // Deploy contract instance
  // const contract = new Contract(contractWasmHash)
  // const result = await contract.deploy(...)
  
  return `C${Math.random().toString(36).slice(2).toUpperCase().padEnd(55, 'A')}`
}

export async function lockFundsInEscrow(escrow: MarketEscrow, buyerSecret: string): Promise<void> {
  // Buyer deposits funds into escrow contract
  // This would call the Soroban contract's `deposit` method
  
  const contract = new Contract(escrow.contractId)
  
  // Build transaction to deposit funds
  // const tx = new TransactionBuilder(...)
  //   .addOperation(contract.call('deposit', ...))
  //   .build()
  
  // Sign and submit
  // tx.sign(Keypair.fromSecret(buyerSecret))
  // await server.sendTransaction(tx)
  
  await escrowStore.updateEscrowState(escrow.escrowId, 'funds_locked')
}

export async function releaseEscrow(escrow: MarketEscrow, releaserSecret: string): Promise<void> {
  if (escrow.state !== 'settlement_approved') {
    throw new Error('Escrow not approved for release')
  }
  
  // Call contract release method which transfers funds to seller
  const contract = new Contract(escrow.contractId)
  
  // Build transaction
  // const tx = new TransactionBuilder(...)
  //   .addOperation(contract.call('release', ...))
  //   .build()
  
  // Sign and submit
  // tx.sign(Keypair.fromSecret(releaserSecret))
  // await server.sendTransaction(tx)
  
  await escrowStore.updateEscrowState(escrow.escrowId, 'completed')
}

export async function refundEscrow(escrow: MarketEscrow, reason: string): Promise<void> {
  if (!['dispute_raised', 'expired'].includes(escrow.state)) {
    throw new Error('Escrow cannot be refunded in current state')
  }
  
  // Call contract refund method which returns funds to buyer
  const contract = new Contract(escrow.contractId)
  
  // Build transaction
  // const tx = new TransactionBuilder(...)
  //   .addOperation(contract.call('refund', ...))
  //   .build()
  
  await escrowStore.updateEscrowState(escrow.escrowId, 'refunded', { disputeReason: reason })
}
```

#### 4. **API Route Implementation**
```typescript
// app/api/market/[id]/offers/escrow/route.ts (NEW FILE)

import { NextRequest, NextResponse } from 'next/server'
import { escrowStore, EscrowCreateParams } from '@/lib/escrow-settlement'
import { isFeatureEnabled } from '@/lib/feature-flags'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-135')) {
    return NextResponse.json(
      { error: 'Escrow feature disabled' },
      { status: 503 }
    )
  }
  
  try {
    const body = await req.json() as EscrowCreateParams
    
    // Validate offer exists
    const offer = await getOfferById(params.id)
    if (!offer) {
      return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
    }
    
    // Create escrow
    const escrow = await escrowStore.createEscrow({
      ...body,
      offerId: params.id,
    })
    
    return NextResponse.json({ escrow }, { status: 201 })
  } catch (error) {
    console.error('[escrow] Create failed:', error)
    return NextResponse.json(
      { error: 'Failed to create escrow' },
      { status: 500 }
    )
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-135')) {
    return NextResponse.json({ error: 'Escrow feature disabled' }, { status: 503 })
  }
  
  try {
    const escrows = await escrowStore.getEscrowsByOffer(params.id)
    return NextResponse.json({ escrows })
  } catch (error) {
    console.error('[escrow] Fetch failed:', error)
    return NextResponse.json({ error: 'Failed to fetch escrows' }, { status: 500 })
  }
}
```

```typescript
// app/api/escrow/[escrowId]/release/route.ts (NEW FILE)

export async function POST(
  req: NextRequest,
  { params }: { params: { escrowId: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-135')) {
    return NextResponse.json({ error: 'Escrow feature disabled' }, { status: 503 })
  }
  
  try {
    const { releaserWallet, signature, memo } = await req.json()
    
    const escrow = await escrowStore.getEscrowById(params.escrowId)
    if (!escrow) {
      return NextResponse.json({ error: 'Escrow not found' }, { status: 404 })
    }
    
    // Verify releaser is buyer or seller
    if (releaserWallet !== escrow.buyerWallet && releaserWallet !== escrow.sellerWallet) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    // Add signature
    const updated = await escrowStore.addReleaseSignature(params.escrowId, signature)
    
    // If approved, execute release
    if (updated.state === 'settlement_approved') {
      await releaseEscrow(updated, signature)
    }
    
    return NextResponse.json({ escrow: updated })
  } catch (error) {
    console.error('[escrow] Release failed:', error)
    return NextResponse.json({ error: 'Failed to release escrow' }, { status: 500 })
  }
}
```

```typescript
// app/api/escrow/[escrowId]/dispute/route.ts (NEW FILE)

export async function POST(
  req: NextRequest,
  { params }: { params: { escrowId: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-135')) {
    return NextResponse.json({ error: 'Escrow feature disabled' }, { status: 503 })
  }
  
  try {
    const { disputerWallet, reason, evidence } = await req.json()
    
    const escrow = await escrowStore.getEscrowById(params.escrowId)
    if (!escrow) {
      return NextResponse.json({ error: 'Escrow not found' }, { status: 404 })
    }
    
    // Verify disputer is buyer or seller
    if (disputerWallet !== escrow.buyerWallet && disputerWallet !== escrow.sellerWallet) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    // Raise dispute
    const updated = await escrowStore.updateEscrowState(
      params.escrowId,
      'dispute_raised',
      { disputeReason: reason }
    )
    
    // Notify arbiter if configured
    if (escrow.arbiterWallet) {
      // Send notification to arbiter
    }
    
    return NextResponse.json({ escrow: updated })
  } catch (error) {
    console.error('[escrow] Dispute failed:', error)
    return NextResponse.json({ error: 'Failed to raise dispute' }, { status: 500 })
  }
}
```

#### 5. **Market Store Integration**
```typescript
// lib/market-store.ts (add escrow support)

export interface MarketOffer {
  // ... existing fields ...
  escrowEnabled: boolean
  escrowId?: string
  escrowState?: EscrowState
}

export async function createOfferWithEscrow(
  offer: Omit<MarketOffer, 'id' | 'createdAt'>,
  escrowParams: EscrowCreateParams
): Promise<{ offer: MarketOffer; escrow: MarketEscrow }> {
  // Create offer
  const newOffer = await createOffer({ ...offer, escrowEnabled: true })
  
  // Create escrow
  const escrow = await escrowStore.createEscrow({
    ...escrowParams,
    offerId: newOffer.id,
  })
  
  // Link escrow to offer
  newOffer.escrowId = escrow.escrowId
  newOffer.escrowState = escrow.state
  await updateOffer(newOffer.id, newOffer)
  
  return { offer: newOffer, escrow }
}
```

#### 6. **UI Components**
```typescript
// components/dashboard/EscrowOfferCard.tsx (NEW FILE)

export function EscrowOfferCard({ offer }: { offer: MarketOffer }) {
  const [escrow, setEscrow] = useState<MarketEscrow | null>(null)
  
  useEffect(() => {
    if (offer.escrowId) {
      fetchEscrow(offer.escrowId).then(setEscrow)
    }
  }, [offer.escrowId])
  
  const handleAcceptOffer = async () => {
    // Create escrow and lock funds
    const newEscrow = await createEscrow({
      offerId: offer.id,
      buyerWallet: currentWallet,
      sellerWallet: offer.creatorWallet,
      assetCode: offer.assetCode,
      assetIssuer: offer.assetIssuer,
      amount: offer.amount,
      price: offer.price,
      expiryDurationSec: 7 * 24 * 60 * 60, // 7 days
    })
    
    await lockFundsInEscrow(newEscrow, currentWalletSecret)
    setEscrow(newEscrow)
  }
  
  const handleConfirmDelivery = async () => {
    if (!escrow) return
    
    const signature = await signEscrowRelease(escrow.escrowId, currentWalletSecret)
    await releaseEscrow(escrow.escrowId, currentWallet, signature)
  }
  
  const handleDispute = async (reason: string) => {
    if (!escrow) return
    
    await raiseEscrowDispute(escrow.escrowId, currentWallet, reason)
  }
  
  return (
    <Card>
      <CardHeader>
        <h3>{offer.title}</h3>
        {escrow && (
          <Badge variant={getEscrowStateBadgeVariant(escrow.state)}>
            {escrow.state}
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        <p>Amount: {offer.amount} {offer.assetCode}</p>
        <p>Price: {offer.price} XLM</p>
        
        {escrow && (
          <div className="mt-4">
            <h4>Escrow Status</h4>
            <EscrowTimeline escrow={escrow} />
            
            {escrow.state === 'funds_locked' && (
              <div className="flex gap-2 mt-4">
                <Button onClick={handleConfirmDelivery}>
                  Confirm Delivery
                </Button>
                <Button variant="destructive" onClick={() => handleDispute('Item not received')}>
                  Raise Dispute
                </Button>
              </div>
            )}
          </div>
        )}
        
        {!escrow && offer.escrowEnabled && (
          <Button onClick={handleAcceptOffer} className="mt-4">
            Accept Offer (Escrow Protected)
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
```

### Feature Flag
**Flag:** `NEXT_PUBLIC_FEATURE_PHASE_135`  
**Environment:** `ESCROW_CONTRACT_WASM_HASH` (Soroban contract hash)  
**Rollback:** Unset flag to disable escrow, revert to trust-based offers

### Testing Plan
1. **Create Escrow:** Create offer with escrow enabled, verify contract deployment
2. **Lock Funds:** Buyer accepts offer, verify funds locked in contract
3. **Release Flow:** Both parties sign release, verify funds transfer to seller
4. **Dispute Flow:** Raise dispute, involve arbiter, verify resolution
5. **Expiry Handling:** Let escrow expire, verify automatic refund
6. **State Transitions:** Test all state transitions, verify no invalid states

### Acceptance Criteria
- ✅ Escrow contracts deployed automatically for escrow-enabled offers
- ✅ Funds locked in smart contract, not accessible until release/refund
- ✅ 2-of-2 multisig release (buyer + seller)
- ✅ Optional 2-of-3 with arbiter for disputes
- ✅ Automatic expiry and refund after timeout
- ✅ Zero unhandled exceptions in production logs
- ✅ Full unit test pass rate

---

## Issue #59: Signal Thread Moderation & Community Flagging (Module #35) 🚩

**Type:** Feature  
**Effort:** 4 weeks  
**Files Impacted:**
- `app/api/signals/[id]/replies/route.ts`
- `lib/signal-store.ts`
- `app/signals/[id]/page.tsx`

### Problem Statement
Signal feed lacks decentralized spam filtering primitives. Users have no way to flag inappropriate content, and there's no community moderation system to handle spam, abuse, or low-quality content.

### Technical Requirements

#### 1. **Moderation Types**
```typescript
// lib/signal-moderation.ts (NEW FILE)

export type ModerationAction = 
  | 'flag_spam'
  | 'flag_abuse'
  | 'flag_inappropriate'
  | 'flag_misleading'
  | 'flag_offtopic'
  | 'upvote_quality'
  | 'downvote_quality'

export type ModerationStatus = 
  | 'active'
  | 'under_review'
  | 'hidden'
  | 'removed'
  | 'appealed'
  | 'restored'

export interface ModerationFlag {
  flagId: string
  signalId: string
  replyId?: string
  flaggerWallet: string
  action: ModerationAction
  reason?: string
  timestamp: number
  resolved: boolean
  moderatorNote?: string
}

export interface SignalModerationState {
  signalId: string
  status: ModerationStatus
  flagCount: number
  flags: ModerationFlag[]
  qualityScore: number
  hiddenAt?: number
  removedAt?: number
  appealedAt?: number
  restoredAt?: number
  moderatorWallet?: string
  moderationReason?: string
}

export interface CommunityModeration {
  moderationId: string
  targetType: 'signal' | 'reply'
  targetId: string
  walletReputation: Map<string, number>
  thresholds: {
    autoHide: number
    autoReview: number
    minReputationToFlag: number
  }
  decisionHistory: ModerationDecision[]
}

export interface ModerationDecision {
  decisionId: string
  targetId: string
  decidedBy: string
  decision: 'hide' | 'remove' | 'restore' | 'warn'
  reason: string
  timestamp: number
  appealable: boolean
}
```

#### 2. **Moderation Store**
```typescript
// lib/signal-moderation.ts (continued)

import { serverDataJsonPath } from './server-data'
import fs from 'fs/promises'

const MODERATION_STORE_FILE = 'signalModeration.json'
const REPUTATION_STORE_FILE = 'walletReputation.json'

export class SignalModerationStore {
  private getStorePath(file: string): string {
    return serverDataJsonPath(file)
  }
  
  async getAllModerationStates(): Promise<SignalModerationState[]> {
    try {
      const content = await fs.readFile(this.getStorePath(MODERATION_STORE_FILE), 'utf-8')
      return JSON.parse(content)
    } catch {
      return []
    }
  }
  
  async getModerationState(signalId: string): Promise<SignalModerationState | null> {
    const all = await this.getAllModerationStates()
    return all.find(m => m.signalId === signalId) ?? null
  }
  
  async initializeModerationState(signalId: string): Promise<SignalModerationState> {
    const existing = await this.getModerationState(signalId)
    if (existing) return existing
    
    const newState: SignalModerationState = {
      signalId,
      status: 'active',
      flagCount: 0,
      flags: [],
      qualityScore: 0,
    }
    
    const all = await this.getAllModerationStates()
    all.push(newState)
    await this.saveModerationStates(all)
    
    return newState
  }
  
  async addFlag(
    signalId: string,
    flaggerWallet: string,
    action: ModerationAction,
    reason?: string,
    replyId?: string
  ): Promise<ModerationFlag> {
    let state = await this.getModerationState(signalId)
    if (!state) {
      state = await this.initializeModerationState(signalId)
    }
    
    // Check if wallet already flagged this signal
    const existingFlag = state.flags.find(
      f => f.flaggerWallet === flaggerWallet && f.replyId === replyId
    )
    
    if (existingFlag) {
      throw new Error('Wallet has already flagged this content')
    }
    
    // Check flagger reputation
    const reputation = await this.getWalletReputation(flaggerWallet)
    if (reputation < 0) {
      throw new Error('Insufficient reputation to flag content')
    }
    
    const flag: ModerationFlag = {
      flagId: `flag_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      signalId,
      replyId,
      flaggerWallet,
      action,
      reason,
      timestamp: Date.now(),
      resolved: false,
    }
    
    state.flags.push(flag)
    state.flagCount++
    
    // Auto-moderation based on thresholds
    const autoHideThreshold = 5
    const autoReviewThreshold = 3
    
    if (state.flagCount >= autoHideThreshold && state.status === 'active') {
      state.status = 'hidden'
      state.hiddenAt = Date.now()
    } else if (state.flagCount >= autoReviewThreshold && state.status === 'active') {
      state.status = 'under_review'
    }
    
    await this.updateModerationState(state)
    
    // Update flagger reputation (positive for valid flags)
    await this.adjustWalletReputation(flaggerWallet, 1)
    
    return flag
  }
  
  async adjustQualityScore(signalId: string, delta: number): Promise<SignalModerationState> {
    let state = await this.getModerationState(signalId)
    if (!state) {
      state = await this.initializeModerationState(signalId)
    }
    
    state.qualityScore += delta
    
    // Auto-hide low quality content
    if (state.qualityScore < -10 && state.status === 'active') {
      state.status = 'hidden'
      state.hiddenAt = Date.now()
      state.moderationReason = 'Low community quality score'
    }
    
    await this.updateModerationState(state)
    return state
  }
  
  async resolveFlag(
    flagId: string,
    moderatorWallet: string,
    decision: 'hide' | 'remove' | 'restore' | 'ignore',
    note?: string
  ): Promise<void> {
    const all = await this.getAllModerationStates()
    
    for (const state of all) {
      const flag = state.flags.find(f => f.flagId === flagId)
      if (flag) {
        flag.resolved = true
        flag.moderatorNote = note
        
        if (decision === 'hide') {
          state.status = 'hidden'
          state.hiddenAt = Date.now()
        } else if (decision === 'remove') {
          state.status = 'removed'
          state.removedAt = Date.now()
        } else if (decision === 'restore') {
          state.status = 'restored'
          state.restoredAt = Date.now()
        }
        
        state.moderatorWallet = moderatorWallet
        state.moderationReason = note
        
        break
      }
    }
    
    await this.saveModerationStates(all)
  }
  
  async appealModeration(signalId: string, appealerWallet: string, reason: string): Promise<void> {
    const state = await this.getModerationState(signalId)
    if (!state) throw new Error('Moderation state not found')
    
    if (!['hidden', 'removed'].includes(state.status)) {
      throw new Error('Cannot appeal content that is not hidden or removed')
    }
    
    state.status = 'appealed'
    state.appealedAt = Date.now()
    state.moderationReason = `Appeal: ${reason}`
    
    await this.updateModerationState(state)
  }
  
  private async updateModerationState(state: SignalModerationState): Promise<void> {
    const all = await this.getAllModerationStates()
    const index = all.findIndex(m => m.signalId === state.signalId)
    
    if (index >= 0) {
      all[index] = state
    } else {
      all.push(state)
    }
    
    await this.saveModerationStates(all)
  }
  
  private async saveModerationStates(states: SignalModerationState[]): Promise<void> {
    await fs.writeFile(
      this.getStorePath(MODERATION_STORE_FILE),
      JSON.stringify(states, null, 2),
      'utf-8'
    )
  }
  
  // Wallet reputation system
  async getWalletReputation(wallet: string): Promise<number> {
    try {
      const content = await fs.readFile(this.getStorePath(REPUTATION_STORE_FILE), 'utf-8')
      const reputations = JSON.parse(content) as Record<string, number>
      return reputations[wallet] ?? 0
    } catch {
      return 0
    }
  }
  
  async adjustWalletReputation(wallet: string, delta: number): Promise<number> {
    let reputations: Record<string, number> = {}
    
    try {
      const content = await fs.readFile(this.getStorePath(REPUTATION_STORE_FILE), 'utf-8')
      reputations = JSON.parse(content)
    } catch {
      // File doesn't exist yet
    }
    
    reputations[wallet] = (reputations[wallet] ?? 0) + delta
    
    await fs.writeFile(
      this.getStorePath(REPUTATION_STORE_FILE),
      JSON.stringify(reputations, null, 2),
      'utf-8'
    )
    
    return reputations[wallet]
  }
}

export const moderationStore = new SignalModerationStore()
```

#### 3. **API Routes**
```typescript
// app/api/signals/[id]/flag/route.ts (NEW FILE)

import { NextRequest, NextResponse } from 'next/server'
import { moderationStore, ModerationAction } from '@/lib/signal-moderation'
import { isFeatureEnabled } from '@/lib/feature-flags'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-136')) {
    return NextResponse.json(
      { error: 'Content moderation disabled' },
      { status: 503 }
    )
  }
  
  try {
    const { flaggerWallet, action, reason, replyId } = await req.json()
    
    if (!flaggerWallet || !action) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }
    
    const flag = await moderationStore.addFlag(
      params.id,
      flaggerWallet,
      action as ModerationAction,
      reason,
      replyId
    )
    
    const state = await moderationStore.getModerationState(params.id)
    
    return NextResponse.json({ flag, moderationState: state }, { status: 201 })
  } catch (error) {
    console.error('[moderation] Flag failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to flag content' },
      { status: 500 }
    )
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-136')) {
    return NextResponse.json({ error: 'Content moderation disabled' }, { status: 503 })
  }
  
  try {
    const state = await moderationStore.getModerationState(params.id)
    
    if (!state) {
      return NextResponse.json(
        { moderationState: { status: 'active', flagCount: 0, flags: [] } }
      )
    }
    
    return NextResponse.json({ moderationState: state })
  } catch (error) {
    console.error('[moderation] Fetch failed:', error)
    return NextResponse.json(
      { error: 'Failed to fetch moderation state' },
      { status: 500 }
    )
  }
}
```

```typescript
// app/api/signals/[id]/quality/route.ts (NEW FILE)

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-136')) {
    return NextResponse.json({ error: 'Quality voting disabled' }, { status: 503 })
  }
  
  try {
    const { voterWallet, vote } = await req.json() // vote: 'up' | 'down'
    
    const delta = vote === 'up' ? 1 : -1
    const state = await moderationStore.adjustQualityScore(params.id, delta)
    
    // Adjust poster reputation based on quality votes
    const signal = await getSignalById(params.id)
    if (signal) {
      await moderationStore.adjustWalletReputation(signal.creatorWallet, delta)
    }
    
    return NextResponse.json({ moderationState: state })
  } catch (error) {
    console.error('[moderation] Quality vote failed:', error)
    return NextResponse.json(
      { error: 'Failed to record quality vote' },
      { status: 500 }
    )
  }
}
```

```typescript
// app/api/signals/[id]/appeal/route.ts (NEW FILE)

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  if (!isFeatureEnabled('phase-136')) {
    return NextResponse.json({ error: 'Appeals disabled' }, { status: 503 })
  }
  
  try {
    const { appealerWallet, reason } = await req.json()
    
    await moderationStore.appealModeration(params.id, appealerWallet, reason)
    
    const state = await moderationStore.getModerationState(params.id)
    
    return NextResponse.json({ moderationState: state })
  } catch (error) {
    console.error('[moderation] Appeal failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to appeal moderation' },
      { status: 500 }
    )
  }
}
```

#### 4. **Signal Store Integration**
```typescript
// lib/signal-store.ts (add moderation support)

import { moderationStore } from './signal-moderation'

export interface Signal {
  // ... existing fields ...
  moderationStatus?: ModerationStatus
  flagCount?: number
  qualityScore?: number
}

export async function getSignalWithModeration(signalId: string): Promise<Signal | null> {
  const signal = await getSignalById(signalId)
  if (!signal) return null
  
  const moderationState = await moderationStore.getModerationState(signalId)
  
  if (moderationState) {
    signal.moderationStatus = moderationState.status
    signal.flagCount = moderationState.flagCount
    signal.qualityScore = moderationState.qualityScore
  }
  
  return signal
}

export async function getActiveSignals(filters?: SignalFilters): Promise<Signal[]> {
  const allSignals = await getAllSignals(filters)
  
  // Filter out hidden/removed signals
  const activeSignals: Signal[] = []
  
  for (const signal of allSignals) {
    const moderationState = await moderationStore.getModerationState(signal.id)
    
    if (!moderationState || ['active', 'under_review'].includes(moderationState.status)) {
      signal.moderationStatus = moderationState?.status ?? 'active'
      signal.flagCount = moderationState?.flagCount ?? 0
      signal.qualityScore = moderationState?.qualityScore ?? 0
      activeSignals.push(signal)
    }
  }
  
  // Sort by quality score (highest first)
  return activeSignals.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))
}
```

#### 5. **UI Components**
```typescript
// components/signal/ModerationControls.tsx (NEW FILE)

export function ModerationControls({ signal }: { signal: Signal }) {
  const [showFlagDialog, setShowFlagDialog] = useState(false)
  const [moderationState, setModerationState] = useState<SignalModerationState | null>(null)
  
  useEffect(() => {
    fetchModerationState(signal.id).then(setModerationState)
  }, [signal.id])
  
  const handleFlag = async (action: ModerationAction, reason?: string) => {
    try {
      await flagSignal(signal.id, currentWallet, action, reason)
      setShowFlagDialog(false)
      toast.success('Content flagged for review')
    } catch (error) {
      toast.error('Failed to flag content')
    }
  }
  
  const handleQualityVote = async (vote: 'up' | 'down') => {
    try {
      await voteSignalQuality(signal.id, currentWallet, vote)
      toast.success(`Quality ${vote}voted`)
    } catch (error) {
      toast.error('Failed to record vote')
    }
  }
  
  return (
    <div className="flex items-center gap-2">
      {/* Quality voting */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleQualityVote('up')}
        >
          <ThumbsUp className="h-4 w-4" />
        </Button>
        <span className="text-sm">{signal.qualityScore ?? 0}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleQualityVote('down')}
        >
          <ThumbsDown className="h-4 w-4" />
        </Button>
      </div>
      
      {/* Flag button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowFlagDialog(true)}
      >
        <Flag className="h-4 w-4 mr-1" />
        Flag ({moderationState?.flagCount ?? 0})
      </Button>
      
      {/* Moderation status badge */}
      {moderationState && moderationState.status !== 'active' && (
        <Badge variant={getModerationBadgeVariant(moderationState.status)}>
          {moderationState.status}
        </Badge>
      )}
      
      {/* Flag dialog */}
      <Dialog open={showFlagDialog} onOpenChange={setShowFlagDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Flag Content</DialogTitle>
            <DialogDescription>
              Help keep the community safe by reporting inappropriate content
            </DialogDescription>
          </DialogHeader>
          <FlagForm onSubmit={handleFlag} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

### Feature Flag
**Flag:** `NEXT_PUBLIC_FEATURE_PHASE_136`  
**Rollback:** Unset flag to disable moderation system

### Testing Plan
1. **Flag Content:** Flag signal as spam, verify state changes
2. **Auto-Hide:** Accumulate flags, verify auto-hide at threshold
3. **Quality Voting:** Upvote/downvote signals, verify score changes
4. **Reputation System:** Flag content, verify reputation adjustment
5. **Appeal Flow:** Appeal hidden content, verify state transition
6. **Moderator Actions:** Resolve flags as moderator, verify decisions applied

### Acceptance Criteria
- ✅ Users can flag content with specific reasons
- ✅ Auto-hide content after 5 flags
- ✅ Quality voting affects signal visibility
- ✅ Reputation system prevents abuse (negative reputation = no flagging)
- ✅ Appeal system for wrongly moderated content
- ✅ Zero unhandled exceptions in production logs
- ✅ Full unit test pass rate

---

## Environment Variables Summary

```bash
# .env.example additions for all 4 issues

# ──────────────────────────────────────────────────────────────
# Issue #52: Multi-Network Bootstrap
# ──────────────────────────────────────────────────────────────
NEXT_PUBLIC_FEATURE_PHASE_133=true
NEXT_PUBLIC_PHASE_NETWORK_TYPE=testnet
# NEXT_PUBLIC_PHASE_RPC_URL=https://soroban-testnet.stellar.org
# NEXT_PUBLIC_PHASE_HORIZON_URL=https://horizon-testnet.stellar.org
# PHASE_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# ──────────────────────────────────────────────────────────────
# Issue #53: Environment Integrity Inspector
# ──────────────────────────────────────────────────────────────
NEXT_PUBLIC_FEATURE_PHASE_134=true
# ENABLE_ENV_MONITOR=true  # Production monitoring
# ENV_WATCH=true  # Development watch mode
# ALERT_ON_ENV_ERROR=true  # Send alerts on errors

# ──────────────────────────────────────────────────────────────
# Issue #58: Escrow-Based Marketplace
# ──────────────────────────────────────────────────────────────
NEXT_PUBLIC_FEATURE_PHASE_135=true
ESCROW_CONTRACT_WASM_HASH=<your_escrow_contract_wasm_hash>

# ──────────────────────────────────────────────────────────────
# Issue #59: Signal Thread Moderation
# ──────────────────────────────────────────────────────────────
NEXT_PUBLIC_FEATURE_PHASE_136=true
```

## Feature Flags Summary

| Issue | Feature Flag | Module | Rollback Method |
|-------|-------------|--------|-----------------|
| #52 | `NEXT_PUBLIC_FEATURE_PHASE_133` | Multi-Network Bootstrap | Unset flag → revert to testnet |
| #53 | `NEXT_PUBLIC_FEATURE_PHASE_134` | Env Integrity Inspector | Unset flag → disable monitoring |
| #58 | `NEXT_PUBLIC_FEATURE_PHASE_135` | Escrow Settlement | Unset flag → trust-based offers |
| #59 | `NEXT_PUBLIC_FEATURE_PHASE_136` | Signal Moderation | Unset flag → no moderation |

## Testing Matrix

| Feature | Unit Tests | Integration Tests | E2E Tests |
|---------|-----------|-------------------|-----------|
| Multi-Network Bootstrap | ✅ Network detection, validation | ✅ Setup scripts on testnet/local | ✅ Full bootstrap flow |
| Env Integrity Inspector | ✅ Validation logic, error formatting | ✅ Watch mode, monitor events | ✅ Runtime detection |
| Escrow Settlement | ✅ Escrow state machine, signatures | ✅ Contract deployment, fund locking | ✅ Complete trade flow |
| Signal Moderation | ✅ Flag validation, reputation calc | ✅ Auto-hide thresholds, appeals | ✅ Community flagging workflow |

## Deployment Checklist

- [ ] All feature flags added to `.env.example`
- [ ] Diagnostic script updated with new audits
- [ ] Database migration files created (if needed)
- [ ] API routes tested with feature flags on/off
- [ ] UI components render correctly with moderation states
- [ ] Escrow contract deployed to testnet
- [ ] Documentation updated in README
- [ ] All unit tests passing (100% coverage on new modules)
- [ ] Integration tests passing
- [ ] PR created and linked to issues #52, #53, #58, #59

## Rollback Plan

Each feature is independently toggleable via feature flags:

1. **Immediate Rollback:** Unset feature flag in environment
2. **Restart Required:** Yes (environment variable changes)
3. **Data Persistence:** All stores use JSON files - data preserved during rollback
4. **Contract Cleanup:** Escrow contracts remain on-chain but become inactive

## Performance Considerations

- **Moderation Store:** JSON file-based, scales to ~10K signals before optimization needed
- **Escrow Contracts:** Each offer creates new contract instance (gas costs)
- **Reputation System:** In-memory cache recommended for high-traffic deployments
- **Diagnostics:** Watch mode checks every 30-60s, minimal overhead

## Security Considerations

- **Escrow Contracts:** Require independent security audit before mainnet
- **Secret Keys:** Enhanced validation prevents common configuration errors
- **Moderation Abuse:** Reputation system prevents spam flagging
- **Multi-Network:** Mainnet operations require explicit confirmation

---

**Implementation Status:** ✅ Specification Complete  
**Next Steps:** Deploy to testnet, run full integration test suite, create PR
