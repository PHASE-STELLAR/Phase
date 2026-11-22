/**
 * Webhook Alert System for Distributor Health Monitoring
 * 
 * Sends alerts to configured webhooks (Discord, Telegram, Slack, generic)
 * when distributor or issuer balances are low or operations fail.
 * 
 * Environment variables:
 * - DISCORD_WEBHOOK_URL
 * - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 * - SLACK_WEBHOOK_URL
 * - GENERIC_WEBHOOK_URL
 */

import { isFeatureEnabled } from "@/lib/feature-flags"
import { incSecurityCounter } from "@/lib/security-counters"

export type WebhookAlertType = "info" | "warning" | "critical"

const WEBHOOK_CIRCUIT_THRESHOLD = 3
const WEBHOOK_CIRCUIT_OPEN_MS = 5 * 60 * 1000
const channelCircuitState = new Map<string, { failures: number; openUntil: number }>()

function isWebhookCircuitOpen(service: string, now: number): boolean {
  const st = channelCircuitState.get(service)
  return Boolean(st && st.openUntil > now)
}

function recordWebhookChannelOutcome(service: string, ok: boolean, now: number): void {
  if (ok) {
    channelCircuitState.set(service, { failures: 0, openUntil: 0 })
    incSecurityCounter("webhook_alerts_dispatched")
    return
  }
  const prev = channelCircuitState.get(service) ?? { failures: 0, openUntil: 0 }
  const failures = prev.failures + 1
  const openUntil = failures >= WEBHOOK_CIRCUIT_THRESHOLD ? now + WEBHOOK_CIRCUIT_OPEN_MS : 0
  if (openUntil > now && prev.openUntil <= now) {
    incSecurityCounter("webhook_alerts_circuit_broken")
  }
  channelCircuitState.set(service, { failures, openUntil })
}

export function resetWebhookAlertStateForTests(): void {
  recentAlerts.clear()
  channelCircuitState.clear()
}

// Suppresses repeat sends of the same alert (by type+title) within this
// window so a persistently unhealthy check can't spam webhooks on every
// cron tick.
const ALERT_DEDUP_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const recentAlerts = new Map<string, number>()

function shouldSuppressAlert(type: WebhookAlertType, title: string): boolean {
  const key = `${type}:${title}`
  const now = Date.now()
  const lastSent = recentAlerts.get(key)

  if (lastSent && now - lastSent < ALERT_DEDUP_WINDOW_MS) {
    return true
  }

  recentAlerts.set(key, now)
  // Bound the map so it can't grow unboundedly across process lifetime.
  if (recentAlerts.size > 200) {
    const oldestKey = recentAlerts.keys().next().value
    if (oldestKey !== undefined) recentAlerts.delete(oldestKey)
  }

  return false
}

export interface WebhookAlertPayload {
  title: string
  message: string
  [key: string]: unknown
}

interface DiscordEmbed {
  title: string
  description: string
  color: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  timestamp: string
}

function getAlertColor(type: WebhookAlertType): number {
  switch (type) {
    case "info": return 0x00ff00      // Green
    case "warning": return 0xffa500   // Orange
    case "critical": return 0xff0000  // Red
  }
}

function getAlertEmoji(type: WebhookAlertType): string {
  switch (type) {
    case "info": return "✅"
    case "warning": return "🟠"
    case "critical": return "🔴"
  }
}

async function sendDiscordWebhook(type: WebhookAlertType, payload: WebhookAlertPayload): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim()
  if (!webhookUrl) return false

  const fields: Array<{ name: string; value: string; inline?: boolean }> = []
  
  for (const [key, value] of Object.entries(payload)) {
    if (key === "title" || key === "message") continue
    if (value !== null && value !== undefined) {
      fields.push({
        name: key.replace(/([A-Z])/g, " $1").trim(),
        value: String(value),
        inline: true,
      })
    }
  }

  const embed: DiscordEmbed = {
    title: `${getAlertEmoji(type)} ${payload.title}`,
    description: payload.message,
    color: getAlertColor(type),
    timestamp: new Date().toISOString(),
  }

  if (fields.length > 0) {
    embed.fields = fields
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Phase Faucet Monitor",
        embeds: [embed],
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function sendTelegramWebhook(type: WebhookAlertType, payload: WebhookAlertPayload): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  
  if (!botToken || !chatId) return false

  let text = `${getAlertEmoji(type)} *${escapeMarkdown(payload.title)}*\n\n${escapeMarkdown(payload.message)}`

  const fields: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (key === "title" || key === "message") continue
    if (value !== null && value !== undefined) {
      const fieldName = key.replace(/([A-Z])/g, " $1").trim()
      fields.push(`*${escapeMarkdown(fieldName)}:* ${escapeMarkdown(String(value))}`)
    }
  }

  if (fields.length > 0) {
    text += "\n\n" + fields.join("\n")
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1")
}

