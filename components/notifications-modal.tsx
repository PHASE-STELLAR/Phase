"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useWallet } from "@/components/wallet-provider"
import { useLang } from "@/components/lang-context"

type NotificationType =
  | "mint_in_collection"
  | "narrator_generated"
  | "new_follower"
  | "signal_reply"
  | "signal_upvote"
  | "quest_completed"
  | "world_mint"
  | "new_offer"
  | "offer_accepted"
  | "offer_rejected"
  | "achievement_unlocked"
  | "content_takedown"

type Notification = {
  id: string
  wallet: string
  type: NotificationType
  read: boolean
  created_at: number
  data: Record<string, unknown>
}

type NotificationPreferences = {
  enabled: boolean
  types: Partial<Record<NotificationType, boolean>>
  updated_at: number
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  types: {},
  updated_at: 0,
}

const PREFERENCE_TYPES: NotificationType[] = [
  "new_follower",
  "signal_reply",
  "signal_upvote",
  "new_offer",
  "achievement_unlocked",
  "content_takedown",
]

const POLL_INTERVAL_MS = 30_000

type ClaimFunnelSummary = {
  totalEvents: number
  overallConversion: number
  stages: { stage: string; uniqueSubjects: number; conversionFromPrev: number | null }[]
}

const copy = {
  en: {
    title: "◆ NOTIFICATIONS",
    markAll: "[ MARK ALL READ ]",
    empty: "[ NO_NOTIFICATIONS ]",
    emptyDesc: "Nothing here yet — activity will appear as you interact.",
    viewAll: "[ VIEW_ALL ]",
    unread: "unread",
    preferences: "Preferences",
    all: "All notifications",
  },
  es: {
    title: "◆ NOTIFICACIONES",
    markAll: "[ MARCAR TODO LEÍDO ]",
    empty: "[ SIN_NOTIFICACIONES ]",
    emptyDesc: "Aún no hay nada — la actividad aparecerá conforme interactúas.",
    viewAll: "[ VER_TODO ]",
    unread: "sin leer",
    preferences: "Preferencias",
    all: "Todas las notificaciones",
  },
}

function notifText(n: Notification, lang: string): { text: string; url: string } {
  const d = n.data
  const es = lang === "es"
  switch (n.type) {
    case "mint_in_collection":
      return {
        text: es
          ? `Alguien minteó en tu colección #${String(d.collection_id ?? "")}`
          : `Someone minted in your collection #${String(d.collection_id ?? "")}`,
        url: `/dashboard`,
      }
    case "narrator_generated":
      return {
        text: es
          ? `El narrador tejió una nueva conexión en ${String(d.world_name ?? "tu mundo")}`
          : `The narrator wove a new connection in ${String(d.world_name ?? "your world")}`,
        url: `/world`,
      }
    case "new_follower":
      return {
        text: es
          ? `${String(d.from_name ?? "Alguien")} empezó a seguirte`
          : `${String(d.from_name ?? "Someone")} started following you`,
        url: d.from_wallet ? `/profile/${String(d.from_wallet)}` : `/profile`,
      }
    case "signal_reply":
      return {
        text: es
          ? `${String(d.reply_author_name ?? "Alguien")} respondió tu señal`
          : `${String(d.reply_author_name ?? "Someone")} replied to your signal`,
        url: d.signal_id ? `/signals/${String(d.signal_id)}` : `/signals`,
      }
    case "signal_upvote":
      return {
        text: es
          ? `Tu señal alcanzó ${String(d.upvote_count ?? "")} votos`
          : `Your signal reached ${String(d.upvote_count ?? "")} upvotes`,
        url: d.signal_id ? `/signals/${String(d.signal_id)}` : `/signals`,
      }
    case "quest_completed":
      return {
        text: es
          ? `Quest completada: ${String(d.quest_name ?? "")} +${String(d.amount ?? "")} PHASELQ`
          : `Quest completed: ${String(d.quest_name ?? "")} +${String(d.amount ?? "")} PHASELQ`,
        url: `/faucet`,
      }
    case "world_mint":
      return {
        text: es
          ? `Nuevo artefacto minteado en ${String(d.world_name ?? "un mundo")}`
          : `New artifact minted in ${String(d.world_name ?? "a world")}`,
        url: `/world`,
      }
    case "new_offer":
      return {
        text: es
          ? `Nueva oferta de ${String(d.amount ?? "")} PHASELQ en tu listing`
          : `New offer of ${String(d.amount ?? "")} PHASELQ on your listing`,
        url: `/dashboard`,
      }
    case "offer_accepted":
      return {
        text: es ? "Tu oferta fue aceptada" : "Your offer was accepted",
        url: `/dashboard`,
      }
    case "offer_rejected":
      return {
        text: es ? "Tu oferta fue rechazada" : "Your offer was rejected",
        url: `/dashboard`,
      }
    case "achievement_unlocked":
      return {
        text: es
          ? `Logro desbloqueado: ${String(d.achievement_name ?? "")}`
          : `Achievement unlocked: ${String(d.achievement_name ?? "")}`,
        url: `/profile`,
      }
    case "content_takedown":
      return {
        text: es
          ? `Tu señal "${String(d.signal_title ?? "")}" fue retirada: ${String(d.reason ?? "")}`
          : `Your signal "${String(d.signal_title ?? "")}" was taken down: ${String(d.reason ?? "")}`,
        url: `/signals`,
      }
    default:
      return { text: es ? "Nueva actividad" : "New activity", url: "/" }
  }
}

