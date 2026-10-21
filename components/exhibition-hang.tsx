"use client"

import { IpfsDisplayImg } from "@/components/ipfs-display-img"
import { pickCopy } from "@/lib/phase-copy"

export type ExhibitionHangSlot = {
  position: number
  token_id: number
  world_name: string
  wall_text: string
  image: string
  owner_truncated: string
}

export type ExhibitionView = {
  title: string
  statement: string
  status: "draft" | "published" | "rotated"
  theme_terms: string[]
  cover_token_id: number
  hang: ExhibitionHangSlot[]
}

/** Renders a show in hang order; a dead image keeps its frame so the order holds. */
export function ExhibitionHang({ exhibition, lang }: { exhibition: ExhibitionView; lang: string }) {
  const copy = pickCopy(lang).curator
  const statusLabel =
    exhibition.status === "published" ? copy.statusPublished : exhibition.status === "rotated" ? copy.statusRotated : copy.statusDraft

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-3 border-b-2 border-cyan-500/30 pb-6">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400">
          {copy.sectionTitle} · {statusLabel}
        </span>
        <h1 className="text-2xl font-bold text-cyan-50">{exhibition.title}</h1>
        <p className="text-[10px] uppercase tracking-widest text-cyan-300/70">{exhibition.theme_terms.join(" · ")}</p>
        <section>
          <h2 className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400">{copy.statementLabel}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-cyan-100/90">{exhibition.statement}</p>
        </section>
      </header>

      <ol className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {exhibition.hang.map((slot) => (
          <li key={slot.token_id} className="flex flex-col border-2 border-cyan-500/20 bg-black/40">
            <div className="relative aspect-square w-full bg-cyan-950/40">
              <IpfsDisplayImg
                uri={slot.image}
                alt={`#${slot.token_id}`}
                className="h-full w-full object-cover"
                fallback={
                  <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-widest text-cyan-500/60">
                    {copy.imageUnavailable}
                  </div>
                }
              />
              {slot.token_id === exhibition.cover_token_id ? (
                <span className="absolute left-2 top-2 bg-cyan-400 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-black">
                  {copy.coverLabel}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 p-3">
              <span className="text-[10px] uppercase tracking-widest text-cyan-400">
                {String(slot.position).padStart(2, "0")} · #{slot.token_id} · {slot.world_name}
              </span>
              <p className="text-xs leading-relaxed text-cyan-100/90">{slot.wall_text}</p>
              <span className="text-[10px] text-cyan-500/60">{slot.owner_truncated}</span>
            </div>
          </li>
        ))}
      </ol>
    </article>
  )
}
