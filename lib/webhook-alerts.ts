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

export type WebhookAlertType = "info" | "warning" | "critical"

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
  if (shouldSuppressAlert(type, payload.title)) {
    return { sent: [], failed: [] }
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
