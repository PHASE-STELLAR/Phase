"use client"

import Image from "next/image"
import Link from "next/link"
import { LangToggle } from "@/components/lang-toggle"
import { useLang } from "@/components/lang-context"
import { pickProjectDocs, type DocsLinkItem, type DocsRecipe, type ProjectDocsPage } from "@/lib/project-docs-content"

// phase-668. Read literally: Next only inlines NEXT_PUBLIC_* into client bundles
// when accessed by name, so isFeatureEnabled's dynamic lookup is always off here.
const RECIPES_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_FEATURE_PHASE_668 ?? "").trim().toLowerCase(),
)

/** Renders text with every occurrence of "wallet" highlighted in cyan. */
function W({ children }: { children: string }) {
  const parts = children.split(/(wallet)/gi)
  return (
    <>
      {parts.map((part, i) =>
        /^wallet$/i.test(part) ? (
          <span key={i} className="text-cyan-400 font-semibold">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  )
}

function DocsHref({ item }: { item: DocsLinkItem }) {
  const isInternal = item.href.startsWith("/")
  const linkClass =
    "font-semibold text-violet-300 underline decoration-violet-500/40 underline-offset-4 transition-colors hover:text-violet-100 hover:decoration-violet-300 break-words"
  const label = (
    <>
      {item.label}
      {!isInternal ? (
        <span className="ml-1 text-[10px] font-normal text-violet-500/60" aria-hidden>
          ↗
        </span>
      ) : null}
    </>
  )
  return (
    <div className="border border-violet-500/25 bg-violet-950/10 p-4 transition-colors hover:border-violet-400/40 hover:bg-violet-950/20">
      {isInternal ? (
        <Link href={item.href} className={linkClass}>
          {label}
        </Link>
      ) : (
        <a href={item.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {label}
        </a>
      )}
      {item.description ? (
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">{item.description}</p>
      ) : null}
    </div>
  )
}

/** Detects if a cell looks like code (route, function sig, env var, etc.) */
function isCodeCell(text: string): boolean {
  return (
    text.startsWith("/") ||
    text.startsWith("(") ||
    text.includes("_") ||
    /^[A-Z_]{4,}/.test(text) ||
    text.includes("→") ||
    text.includes("PHASELQ") ||
    text.includes("u32") ||
    text.includes("Vec") ||
    text.includes("GET") ||
    text.includes("POST")
  )
}

function DocsTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto border border-violet-500/25 bg-black/40">
      <table className="w-full min-w-[420px] text-left">
        <thead>
          <tr className="border-b border-violet-500/30 bg-violet-950/30">
            {headers.map((h) => (
              <th
                key={h}
                className="px-4 py-3 font-mono text-[9px] font-bold uppercase tracking-[0.28em] text-violet-400/90 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-violet-500/10 transition-colors last:border-0 hover:bg-violet-950/15"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={
                    ci === 0
                      ? "px-4 py-3 align-top font-mono text-[11px] font-semibold text-violet-200/95 whitespace-nowrap"
                      : isCodeCell(cell)
                        ? "px-4 py-3 align-top font-mono text-[11px] text-zinc-300/85"
                        : "px-4 py-3 align-top text-[12px] leading-snug text-zinc-300/80"
                  }
                >
                  <W>{cell}</W>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocsRecipeCard({
  recipe,
  labels,
}: {
  recipe: DocsRecipe
  labels: ProjectDocsPage["recipeLabels"]
}) {
  const heading = "font-mono text-[9px] font-bold uppercase tracking-[0.28em] text-violet-500/70"
  return (
    <article id={`recipe-${recipe.id}`} className="scroll-mt-20 border border-violet-500/25 bg-violet-950/10 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-[13px] font-semibold text-violet-200">{recipe.title}</h3>
        <span className="border border-emerald-500/30 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-emerald-400/80">
          {labels.tested}
        </span>
      </div>
      <p className="mt-3 font-sans text-[13px] leading-relaxed text-zinc-300/90">
        <W>{recipe.summary}</W>
      </p>
      <p className={`mt-5 ${heading}`}>{labels.steps}</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 font-sans text-[13px] text-zinc-300/90">
        {recipe.steps.map((step) => (
          <li key={step}>
            <W>{step}</W>
          </li>
        ))}
      </ol>
      <p className={`mt-5 mb-2 ${heading}`}>{labels.failures}</p>
      <DocsTable headers={[labels.when, labels.outcome]} rows={recipe.failures.map((f) => [f.when, f.outcome])} />
      <p className={`mt-5 mb-2 ${heading}`}>{labels.code}</p>
      <pre className="overflow-x-auto border border-violet-500/20 bg-black/60 p-4 font-mono text-[10px] leading-relaxed text-zinc-300/85">
        {recipe.code}
      </pre>
    </article>
  )
}

export default function DocsPage() {
  const { lang } = useLang()
  const d = pickProjectDocs(lang, { recipes: RECIPES_ENABLED })

  return (
    <div className="min-h-screen bg-background font-mono text-foreground">
      {/* Nav */}
      <div className="sticky top-0 z-40 border-b border-violet-500/20 bg-black/80 px-4 py-3 backdrop-blur-sm md:px-8">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Link
            href="/"
            className="font-mono text-[10px] uppercase tracking-[0.35em] text-zinc-500 transition-colors hover:text-violet-300"
          >
            ← HOME
          </Link>
          <LangToggle variant="phosphor" />
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 py-12 pb-24 md:px-8">
        {/* Header */}
        <div className="mb-12">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-violet-400/80">
            {lang === "es" ? "PROTOCOLO PHASE" : "PHASE PROTOCOL"}
          </span>
          <h1 className="mt-3 font-[var(--font-bebas)] text-5xl tracking-tight text-foreground md:text-6xl">
            {d.pageTitle}
          </h1>
          <p className="mt-4 max-w-2xl font-sans text-[13px] leading-relaxed text-zinc-400">
            {d.pageSubtitle}
          </p>
          <div className="mt-6 h-px max-w-[8rem] bg-gradient-to-r from-violet-400/60 to-transparent" />
        </div>

        {/* Table of contents */}
        <nav
          aria-label={d.tocLabel}
          className="mb-14 border border-violet-500/25 bg-violet-950/10 p-5"
        >
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.3em] text-violet-400/90">
            {d.tocLabel}
          </p>
          <ol className="mt-4 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {d.sections.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="flex items-center gap-2 py-1 text-[11px] text-zinc-400 transition-colors hover:text-violet-300"
                >
                  <span className="font-mono text-[9px] text-violet-600/70 tabular-nums">
                    {String(i + 1).padStart(2, "0")}.
                  </span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* Sections */}
        <div className="space-y-20">
          {d.sections.map((section, si) => (
            <section key={section.id} id={section.id} className="scroll-mt-20">
              <div className="mb-6 flex items-center gap-3">
                <span className="font-mono text-[9px] text-violet-600/60 tabular-nums">
                  {String(si + 1).padStart(2, "0")}
                </span>
                <h2 className="font-[var(--font-bebas)] text-2xl tracking-wide text-foreground md:text-3xl">
                  {section.title}
                </h2>
              </div>
              <div className="border-l-2 border-violet-500/20 pl-6">
                <div className="space-y-6 text-sm leading-relaxed">
                  {section.blocks.map((block, idx) => {
                    if (block.type === "p") {
                      return (
                        <p key={idx} className="font-sans text-[13px] leading-relaxed text-zinc-300/90 text-pretty">
                          <W>{block.text}</W>
                        </p>
                      )
                    }
                    if (block.type === "links") {
                      return (
                        <div key={idx} className="space-y-3">
                          {block.intro ? (
                            <p className="font-sans text-[13px] text-zinc-400">{block.intro}</p>
                          ) : null}
                          <ul className="list-none space-y-2">
                            {block.items.map((item) => (
                              <li key={`${item.href}-${item.label}`}>
                                <DocsHref item={item} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      )
                    }
                    if (block.type === "table") {
                      return <DocsTable key={idx} headers={block.headers} rows={block.rows} />
                    }
                    if (block.type === "code") {
                      return (
                        <div key={idx}>
                          {block.label ? (
                            <p className="mb-2 font-mono text-[9px] font-bold uppercase tracking-[0.28em] text-violet-500/70">
                              {block.label}
                            </p>
                          ) : null}
                          <pre className="overflow-x-auto border border-violet-500/20 bg-black/60 p-4 font-mono text-[10px] leading-relaxed text-zinc-300/85">
                            {block.text}
                          </pre>
                        </div>
                      )
                    }
                    if (block.type === "recipe") {
                      return <DocsRecipeCard key={idx} recipe={block.recipe} labels={d.recipeLabels} />
                    }
                    if (block.type === "image") {
                      return (
                        <div key={idx}>
                          {block.label ? (
                            <p className="mb-2 font-mono text-[9px] font-bold uppercase tracking-[0.28em] text-violet-500/70">
                              {block.label}
                            </p>
                          ) : null}
                          <div className="border border-violet-500/20 bg-black/40 p-4">
                            <Image
                              src={block.src}
                              alt={block.alt}
                              width={800}
                              height={500}
                              className="w-full h-auto"
                              unoptimized
                            />
                          </div>
                        </div>
                      )
                    }
                    return (
                      <ul key={idx} className="list-none space-y-2">
                        {block.items.map((item) => (
                          <li key={item} className="flex gap-2.5 font-sans text-[13px] text-zinc-300/90">
                            <span className="mt-[3px] shrink-0 text-violet-500/60" aria-hidden>
                              ▹
                            </span>
                            <span><W>{item}</W></span>
                          </li>
                        ))}
                      </ul>
                    )
                  })}
                </div>
              </div>
            </section>
          ))}
        </div>

        {/* Footer */}
        <p className="mt-20 border-t border-violet-500/15 pt-8 font-mono text-[9px] uppercase tracking-widest text-zinc-600">
          PHASE ·{" "}
          {lang === "es"
            ? "Documentación integrada en la aplicación."
            : "Documentation lives inside the app."}
        </p>
      </main>
    </div>
  )
}
