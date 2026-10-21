"use client"
import { useState, type ReactNode } from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { useLang } from "@/components/lang-context"
import { pickCopy } from "@/lib/phase-copy"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"

export function MobileControls({ children }: { children: ReactNode }) {
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const { lang } = useLang()
  const copy = pickCopy(lang).integrations
  if (!isFeatureEnabled("phase-174") || !mobile) return children
  return <div className="relative z-[110] px-3 py-2">
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><button type="button" className="min-h-11 w-full rounded border border-zinc-600 px-4 text-sm">{copy.mobileControls}</button></SheetTrigger>
      <SheetContent layer={600} side="bottom" closeLabel={copy.cancel} className="phase-mobile-sheet max-h-[85dvh] overflow-y-auto p-4 pb-[max(16px,env(safe-area-inset-bottom))]">
        <SheetTitle>{copy.mobileControls}</SheetTitle>
        <SheetDescription>{copy.reviewLinkHint}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  </div>
}
