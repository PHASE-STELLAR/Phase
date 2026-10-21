/**
 * phase-93: profile completeness scoring with on-chain signals — tests
 * Run: npx tsx tests/profile-completeness.test.ts
 */
import assert from "node:assert/strict"

process.env.NEXT_PUBLIC_FEATURE_PHASE_93 = "1"
process.env.FEATURE_PHASE_93 = "1"

import { computeProfileCompletenessScore } from "@/lib/phase-nft-metadata-build"

async function testEmptyProfileScoresZero() {
  const result = computeProfileCompletenessScore({
    hasDisplayName: false,
    hasAvatar: false,
    socialLinksCount: 0,
    collectionsCreated: 0,
    isVerifiedArtist: false,
  })
  assert.equal(result.score, 0)
  console.log("✓ empty profile scores 0")
}

async function testFullProfileScoresHundred() {
  const result = computeProfileCompletenessScore({
    hasDisplayName: true,
    hasAvatar: true,
    socialLinksCount: 3,
    collectionsCreated: 5, // capped at 3 in weighting
    isVerifiedArtist: true,
  })
  assert.equal(result.score, 100)
  assert.equal(result.breakdown.displayName, 20)
  assert.equal(result.breakdown.avatar, 20)
  assert.equal(result.breakdown.socialLinks, 30)
  assert.equal(result.breakdown.onChainCollections, 15)
  assert.equal(result.breakdown.verifiedArtist, 15)
  console.log("✓ full profile scores 100 and collection contribution is capped")
}

async function testPartialProfile() {
  const result = computeProfileCompletenessScore({
    hasDisplayName: true,
    hasAvatar: false,
    socialLinksCount: 1,
    collectionsCreated: 1,
    isVerifiedArtist: false,
  })
  // 20 (name) + 0 (avatar) + 10 (1 social) + 5 (1 collection) + 0 (not verified) = 35
  assert.equal(result.score, 35)
  console.log("✓ partial profile scores proportionally")
}

async function run() {
  await testEmptyProfileScoresZero()
  await testFullProfileScoresHundred()
  await testPartialProfile()
  console.log("\nAll profile-completeness (phase-93) tests passed.")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