const NOTIF_LABELS: Record<NotificationType, { en: string; es: string }> = {
  mint_in_collection: { en: "Collection mints", es: "Mints de coleccion" },
  narrator_generated: { en: "Narrator updates", es: "Actualizaciones del narrador" },
  new_follower: { en: "New followers", es: "Nuevos seguidores" },
  signal_reply: { en: "Signal replies", es: "Respuestas a senales" },
  signal_upvote: { en: "Signal upvotes", es: "Votos de senales" },
  quest_completed: { en: "Quest rewards", es: "Recompensas de quests" },
  world_mint: { en: "World mints", es: "Mints de mundo" },
  new_offer: { en: "New offers", es: "Nuevas ofertas" },
  offer_accepted: { en: "Accepted offers", es: "Ofertas aceptadas" },
  offer_rejected: { en: "Rejected offers", es: "Ofertas rechazadas" },
  achievement_unlocked: { en: "Achievements", es: "Logros" },
  content_takedown: { en: "Moderation", es: "Moderacion" },
}

const NOTIF_ICONS: Record<NotificationType, string> = {
  mint_in_collection: "◈",
  narrator_generated: "◆",
  new_follower: "◉",
  signal_reply: "▸",
  signal_upvote: "▲",
  quest_completed: "✓",
  world_mint: "◆",
  new_offer: "◎",
  offer_accepted: "✓",
  offer_rejected: "✕",
  achievement_unlocked: "★",
  content_takedown: "⚠",
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (d > 0) return `${d}d`
  if (h > 0) return `${h}h`
  return `${m}m`
}

