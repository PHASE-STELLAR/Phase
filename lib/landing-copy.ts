/** Matches `AppLang` from lang-context (kept here so lib/ does not import components). */
export type LandingLang = "en" | "es"

export type LandingSignal = { date: string; title: string; note: string }

export type LandingWorkModule = {
  title: string
  medium: string
  description: string
  span: string
}

export type LandingPrinciple = {
  number: string
  category: string
  titleParts: { text: string; highlight: boolean }[]
  description: string
  align: "left" | "right"
}

export type LandingColophon = {
  sectionEyebrow: string
  sectionTitle: string
  networkLabel: string
  networkLines: string[]
  standardLabel: string
  standardLines: string[]
  docLabel: string
  docButton: string
  docHref: string
  developerLabel: string
  developerGithubLabel: string
  developerXLabel: string
  copyright: string
  tagline: string
}

export type LandingCopy = {
  studioBrand: string
  sideNav: { id: string; label: string }[]
  signals: {
    sectionEyebrow: string
    sectionTitle: string
    items: LandingSignal[]
  }
  work: {
    sectionEyebrow: string
    sectionTitle: string
    intro: string
    modules: LandingWorkModule[]
  }
  principles: {
    sectionEyebrow: string
    sectionTitle: string
    items: LandingPrinciple[]
  }
  colophon: LandingColophon
}

