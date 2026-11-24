/**
 * phase-92: push notifications for replies and mentions — tests
 * Run: npx tsx tests/push-notifications.test.ts
 */
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

process.env.NEXT_PUBLIC_FEATURE_PHASE_92 = "1"
process.env.FEATURE_PHASE_92 = "1"
process.env.PHASE_SERVER_DATA_DIR = path.join(os.tmpdir(), `phase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

import {
  PushNotificationError,
  extractMentionedWallets,
  getPushSubscriptions,
  isPhase92Enabled,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push-notifications"

const WALLET_A = "GA" + "A".repeat(54)
const WALLET_B = "GB" + "B".repeat(53) + "A"

async function testFlagEnabled() {
  assert.equal(isPhase92Enabled(), true)
  console.log("✓ flag enabled via env")
}

async function testSubscribeAndList() {
  await subscribeToPush({
    wallet: WALLET_A,
    endpoint: "https://push.example.com/ep1",
    keys: { p256dh: "k1", auth: "a1" },
  })
  const subs = await getPushSubscriptions(WALLET_A)
  assert.equal(subs.length, 1)
  assert.equal(subs[0]?.endpoint, "https://push.example.com/ep1")
  console.log("✓ subscribe and list")
}

async function testDedupeByEndpoint() {
  await subscribeToPush({
    wallet: WALLET_A,
    endpoint: "https://push.example.com/ep1",
    keys: { p256dh: "k1-updated", auth: "a1" },
  })
  const subs = await getPushSubscriptions(WALLET_A)
  assert.equal(subs.length, 1)
  assert.equal(subs[0]?.keys.p256dh, "k1-updated")
  console.log("✓ re-subscribing same endpoint dedupes")
}

async function testUnsubscribe() {
  await unsubscribeFromPush(WALLET_A, "https://push.example.com/ep1")
  const subs = await getPushSubscriptions(WALLET_A)
  assert.equal(subs.length, 0)
  console.log("✓ unsubscribe removes endpoint")
}

async function testUnsubscribeNotFound() {
  let threw = false
  try {
    await unsubscribeFromPush(WALLET_B, "https://push.example.com/missing")
  } catch (e) {
    threw = e instanceof PushNotificationError && e.code === "NOT_FOUND"
  }
  assert.equal(threw, true)
  console.log("✓ unsubscribe of unknown endpoint throws NOT_FOUND")
}

async function testExtractMentions() {
  const text = `hey @${WALLET_A} and @${WALLET_B}, check this out! not-a-mention@nope`
  const mentions = extractMentionedWallets(text)
  assert.deepEqual(mentions.sort(), [WALLET_A, WALLET_B].sort())
  console.log("✓ extractMentionedWallets finds valid G-address mentions")
}

async function testExtractMentionsNoDuplicates() {
  const text = `@${WALLET_A} @${WALLET_A}`
  const mentions = extractMentionedWallets(text)
  assert.deepEqual(mentions, [WALLET_A])
  console.log("✓ duplicate mentions deduped")
}

async function testFlagDisabledBlocksSubscribe() {
  delete process.env.NEXT_PUBLIC_FEATURE_PHASE_92
  delete process.env.FEATURE_PHASE_92
  let threw = false
  try {
    await subscribeToPush({ wallet: WALLET_A, endpoint: "https://push.example.com/ep2", keys: { p256dh: "k", auth: "a" } })
  } catch (e) {
    threw = e instanceof PushNotificationError && e.code === "FLAG_DISABLED"
  }
  assert.equal(threw, true)
  process.env.NEXT_PUBLIC_FEATURE_PHASE_92 = "1"
  process.env.FEATURE_PHASE_92 = "1"
  console.log("✓ subscribe blocked when phase-92 flag disabled")
}

async function run() {
  await testFlagEnabled()
  await testSubscribeAndList()
  await testDedupeByEndpoint()
  await testUnsubscribe()
  await testUnsubscribeNotFound()
  await testExtractMentions()
  await testExtractMentionsNoDuplicates()
  await testFlagDisabledBlocksSubscribe()
  console.log("\nAll push-notifications (phase-92) tests passed.")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
