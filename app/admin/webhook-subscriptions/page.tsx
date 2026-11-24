import type { Metadata } from "next"
import { SubscriptionRedeliveryPanel } from "@/components/admin/subscription-redelivery-panel"

export const metadata: Metadata = {
  title: "Webhook subscriptions",
  robots: { index: false, follow: false },
}

/** phase-215 admin surface. All API calls are flag-gated (404 when off). */
export default function AdminWebhookSubscriptionsPage() {
  return (
    <main className="mx-auto max-w-4xl">
      <SubscriptionRedeliveryPanel />
    </main>
  )
}
