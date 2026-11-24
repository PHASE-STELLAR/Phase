import { notFound } from "next/navigation"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { LinkEntryForm } from "@/components/link-entry-form"
export default function LinkPage() {
  if (!isFeatureEnabled("phase-175")) notFound()
  return <LinkEntryForm />
}