async function sendSlackWebhook(type: WebhookAlertType, payload: WebhookAlertPayload): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim()
  if (!webhookUrl) return false

  const fields: Array<{ title: string; value: string; short: boolean }> = []
  
  for (const [key, value] of Object.entries(payload)) {
    if (key === "title" || key === "message") continue
    if (value !== null && value !== undefined) {
      fields.push({
        title: key.replace(/([A-Z])/g, " $1").trim(),
        value: String(value),
        short: true,
      })
    }
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Phase Faucet Monitor",
        icon_emoji: getAlertEmoji(type),
        attachments: [
          {
            color: type === "critical" ? "danger" : type === "warning" ? "warning" : "good",
            title: payload.title,
            text: payload.message,
            fields: fields.length > 0 ? fields : undefined,
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function sendGenericWebhook(type: WebhookAlertType, payload: WebhookAlertPayload): Promise<boolean> {
  const webhookUrl = process.env.GENERIC_WEBHOOK_URL?.trim()
  if (!webhookUrl) return false

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Send alert to all configured webhooks
 */
export async function sendWebhookAlert(
  type: WebhookAlertType,
  payload: WebhookAlertPayload
): Promise<{ sent: string[]; failed: string[] }> {
  const phase252 = isFeatureEnabled("phase-252")
  if (shouldSuppressAlert(type, payload.title)) {
    if (phase252) incSecurityCounter("webhook_alerts_deduped")
    return { sent: [], failed: [] }
  }

  const now = Date.now()
  const channels: Array<{
    service: string
    configured: boolean
    send: () => Promise<boolean>
  }> = [
    {
      service: "discord",
      configured: Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
      send: () => sendDiscordWebhook(type, payload),
    },
    {
      service: "telegram",
      configured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
      send: () => sendTelegramWebhook(type, payload),
    },
    {
      service: "slack",
      configured: Boolean(process.env.SLACK_WEBHOOK_URL?.trim()),
      send: () => sendSlackWebhook(type, payload),
    },
    {
      service: "generic",
      configured: Boolean(process.env.GENERIC_WEBHOOK_URL?.trim()),
      send: () => sendGenericWebhook(type, payload),
    },
  ]

  if (phase252) {
    const sent: string[] = []
    const failed: string[] = []
    const settled = await Promise.allSettled(
      channels.map(async (ch) => {
        if (!ch.configured) return { service: ch.service, status: "unconfigured" as const }
        if (isWebhookCircuitOpen(ch.service, now)) {
          return { service: ch.service, status: "circuit_open" as const }
        }
        const ok = await ch.send()
        recordWebhookChannelOutcome(ch.service, ok, now)
        return { service: ch.service, status: ok ? ("sent" as const) : ("failed" as const) }
      }),
    )
    for (const r of settled) {
      if (r.status === "fulfilled") {
        if (r.value.status === "sent") sent.push(r.value.service)
        else if (r.value.status === "failed" || r.value.status === "circuit_open") failed.push(r.value.service)
      } else {
        failed.push("unknown")
      }
    }
    return { sent, failed }
  }

  const results = await Promise.allSettled([
    sendDiscordWebhook(type, payload).then(ok => ({ service: "discord", ok })),
    sendTelegramWebhook(type, payload).then(ok => ({ service: "telegram", ok })),
    sendSlackWebhook(type, payload).then(ok => ({ service: "slack", ok })),
    sendGenericWebhook(type, payload).then(ok => ({ service: "generic", ok })),
  ])

  const sent: string[] = []
  const failed: string[] = []

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.ok) {
      sent.push(result.value.service)
    } else if (result.status === "fulfilled" && !result.value.ok) {
      // Webhook not configured or failed silently
    } else if (result.status === "rejected") {
      failed.push("unknown")
    }
  }

  return { sent, failed }
}

/**
 * Test webhook configuration by sending a test message
 */
export async function testWebhooks(): Promise<{ sent: string[]; failed: string[] }> {
  return sendWebhookAlert("info", {
    title: "Webhook Test",
    message: "This is a test message from Phase Faucet Monitor. If you see this, your webhook is configured correctly!",
    timestamp: new Date().toISOString(),
  })
}
