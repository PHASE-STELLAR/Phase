import { TokenIcon } from "@/components/token-icon"
import { cn } from "@/lib/utils"

export function PhaserLiqTokenLink({
  href,
  symbol,
  className,
  iconClassName,
}: {
  href: string
  symbol: string
  className?: string
  /** Optional icon size override for dense terminal rows. */
  iconClassName?: string
}) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={cn("inline-flex min-h-11 items-center gap-2 underline-offset-4 hover:underline", className)}>
    <TokenIcon className={cn("h-4 w-4", iconClassName)} />{symbol}
  </a>
}