const landingCopy: Record<LandingLang, LandingCopy> = {
  es: {
    studioBrand: "PHASE Studio",
    sideNav: [
      { id: "hero", label: "Índice" },
      { id: "signals", label: "Registros" },
      { id: "work", label: "Módulos" },
      { id: "principles", label: "Axiomas" },
      { id: "colophon", label: "Documentación" },
    ],
    signals: {
      sectionEyebrow: "01 / Registros del Protocolo (Protocol Logs)",
      sectionTitle: "TRANSICIONES DE ESTADO",
      items: [
        {
          date: "2026.04.13",
          title: "Open Graph Dinámico",
          note: "Cada URL del Chamber genera ahora una imagen de vista previa retro única con el NFT dentro. Compartible en cualquier plataforma.",
        },
        {
          date: "2026.04.12",
          title: "Narrative World Mode",
          note: "Las colecciones pueden activar un mundo narrativo — un universo persistente inyectado en cada generación de Gemini. Un agente narrador autónomo conecta artefactos después de cada mint.",
        },
        {
          date: "2026.04.10",
          title: "PageSpeed 98 Performance",
          note: "Optimización de Core Web Vitals: 0.6s FCP, 0.8s LCP, 98/100 Performance score en escritorio.",
        },
        {
          date: "2026.04.10",
          title: "Narrative Mode",
          note: "El Chamber ahora genera historias únicas. Cada NFT incluye lore generado por IA basado en atributos del artefacto.",
        },
        {
          date: "2026.04.05",
          title: "Chamber Open Graph",
          note: "Previsualización social del NFT antes de mintear. Comparte en X/Twitter antes de confirmar.",
        },
        {
          date: "2026.04.03",
          title: "Despliegue x402",
          note: "Lanzamiento oficial del motor de liquidez dual en Soroban Testnet.",
        },
        {
          date: "2026.03.28",
          title: "Integración multimedia",
          note: "Activación de la Suite Multimodal (Paint, Upload, URL) para la creación de arte.",
        },
        {
          date: "2026.02.20",
          title: "Sistema de comisiones",
          note: "Activación de la Tesorería del Protocolo (95/5 split) para creadores.",
        },
      ],
    },
    work: {
      sectionEyebrow: "02 / Módulos Principales (Core Modules)",
      sectionTitle: "ARQUITECTURA x402",
      intro:
        "Crea, mintea y comercia NFTs con IA. Todo en Soroban, sin middlemen.",
      modules: [
        {
          title: "Forge",
          medium: "Crear",
          description:
            "Crea una colección. Define tu mundo. Establece el precio en PHASELQ. Cada mint activa el pipeline de IA — Gemini genera el lore, la imagen es única, el metadata queda sellado en IPFS.",
          span: "col-span-1 row-span-1 sm:col-span-2 sm:row-span-2",
        },
        {
          title: "Chamber",
          medium: "Mintear",
          description:
            "Paga con PHASELQ vía x402. El servidor verifica tu transacción en el ledger de Stellar antes de ejecutar una sola línea de IA. Tu artefacto se mintea en el momento en que el ledger confirma.",
          span: "col-span-1 row-span-1",
        },
        {
          title: "Dashboard",
          medium: "Mercado",
          description:
            "Explora colecciones activas. Consulta tu vault. Lista tu NFT en el mercado secundario.",
          span: "col-span-1 row-span-1 sm:row-span-2",
        },
        {
          title: "Explore",
          medium: "Galería",
          description:
            "Galería pública de todos los artefactos minteados. Sin wallet. Cada NFT aquí fue pagado on-chain — el txHash es la prueba de creación.",
          span: "col-span-1 row-span-1",
        },
      ],
    },
    principles: {
      sectionEyebrow: "03 / Axiomas del Protocolo",
      sectionTitle: "AXIOMAS DEL PROTOCOLO",
      items: [
        {
          number: "01",
          category: "PAGO",
          titleParts: [
            { text: "SIN PAGO, ", highlight: false },
            { text: "SIN OUTPUT", highlight: true },
          ],
          description:
            "El servidor nunca ejecuta el pipeline de IA de forma especulativa. El hash de transacción de Stellar es el único recibo que importa.",
          align: "left",
        },
        {
          number: "02",
          category: "PROPIEDAD",
          titleParts: [
            { text: "EL LEDGER ES ", highlight: false },
            { text: "LA FUENTE DE VERDAD", highlight: true },
          ],
          description:
            "La propiedad, las colecciones y el estado de liquidación siempre se leen desde el contrato Soroban — nunca desde el store del servidor.",
          align: "right",
        },
        {
          number: "03",
          category: "PERMANENCIA",
          titleParts: [
            { text: "IPFS ", highlight: false },
            { text: "ES PARA SIEMPRE", highlight: true },
          ],
          description:
            "El metadata de cada artefacto queda sellado en IPFS en el momento del mint. Ningún servidor puede alterar ni eliminar lo que el ledger ha confirmado.",
          align: "left",
        },
      ],
    },
    colophon: {
      sectionEyebrow: "04 / Telemetría (System Data)",
      sectionTitle: "DATOS DEL SISTEMA",
      networkLabel: "Red",
      networkLines: ["Stellar // Soroban (Testnet)"],
      standardLabel: "Estándar",
      standardLines: ["x402 Híbrido / NFT Utility SEP-41 + SEP-50"],
      docLabel: "Documentación",
      docButton: "[ DOC ]",
      docHref: "/docs",
      developerLabel: "Desarrollador",
      developerGithubLabel: "https://github.com/PHASE-STELLAR/Phase.git",
      developerXLabel: "X (@Darkvader-ship-it)",
      copyright: "© 2026 Phase Protocol. Todos los derechos reservados.",
      tagline: "Diseñado con intención. Compilado con precisión.",
    },
  },
  en: {
    studioBrand: "PHASE Studio",
    sideNav: [
      { id: "hero", label: "Index" },
      { id: "signals", label: "Protocol Logs" },
      { id: "work", label: "Core Modules" },
      { id: "principles", label: "Axioms" },
      { id: "colophon", label: "Documentation" },
    ],
    signals: {
      sectionEyebrow: "01 / Protocol Logs",
      sectionTitle: "STATE TRANSITIONS",
      items: [
        {
          date: "2026.04.13",
          title: "Dynamic Open Graph",
          note: "Each Chamber URL now generates a unique retro monitor preview image with the NFT inside. Shareable on any platform.",
        },
        {
          date: "2026.04.12",
          title: "Narrative World Mode",
          note: "Collections can now activate a narrative world — a persistent universe context injected into every Gemini generation. An autonomous narrator agent connects artifacts after each mint.",
        },
        {
          date: "2026.04.10",
          title: "PageSpeed 98 Performance",
          note: "Core Web Vitals optimization: 0.6s FCP, 0.8s LCP, 98/100 Performance score on desktop.",
        },
        {
          date: "2026.04.10",
          title: "Narrative Mode",
          note: "The Chamber now generates unique stories. Each NFT includes AI-generated lore based on artifact attributes.",
        },
        {
          date: "2026.04.05",
          title: "Chamber Open Graph",
          note: "Social preview before minting. Share on X/Twitter before confirming.",
        },
        {
          date: "2026.04.03",
          title: "x402 deployment",
          note: "Official launch of the dual-state liquidity engine on Soroban Testnet.",
        },
        {
          date: "2026.03.28",
          title: "Multimedia integration",
          note: "Multimodal Suite (Paint, Upload, URL) activated for art creation.",
        },
        {
          date: "2026.03.15",
          title: "SEP-41/SEP-50 NFTs",
          note: "Implementation of dynamic Soroban collectibles with evolvable metadata.",
        },
        {
          date: "2026.02.20",
          title: "Fee system",
          note: "Protocol Treasury activation (95/5 split) for creators.",
        },
      ],
    },
    work: {
      sectionEyebrow: "02 / Core Modules",
      sectionTitle: "x402 ARCHITECTURE",
      intro: "Create, mint, and trade AI-generated NFTs on Soroban. No middlemen.",
      modules: [
        {
          title: "Forge",
          medium: "Create",
          description:
            "Create a collection. Define your world. Set the price in PHASELQ. Every mint triggers the AI pipeline — Gemini generates the lore, the image is unique, the metadata is sealed on IPFS.",
          span: "col-span-1 row-span-1 sm:col-span-2 sm:row-span-2",
        },
        {
          title: "Chamber",
          medium: "Mint",
          description:
            "Pay with PHASELQ via x402. The server verifies your transaction on the Stellar ledger before running a single line of AI. Your artifact is minted the moment the ledger confirms.",
          span: "col-span-1 row-span-1",
        },
        {
          title: "Dashboard",
          medium: "Market",
          description:
            "Browse active collections. View your vault. List your NFT on the secondary market.",
          span: "col-span-1 row-span-1 sm:row-span-2",
        },
        {
          title: "Explore",
          medium: "Gallery",
          description:
            "Public gallery of all minted artifacts. No wallet needed. Every NFT here was paid for on-chain — the txHash is the proof of creation.",
          span: "col-span-1 row-span-1",
        },
      ],
    },
    principles: {
      sectionEyebrow: "03 / Axioms",
      sectionTitle: "PROTOCOL AXIOMS",
      items: [
        {
          number: "01",
          category: "PAYMENT",
          titleParts: [
            { text: "NO PAYMENT, ", highlight: false },
            { text: "NO OUTPUT", highlight: true },
          ],
          description:
            "The server never runs the AI pipeline speculatively. The Stellar transaction hash is the only receipt that matters.",
          align: "left",
        },
        {
          number: "02",
          category: "OWNERSHIP",
          titleParts: [
            { text: "THE LEDGER IS ", highlight: false },
            { text: "THE SOURCE OF TRUTH", highlight: true },
          ],
          description:
            "Ownership, collections, and settlement state are always read from the Soroban contract — never from the server's store.",
          align: "right",
        },
        {
          number: "03",
          category: "PERMANENCE",
          titleParts: [
            { text: "IPFS ", highlight: false },
            { text: "IS FOREVER", highlight: true },
          ],
          description:
            "Every artifact's metadata is sealed on IPFS at mint time. No server can alter or delete what the ledger has confirmed.",
          align: "left",
        },
      ],
    },
    colophon: {
      sectionEyebrow: "04 / Telemetry (System Data)",
      sectionTitle: "SYSTEM DATA",
      networkLabel: "Network",
      networkLines: ["Stellar // Soroban (Testnet)"],
      standardLabel: "Standard",
      standardLines: ["x402 Hybrid / NFT Utility SEP-41 + SEP-50"],
      docLabel: "Documentation",
      docButton: "[ DOC ]",
      docHref: "/docs",
      developerLabel: "Developer",
      developerGithubLabel: "https://github.com/PHASE-STELLAR/Phase.git",
      developerXLabel: "X (@Darkvader-ship-it)",
      copyright: "© 2026 Phase Protocol. All rights reserved.",
      tagline: "Designed with intention. Compiled with precision.",
    },
  },
}

export function pickLandingCopy(lang: LandingLang): LandingCopy {
  return landingCopy[lang]
}

// phase-293: Landing page i18n shell and copy pipeline
// Routes landing copy through pickCopy with EN/ES keys.
// Respects locale persistence with safe fallback.
export function getLocalizedLandingCopy(requestedLang?: string): LandingCopy {
  const supportedLangs: readonly LandingLang[] = ["en", "es"]
  const requested = requestedLang?.toLowerCase() as LandingLang | undefined
  const lang: LandingLang = requested && supportedLangs.includes(requested) ? requested : "en"
  return pickLandingCopy(lang)
}
