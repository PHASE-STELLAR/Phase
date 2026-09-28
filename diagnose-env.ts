/**
 * Script de diagnóstico para verificar la configuración de PHASE
 * Uso: npm run diagnose o npx tsx diagnose-env.ts (desde la raíz del repo)
 */

import {
  validatePhaseEnv,
  validateServerEnv,
  validateClientEnv,
  formatEnvValidationErrors,
  validateFaucetIssuerConfig,
  auditFollowGraphPortabilityWiring,
  isPhase95Enabled,
  auditQuestExperimentWiring,
  isQuestExperimentEnabled,
} from "@/lib/env-validation"
import {
  classicLiqIssuerForStellarToml,
  expectedClassicPhaserLiqSorobanContractId,
} from "@/lib/classic-liq"
import { getPhaserLiqDiagnostic } from "@/lib/phaser-liq-sac-warn"
import { TOKEN_ADDRESS, CONTRACT_ID } from "@/lib/phase-protocol"
import { auditFaucetRateLimitWiring, isFaucetRateLimitRedisEnabled } from "@/lib/profile-store"
import { auditQuestExpiryWiring, isQuestExpiryEnabled } from "@/lib/explore-domain"
import { auditFaucetAnalyticsWiring, isFaucetAnalyticsEnabled } from "@/lib/notification-store"

console.log("=".repeat(70))
console.log("DIAGNÓSTICO DE CONFIGURACIÓN PHASE")
console.log("=".repeat(70))

// 1. Validación general y esquemas Zod (server vs client)
console.log("\n📋 Validación de esquemas de entorno (Zod serverSchema & clientSchema):")
const serverCheck = validateServerEnv()
const clientCheck = validateClientEnv()

if (serverCheck.valid) {
  console.log("   ✅ serverSchema: Variables de servidor válidas")
} else {
  console.log("   ❌ serverSchema errores:")
  console.log(formatEnvValidationErrors(serverCheck))
}

if (clientCheck.valid) {
  console.log("   ✅ clientSchema: Variables cliente NEXT_PUBLIC_* válidas y seguras")
} else {
  console.log("   ❌ clientSchema errores:")
  console.log(formatEnvValidationErrors(clientCheck))
}

const validation = validatePhaseEnv()
if (validation.valid) {
  console.log("   ✅ Todas las variables de entorno requeridas están configuradas")
} else {
  console.log(formatEnvValidationErrors(validation))
}

// 2. Verificación de Contract IDs
console.log("\n🔍 Verificación de Contract IDs:")
console.log(`   TOKEN_ADDRESS (PHASELQ): ${TOKEN_ADDRESS}`)
console.log(`   CONTRACT_ID (PHASE):       ${CONTRACT_ID}`)

// Verificar que no sean cuentas G...
const tokenDiagnostic = getPhaserLiqDiagnostic(TOKEN_ADDRESS)
if (tokenDiagnostic.isAccount) {
  console.error("   ❌ ERROR: TOKEN_ADDRESS es una cuenta G... pero debe ser un Contract C...")
  console.error("      Solución: Configura NEXT_PUBLIC_PHASER_TOKEN_ID con el Contract ID del SAC")
} else if (tokenDiagnostic.isContract) {
  console.log("   ✅ TOKEN_ADDRESS tiene formato válido de Contract ID")
} else {
  console.error("   ❌ ERROR: TOKEN_ADDRESS tiene formato inválido")
}

// 3. Verificación de alineación con asset clásico
console.log("\n🔗 Verificación de alineación con asset clásico:")
const expectedSac = expectedClassicPhaserLiqSorobanContractId()
const classicIssuer = classicLiqIssuerForStellarToml()
console.log(`   Issuer del asset clásico: ${classicIssuer}`)
console.log(`   SAC esperado:              ${expectedSac}`)
console.log(`   TOKEN_ADDRESS configurado: ${TOKEN_ADDRESS}`)

