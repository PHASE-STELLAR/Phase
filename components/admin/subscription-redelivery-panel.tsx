"use client"

/**
 * phase-215 — admin panel for subscription delivery log + on-demand replay.
 * The admin token is kept in component state and sent as a Bearer header; it
 * is never persisted or logged. Secrets are never returned by the API.
 */

import { useCallback, useState } from "react"
import { useLang } from "@/components/lang-context"
import { pickAdminWebhooksCopy } from "@/lib/phase-copy"

type Subscription = {
  id: string
  url: string
  events: string[]
  active: boolean
  secretPreview: string
  consecutiveFailures: number
}

type Delivery = {
  id: string
  eventId: string
  event: string
  subscriptionId: string
  endpoint: string
  status: string
  httpStatus: number | null
  reason?: string
  at: number
}

export function SubscriptionRedeliveryPanel() {
  const { lang } = useLang()
  const copy = (key: string) => pickAdminWebhooksCopy(lang, key)
  const [token, setToken] = useState("")
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [disabled, setDisabled] = useState(false)

  const load = useCallback(async () => {
    setMessage(null)
    const headers = { authorization: `Bearer ${token}` }
    const [subsRes, logRes] = await Promise.all([
      fetch("/api/admin/webhook-subscriptions", { headers, cache: "no-store" }),
      fetch("/api/admin/webhook-deliveries", { headers, cache: "no-store" }),
    ])
    if (subsRes.status === 404 || logRes.status === 404) {
      setDisabled(true)
      return
    }
    setDisabled(false)
    if (!subsRes.ok || !logRes.ok) {
      setMessage(copy("failed"))
      return
    }
    const subs = await subsRes.json()
    const log = await logRes.json()
    setSubscriptions(subs.subscriptions ?? [])
    setDeliveries(log.deliveries ?? [])
  }, [token, lang])

  const redeliver = useCallback(async (subscriptionId: string, deliveryId: string) => {
    const res = await fetch(`/api/admin/webhook-subscriptions/${encodeURIComponent(subscriptionId)}/redeliver`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ deliveryId }),
    })
    setMessage(res.ok ? copy("redelivered") : copy("failed"))
    if (res.ok) await load()
  }, [token, load, lang])

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{copy("title")}</h1>
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={copy("tokenLabel")}
          aria-label={copy("tokenLabel")}
          className="rounded border bg-background px-3 py-2"
        />
        <button type="button" onClick={load} className="rounded border px-3 py-2">
          {copy("load")}
        </button>
      </div>

      {disabled ? <p role="status">{copy("disabled")}</p> : null}
      {message ? <p role="status">{message}</p> : null}

      {subscriptions.length === 0 ? (
        <p>{copy("noSubscriptions")}</p>
      ) : (
        <ul className="space-y-2">
          {subscriptions.map((subscription) => (
            <li key={subscription.id} className="rounded border p-3">
              <div className="font-mono text-xs">
                {(() => {
                  try {
                    const url = new URL(subscription.url)
                    return `${url.origin}${url.pathname}`
                  } catch {
                    return "invalid-endpoint"
                  }
                })()}
              </div>
              <div className="text-xs">
                {copy("events")}: {subscription.events.join(", ")} · {copy("status")}: {subscription.active ? "OK" : "OFF"}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-lg font-semibold">{copy("deliveries")}</h2>
      {deliveries.length === 0 ? (
        <p>{copy("emptyLog")}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th>{copy("status")}</th>
              <th>{copy("events")}</th>
              <th>{copy("endpoint")}</th>
              <th>{copy("deliveries")}</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td>{delivery.status}{delivery.reason ? ` (${delivery.reason})` : ""}</td>
                <td>{delivery.event}</td>
                <td className="font-mono">{delivery.endpoint}</td>
                <td>
                  <button type="button" onClick={() => redeliver(delivery.subscriptionId, delivery.id)}>
                    {copy("redeliver")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