export function NotificationsModal() {
  const { address } = useWallet()
  const { lang } = useLang()
  const router = useRouter()
  const t = copy[lang] ?? copy.en

  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES)
  // module #53 (phase-53): compact faucet claim-funnel readout, operator-facing, flag-gated.
  const [funnel, setFunnel] = useState<ClaimFunnelSummary | null>(null)

  const fetchNotifications = useCallback(async () => {
    if (!address) return
    try {
      const res = await fetch(`/api/notifications?wallet=${encodeURIComponent(address)}`)
      if (!res.ok) return
      const data = (await res.json()) as {
        notifications: Notification[]
        unread_count: number
        preferences?: NotificationPreferences
        gateway_auth_rotation_feature_enabled?: boolean
        faucet_analytics_feature_enabled?: boolean
      }
      setNotifications(data.notifications)
      setUnreadCount(data.unread_count)
      setPreferences(data.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES)

      if (data.faucet_analytics_feature_enabled) {
        try {
          const funnelRes = await fetch(`/api/notifications?funnel=1`)
          if (funnelRes.ok) {
            const funnelData = (await funnelRes.json()) as { funnel?: ClaimFunnelSummary }
            setFunnel(funnelData.funnel ?? null)
          }
        } catch { /* silent */ }
      } else {
        setFunnel(null)
      }
    } catch { /* silent */ }
  }, [address])

  // Listen for open event
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener("open-notifications", handler)
    return () => window.removeEventListener("open-notifications", handler)
  }, [])

  // Initial fetch + poll
  useEffect(() => {
    if (!address) return
    void fetchNotifications()
    const timer = setInterval(() => void fetchNotifications(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [address, fetchNotifications])

  async function savePreferences(next: NotificationPreferences) {
    if (!address) return
    setPreferences(next)
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, action: "update_preferences", preferences: next }),
      })
    } catch { /* silent */ }
  }

  function togglePreference(type: NotificationType) {
    const next: NotificationPreferences = {
      ...preferences,
      types: {
        ...preferences.types,
        [type]: !(preferences.types[type] ?? true),
      },
    }
    void savePreferences(next)
  }

  function toggleAllPreferences() {
    void savePreferences({ ...preferences, enabled: !preferences.enabled })
  }
  async function handleMarkAll() {
    if (!address) return
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, action: "mark_read" }),
      })
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch { /* silent */ }
  }

  async function handleClickNotif(n: Notification) {
    const { url } = notifText(n, lang)
    if (!n.read && address) {
      try {
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: address, action: "mark_read", id: n.id }),
        })
        setNotifications((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
        )
        setUnreadCount((c) => Math.max(0, c - 1))
      } catch { /* silent */ }
    }
    setOpen(false)
    router.push(url)
  }

  // Expose unread count for floating header
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("notif-unread-count", { detail: unreadCount }))
  }, [unreadCount])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="w-[min(100vw,420px)] flex flex-col gap-0 p-0 border border-violet-800/30 bg-[#0a0a0f] text-zinc-100 max-h-[80vh]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <DialogTitle className="sr-only">{t.title}</DialogTitle>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-violet-800/20">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-violet-400">
              {t.title}
            </span>
            {unreadCount > 0 && (
              <span
                className="rounded-full px-1.5 py-0.5 font-mono text-[8px] font-bold"
                style={{ background: "#7c3aed", color: "#fff" }}
              >
                {unreadCount}
              </span>
            )}
          </div>
          {notifications.some((n) => !n.read) && (
            <button
              type="button"
              onClick={() => void handleMarkAll()}
              className="font-mono text-[8px] uppercase tracking-widest text-zinc-600 hover:text-violet-400 transition-colors"
            >
              {t.markAll}
            </button>
          )}
        </div>

        {/* Preferences */}
        <div className="border-b border-violet-800/20 px-5 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-violet-400/80">
              {t.preferences}
            </span>
            <label className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-zinc-500">
              <input
                type="checkbox"
                checked={preferences.enabled}
                onChange={toggleAllPreferences}
                className="h-3 w-3 accent-violet-500"
              />
              {t.all}
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {PREFERENCE_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 font-mono text-[9px] text-zinc-500">
                <input
                  type="checkbox"
                  checked={preferences.types[type] ?? true}
                  disabled={!preferences.enabled}
                  onChange={() => togglePreference(type)}
                  className="h-3 w-3 accent-violet-500 disabled:opacity-50"
                />
                {NOTIF_LABELS[type][lang]}
              </label>
            ))}
          </div>
        </div>

        {/* Faucet claim funnel — module #53 (phase-53), operator readout */}
        {funnel && funnel.stages.length > 0 && (
          <div className="border-b border-violet-800/20 px-5 py-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-violet-400/80">
                {lang === "es" ? "Embudo de claims" : "Claim funnel"}
              </span>
              <span className="font-mono text-[8px] uppercase tracking-widest text-zinc-600">
                {Math.round(funnel.overallConversion * 100)}% · {funnel.totalEvents} ev
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {funnel.stages.map((s) => (
                <div key={s.stage} className="flex items-center justify-between font-mono text-[9px] text-zinc-500">
                  <span>{s.stage}</span>
                  <span className="text-zinc-600">
                    {s.uniqueSubjects}
                    {s.conversionFromPrev != null ? ` · ${Math.round(s.conversionFromPrev * 100)}%` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 px-5">
              <span className="font-mono text-[10px] text-zinc-600">{t.empty}</span>
              <span className="font-mono text-[9px] text-zinc-700 text-center">{t.emptyDesc}</span>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-zinc-800/50">
              {notifications.map((n) => {
                const { text } = notifText(n, lang)
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => void handleClickNotif(n)}
                    className="flex items-start gap-3 px-5 py-3 text-left hover:bg-violet-950/20 transition-colors"
                  >
                    {/* Dot */}
                    <span
                      className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: n.read ? "transparent" : "#7c3aed" }}
                    />
                    {/* Icon */}
                    <span className="shrink-0 font-mono text-[13px] text-violet-400 leading-none mt-0.5">
                      {NOTIF_ICONS[n.type] ?? "◉"}
                    </span>
                    {/* Content */}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={`font-mono text-[10px] leading-snug ${n.read ? "text-zinc-500" : "text-zinc-200"}`}
                      >
                        {text}
                      </span>
                      <span className="font-mono text-[8px] text-zinc-700">
                        {timeAgo(n.created_at)}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Export unread count hook for FloatingHeader
export function useNotifUnreadCount(address: string | null): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<number>
      setCount(ce.detail)
    }
    window.addEventListener("notif-unread-count", handler)
    return () => window.removeEventListener("notif-unread-count", handler)
  }, [])

  // Initial fetch
  useEffect(() => {
    if (!address) { setCount(0); return }
    fetch(`/api/notifications?wallet=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((d: { unread_count?: number }) => setCount(d.unread_count ?? 0))
      .catch(() => { /* silent */ })
  }, [address])

  return count
}