if (TOKEN_ADDRESS === expectedSac) {
  console.log("   ✅ TOKEN_ADDRESS coincide con el SAC derivado del asset clásico")
} else {
  console.warn("   ⚠️  WARNING: TOKEN_ADDRESS no coincide con el SAC del asset clásico")
  console.warn("      Esto puede causar fallos en mint/settle/x402")
  console.warn("      Solución: Verifica que NEXT_PUBLIC_PHASER_TOKEN_ID coincida con el")
  console.warn("      Contract ID del asset en Stellar Expert (issuer → Assets → Contract ID)")
}

// 4. Verificación de configuración del faucet
console.log("\n💰 Verificación de configuración del faucet:")
const adminSecret = process.env.ADMIN_SECRET_KEY
const distributorSecret = process.env.FAUCET_DISTRIBUTOR_SECRET_KEY

if (distributorSecret) {
  console.log("   ✅ FAUCET_DISTRIBUTOR_SECRET_KEY configurado (modo transfer)")
} else if (adminSecret) {
  console.log("   ℹ️  ADMIN_SECRET_KEY configurado (modo mint)")
  const issuerError = validateFaucetIssuerConfig(adminSecret, classicIssuer)
  if (issuerError) {
    console.error(`   ❌ ERROR: ${issuerError}`)
    console.error("      Solución: Usa FAUCET_DISTRIBUTOR_SECRET_KEY para modo transfer,")
    console.error("      o asegúrate de que ADMIN_SECRET_KEY sea el secret del issuer.")
  } else {
    console.log("   ✅ ADMIN_SECRET_KEY corresponde al issuer del asset clásico")
  }
} else {
  console.warn("   ⚠️  Ninguna clave de faucet (opcional si no usas mint/transfer del faucet)")
  console.warn("      Configura ADMIN_SECRET_KEY (modo mint) o FAUCET_DISTRIBUTOR_SECRET_KEY (modo transfer)")
}

// 4b. Forge Oracle (Gemini lore + imagen)
console.log("\n🧠 Forge Oracle (/api/forge-agent) — Gemini + imagen:")
const googleStudio = process.env.GOOGLE_AI_STUDIO_API_KEY?.trim()
const geminiLegacy = process.env.GEMINI_API_KEY?.trim()
const nanobanana = process.env.NANOBANANA_API_KEY?.trim()
if (nanobanana) {
  console.log("   ✅ NANOBANANA_API_KEY configurada (imagen vía nanobananaapi.ai)")
}
if (googleStudio?.startsWith("AIza")) {
  console.log("   ✅ GOOGLE_AI_STUDIO_API_KEY parece clave Gemini (AIza…)")
} else if (googleStudio) {
  console.warn(
    "   ⚠️  GOOGLE_AI_STUDIO_API_KEY no empieza por AIza (no es clave Gemini); el lore usará GEMINI_API_KEY si es válida",
  )
}
if (geminiLegacy?.startsWith("AIza")) {
  console.log("   ✅ GEMINI_API_KEY parece clave Gemini")
} else if (geminiLegacy && !googleStudio?.startsWith("AIza")) {
  console.log("   ℹ️  GEMINI_API_KEY configurada")
}
if (!googleStudio?.startsWith("AIza") && !geminiLegacy?.startsWith("AIza")) {
  console.warn("   ⚠️  Sin clave Gemini (AIza…) para lore: el Oráculo responderá 503 antes del paywall")
}

// 5. Verificación de trustline
console.log("\n📜 Verificación de configuración de trustline:")
const classicCode = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ASSET_CODE || "PHASELQ"
const classicIssuerEnv = process.env.NEXT_PUBLIC_CLASSIC_LIQ_ISSUER
console.log(`   Asset code:  ${classicCode}`)
console.log(`   Issuer:      ${classicIssuerEnv || "(usando default)"}`)
console.log(`   Esperado:    ${classicIssuer}`)

if (!classicIssuerEnv) {
  console.warn("   ⚠️  NEXT_PUBLIC_CLASSIC_LIQ_ISSUER no configurado")
  console.warn("      Se usará el issuer por defecto. Para producción, configura esta variable.")
}

// 5b. Follow-graph export/import portability (phase-95)
if (isPhase95Enabled()) {
  console.log("\n🔀 Follow-graph export/import portability (phase-95):")
  const portabilityAudit = auditFollowGraphPortabilityWiring()
  console.log(`   ${portabilityAudit.ok ? "✅" : "❌"} ${portabilityAudit.note}`)
}

