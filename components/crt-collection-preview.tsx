"use client"

import Link from "next/link"
import { useToastQueue } from "@/hooks/use-toast-queue"

type Attribute = {
  trait_type: string
  value: string | number
  display_type?: "number"
}

type Props = {
  tokenId: number
  name: string
  description: string
  image: string
  attributes: Attribute[]
  collectionId: number | null
  owner: string | null
  contentHash?: string
  duplicateOfTokenId?: number
  // module #52 (phase-52): quest_expiry lifecycle state for this artifact's quest, when known.
  questExpiryState?: "active" | "grace" | "expired"
}

const SCANLINES = {
  background:
    "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.07) 2px, rgba(0,0,0,0.07) 4px)",
} as const

const VIGNETTE = {
  background:
    "radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(0,0,0,0.72) 100%)",
} as const

const PHOSPHOR_GLOW = {
  background:
    "radial-gradient(ellipse at 50% 42%, rgba(88,28,135,0.06) 0%, transparent 65%)",
} as const

const CARD_GLOW = {
  border: "1px solid rgba(139,92,246,0.75)",
  boxShadow:
    "0 0 18px rgba(139,92,246,0.65), 0 0 40px rgba(139,92,246,0.32), 0 0 80px rgba(139,92,246,0.15), inset 0 0 24px rgba(139,92,246,0.07)",
} as const

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function parseCollectionName(name: string): string {
  return name.replace(/ Artifact #\d+$/, "")
}

export function CrtCollectionPreview({
  tokenId,
  name,
  description,
  image,
  attributes,
  collectionId,
  owner,
  contentHash,
  duplicateOfTokenId,
  questExpiryState,
}: Props) {
  const collectionName = parseCollectionName(name)
  const creatorDisplay = owner ? truncateAddress(owner) : "UNKNOWN"
  const toasts = useToastQueue()

  if (duplicateOfTokenId) {
    // Queued + deduped (priority warn) so duplicate notices never clobber
    // concurrent preview navigation messages.
    toasts.warn(`DUPLICATE_OF_#${duplicateOfTokenId}`, { title: `PHASE · ${collectionName}` })
  }

  if (questExpiryState === "grace") {
    // module #52 (phase-52): grace-window notice, queued/deduped like the duplicate warning.
    toasts.warn("QUEST_IN_GRACE_PERIOD", { title: `PHASE · ${collectionName}` })
  }

  const displayAttrs = attributes.filter(
    (a) => !["token_id", "collection_id"].includes(a.trait_type),
  )

  return (
    <div
      className="relative w-full min-h-dvh overflow-hidden font-mono"
      style={{ backgroundColor: "#050508" }}
    >
      {/* — CRT layers (pointer-events: none, non-interactive) — */}
      <div className="absolute inset-0 z-20 pointer-events-none" style={PHOSPHOR_GLOW} />
      <div className="absolute inset-0 z-20 pointer-events-none" style={SCANLINES} />
      <div className="absolute inset-0 z-20 pointer-events-none" style={VIGNETTE} />
      {/* Grain */}
      <div
        className="absolute inset-0 z-20 pointer-events-none opacity-[0.045]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "256px 256px",
        }}
      />

      {/* — Main content — */}
      <div className="relative z-30 flex flex-col min-h-dvh px-6 py-7 md:px-10 md:py-8">

        {/* Header */}
        <header className="flex items-start justify-between">
          <div className="space-y-0.5">
            <p className="text-[10px] tracking-[0.22em] uppercase text-purple-300/70">
              PHASE: {collectionName}
            </p>
            <p className="text-[10px] tracking-[0.22em] uppercase text-purple-400/50">
              PROTOCOL: ARCHIVE_PREVIEW
            </p>
          </div>
          <p className="text-[10px] tracking-[0.28em] uppercase text-purple-300/70">
            COLLECTION PREVIEW
          </p>
        </header>

        <div className="mt-5 h-px w-full bg-purple-500/10" />

        {/* NFT card — centrado */}
        <section className="flex flex-1 flex-col items-center justify-center gap-3 py-10">
          <span className="text-[9px] tracking-[0.35em] uppercase text-purple-400/45 mb-1">
            // NOW VIEWING
          </span>

          {/* Image frame with neon glow */}
          <div
            className="relative w-56 h-56 md:w-72 md:h-72 overflow-hidden"
            style={CARD_GLOW}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt={name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-purple-950/10">
                <span className="text-[10px] tracking-widest text-purple-300/30 uppercase">
                  NO_IMAGE_DATA
                </span>
              </div>
            )}
          </div>

          <span className="text-[9px] tracking-[0.35em] uppercase text-purple-400/45 mt-1">
            // PREVIEWING ARCHIVE DATA
          </span>
        </section>

        <div className="h-px w-full bg-purple-500/10" />

        {/* Metadata grid */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-1 py-5 px-1">
          <MetaRow label="COLLECTION" value={collectionName} />
          <MetaRow label="TOKEN_ID" value={`#${tokenId}`} />
          <MetaRow label="CREATOR" value={creatorDisplay} />
          {collectionId != null && (
            <MetaRow label="COLLECTION_ID" value={String(collectionId)} />
          )}
          {contentHash && (
            <MetaRow label="CONTENT_HASH" value={contentHash.slice(0, 16)} />
          )}
          {duplicateOfTokenId && (
            <MetaRow label="DUPLICATE_OF" value={`#${duplicateOfTokenId}`} />
          )}
          {questExpiryState && (
            <MetaRow label="QUEST_EXPIRY" value={questExpiryState.toUpperCase()} />
          )}
          {displayAttrs.map((attr) => (
            <MetaRow
              key={attr.trait_type}
              label={attr.trait_type.toUpperCase()}
              value={String(attr.value)}
            />
          ))}
          {description && (
            <div className="col-span-full mt-1">
              <MetaRow label="DESCRIPTOR" value={description} />
            </div>
          )}
        </section>

        <div className="h-px w-full bg-purple-500/10" />

        {/* Status bar */}
        <footer className="flex items-end justify-between pt-4">
          <div className="space-y-0.5">
            <p className="text-[9px] tracking-[0.18em] uppercase text-purple-400/40">
              SYSTEM_STATUS: STABLE
            </p>
            <p className="text-[9px] tracking-[0.18em] uppercase text-purple-400/40">
              ENCRYPTION: ACTIVE
            </p>
            <p className="text-[9px] tracking-[0.18em] uppercase text-purple-400/40">
              // NETWORK: stellar-testnet
            </p>
          </div>

          <nav className="flex items-center gap-3 text-[9px] tracking-[0.18em] uppercase">
            {tokenId > 1 ? (
              <Link
                href={`/collection/${tokenId - 1}`}
                className="text-purple-400/45 hover:text-purple-300/90 transition-colors"
              >
                [{`<< PREV`}]
              </Link>
            ) : (
              <span className="text-purple-400/20 select-none">[-- PREV]</span>
            )}
            <Link
              href="/explore"
              className="text-purple-400/45 hover:text-purple-300/90 transition-colors"
            >
              [INDEX]
            </Link>
            <Link
              href={`/collection/${tokenId + 1}`}
              className="text-purple-400/45 hover:text-purple-300/90 transition-colors"
            >
              [{`NEXT >>`}]
            </Link>
          </nav>
        </footer>
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="shrink-0 w-28 text-[9px] tracking-[0.18em] uppercase text-purple-400/38">
        {label}:
      </span>
      <span className="text-[10px] tracking-[0.1em] text-purple-200/80 truncate">
        {value}
      </span>
    </div>
  )
}
