import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { after, beforeEach, describe, it } from "node:test"
import {
  dispatchPushNotification,
  getPushSubscriptions,
  isPhase252Enabled,
  pruneStalePushSubscriptions,
  subscribeToPush,
} from "@/lib/push-notifications"
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters"
import { resetWebhookAlertStateForTests, sendWebhookAlert } from "@/lib/webhook-alerts"

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_FETCH = globalThis.fetch

const WALLET_A = "GA" + "A".repeat(54)

describe("push-notifications + webhook-alerts (phase-252 / #703)", () => {
  beforeEach(() => {
    process.env.PHASE_SERVER_DATA_DIR = path.join(
      os.tmpdir(),
      `phase-push-252-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    process.env.NEXT_PUBLIC_FEATURE_PHASE_92 = "1"
    process.env.FEATURE_PHASE_92 = "1"
    process.env.NEXT_PUBLIC_FEATURE_PHASE_252 = "1"
    process.env.FEATURE_PHASE_252 = "1"
    resetSecurityCounters()
    resetWebhookAlertStateForTests()
  })

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH
    process.env = { ...ORIGINAL_ENV }
  })

  it("persists concurrent burst subscriptions with per-wallet dedupe keys without losing writes", async () => {
    assert.equal(isPhase252Enabled(), true)

    await Promise.all([
      subscribeToPush({
        wallet: WALLET_A,
        endpoint: "https://push.example.com/ep1",
        keys: { p256dh: "k1", auth: "a1" },
      }),
      subscribeToPush({
        wallet: WALLET_A,
        endpoint: "https://push.example.com/ep2",
        keys: { p256dh: "k2", auth: "a2" },
      }),
      subscribeToPush({
        wallet: WALLET_A,
        endpoint: "https://push.example.com/ep1",
        keys: { p256dh: "k1-latest", auth: "a1" },
      }),
    ])

    const subs = await getPushSubscriptions(WALLET_A)
    assert.equal(subs.length, 2)
    assert.ok(subs.every((s) => typeof s.dedupeKey === "string" && s.dedupeKey.length === 64))
  })

  it("burst dispatch produces exactly one notification per event", async () => {
    await subscribeToPush({
      wallet: WALLET_A,
      endpoint: "https://push.example.com/burst",
      keys: { p256dh: "k1", auth: "a1" },
    })

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount++
      return new Response("ok", { status: 200 })
    }) as typeof fetch

    const burst = await Promise.all(
      Array.from({ length: 20 }, () =>
        dispatchPushNotification(
          WALLET_A,
          "mention",
          { signalId: "sig_1" },
          { eventId: "evt_burst_1" },
        ),
      ),
    )

    assert.equal(fetchCount, 1)
    assert.equal(burst.filter((r) => r.length === 1 && r[0]?.ok).length, 1)
    assert.equal(getSecurityCounter("push_notifications_dispatched"), 1)
    assert.equal(getSecurityCounter("push_notifications_deduped"), 19)
  })

  it("circuit-breaks failing endpoints and prunes stale/410 subscriptions", async () => {
    await subscribeToPush({
      wallet: WALLET_A,
      endpoint: "https://push.example.com/flaky",
      keys: { p256dh: "k1", auth: "a1" },
    })

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount++
      return new Response("err", { status: 500 })
    }) as typeof fetch

    for (let i = 0; i < 3; i++) {
      await dispatchPushNotification(WALLET_A, "signal_reply", { n: i }, { eventId: `evt_fail_${i}` })
    }
    assert.equal(fetchCount, 3)
    assert.equal(getSecurityCounter("push_circuit_breaker_opened"), 1)

    // 4th dispatch should skip fetch because circuit is open
    const skipped = await dispatchPushNotification(
      WALLET_A,
      "signal_reply",
      { n: 99 },
      { eventId: "evt_fail_99" },
    )
    assert.equal(fetchCount, 3)
    assert.equal(skipped[0]?.skipped, true)
    assert.equal(skipped[0]?.error, "circuit_open")

    // 410 Gone prunes subscription immediately
    await subscribeToPush({
      wallet: WALLET_A,
      endpoint: "https://push.example.com/gone",
      keys: { p256dh: "k2", auth: "a2" },
    })
    globalThis.fetch = (async () => new Response("gone", { status: 410 })) as typeof fetch
    await dispatchPushNotification(WALLET_A, "mention", { g: 1 }, { eventId: "evt_gone" })

    const remaining = await getPushSubscriptions(WALLET_A)
    assert.equal(remaining.some((s) => s.endpoint === "https://push.example.com/gone"), false)
    assert.ok(getSecurityCounter("push_subscriptions_pruned") >= 1)

    // Stale age pruning
    const pruned = await pruneStalePushSubscriptions(0, Date.now() + 1000)
    assert.ok(pruned >= 1)
  })

  it("circuit-breaks failing webhook alert channels and emits closed counters", async () => {
    process.env.GENERIC_WEBHOOK_URL = "https://hooks.example.com/alert"
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("fail", { status: 500 })
    }) as typeof fetch

    await sendWebhookAlert("critical", { title: "Alert 1", message: "m1" })
    await sendWebhookAlert("critical", { title: "Alert 2", message: "m2" })
    await sendWebhookAlert("critical", { title: "Alert 3", message: "m3" })
    assert.equal(calls, 3)
    assert.equal(getSecurityCounter("webhook_alerts_circuit_broken"), 1)

    // 4th alert is short-circuited without calling fetch
    await sendWebhookAlert("critical", { title: "Alert 4", message: "m4" })
    assert.equal(calls, 3)
  })
})