// 5c. Quest A/B variant experimentation framework (module #50 / phase-50)
if (isQuestExperimentEnabled()) {
  console.log("\n🧪 Quest A/B variant experimentation (module #50):")
  const questExpAudit = auditQuestExperimentWiring()
  console.log(`   ${questExpAudit.ok ? "✅" : "❌"} ${questExpAudit.note}`)
}

// 5d. Race-safe faucet claim rate-limits (module #51 / phase-51)
if (isFaucetRateLimitRedisEnabled()) {
  console.log("\n🚦 Race-safe faucet claim rate-limits (module #51):")
  const rateLimitAudit = auditFaucetRateLimitWiring()
  console.log(`   ${rateLimitAudit.ok ? "✅" : "❌"} ${rateLimitAudit.note}`)
  if (!process.env.FAUCET_RATE_LIMIT_REDIS_URL && !process.env.REDIS_URL && !process.env.KV_URL) {
    console.warn("   ⚠️  No REDIS_URL / KV_URL / FAUCET_RATE_LIMIT_REDIS_URL set — using the process-local memory backend (safe for a single instance only).")
  }
}

// 5e. quest_expiry windows with grace-period extension (module #52 / phase-52)
if (isQuestExpiryEnabled()) {
  console.log("\n⏳ quest_expiry windows with grace-period extension (module #52):")
  const questExpiryAudit = auditQuestExpiryWiring()
  console.log(`   ${questExpiryAudit.ok ? "✅" : "❌"} ${questExpiryAudit.note}`)
}

// 5f. Faucet analytics — claim funnel metrics (module #53 / phase-53)
if (isFaucetAnalyticsEnabled()) {
  console.log("\n📉 Faucet analytics — claim funnel metrics (module #53):")
  const funnelAudit = auditFaucetAnalyticsWiring()
  console.log(`   ${funnelAudit.ok ? "✅" : "❌"} ${funnelAudit.note}`)
}

// 6. Resumen
console.log("\n" + "=".repeat(70))
if (validation.valid && tokenDiagnostic.isContract && !tokenDiagnostic.errors.length) {
  console.log("✅ CONFIGURACIÓN CORRECTA - La app debería funcionar correctamente")
} else {
  console.log("❌ CONFIGURACIÓN INCOMPLETA - Revisa los errores arriba antes de continuar")
  process.exit(1)
}
console.log("=".repeat(70))


// 7. CSP Header Compliance Verification
console.log("\n🔒 Content Security Policy (CSP) Compliance:")
try {
  const nextConfigPath = "./next.config.mjs"
  const fs = require("fs")
  if (fs.existsSync(nextConfigPath)) {
    const configContent = fs.readFileSync(nextConfigPath, "utf8")
    const hasCsp = configContent.includes("Content-Security-Policy")
    if (hasCsp) {
      console.log("   ✅ Content-Security-Policy header configured in next.config.mjs")
      
      // Check for key CSP directives
      const hasDefaultSrc = /default-src\s+'self'/.test(configContent)
      const hasScriptSrc = /script-src/.test(configContent)
      const hasStyleSrc = /style-src/.test(configContent)
      const hasImgSrc = /img-src/.test(configContent)
      
      if (hasDefaultSrc) console.log("   ✅ default-src directive present")
      if (hasScriptSrc) console.log("   ✅ script-src directive present")
      if (hasStyleSrc) console.log("   ✅ style-src directive present")
      if (hasImgSrc) console.log("   ✅ img-src directive present")
      
      if (!hasDefaultSrc || !hasScriptSrc) {
        console.warn("   ⚠️  WARNING: Some critical CSP directives may be missing")
      }
    } else {
      console.error("   ❌ ERROR: No Content-Security-Policy header found in next.config.mjs")
      console.error("      Add CSP headers to protect against XSS and injection attacks")
    }
  } else {
    console.warn("   ⚠️  next.config.mjs not found")
  }
} catch (e) {
  console.error("   ❌ ERROR checking CSP configuration:", e instanceof Error ? e.message : String(e))
}
