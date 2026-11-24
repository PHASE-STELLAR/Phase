/** Contenido de documentación del proyecto (no enlazado a archivos .md externos). */
import type { LandingLang } from "@/lib/landing-copy"

export type DocsLinkItem = {
  label: string
  href: string
  description?: string
}

export type DocsBlock =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "links"; intro?: string; items: DocsLinkItem[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; text: string; label?: string }
  | { type: "image"; src: string; alt: string; label?: string }
  | { type: "recipe"; recipe: DocsRecipe }

export type IntegrationRecipeId =
  | "trustline-bootstrap"
  | "liq-bootstrap-claim"
  | "x402-settle"
  | "forge-job-polling"
  | "ownership-listing"

export type DocsRecipe = {
  id: IntegrationRecipeId
  title: string
  summary: string
  steps: string[]
  /** Each failure branch the snippet handles, and what it returns for it. */
  failures: { when: string; outcome: string }[]
  /** Function the snippet defines; CI calls it with a sandbox context. */
  entry: string
  code: string
}

export type DocsSection = {
  id: string
  title: string
  blocks: DocsBlock[]
}

export type ProjectDocsPage = {
  pageTitle: string
  pageSubtitle: string
  tocLabel: string
  recipeLabels: { steps: string; failures: string; when: string; outcome: string; code: string; tested: string }
  sections: DocsSection[]
}


const projectDocs: Record<LandingLang, ProjectDocsPage> = {
  es: {
    pageTitle: "Documentación PHASE",
    pageSubtitle:
      "Cómo funciona PHASE Protocol: x402 como paywall on-chain, creación de NFTs en Soroban, flujo de pago atómico y recompensas en PHASELQ.",
    tocLabel: "Índice",
    recipeLabels: {
      steps: "Pasos",
      failures: "Ramas de error",
      when: "Cuando",
      outcome: "Resultado",
      code: "Código",
      tested: "Probado en CI",
    },
    sections: [
      {
        id: "overview",
        title: "Qué es PHASE",
        blocks: [
          {
            type: "p",
            text: "PHASE Protocol convierte la generación de IA en un paywall criptográfico. Cada NFT generado requiere un pago on-chain verificado antes de que el servidor corra el pipeline de IA. No hay suscripción, no hay API key de facturación, y no hay forma de recibir el output sin antes liquidar PHASELQ en la cadena.",
          },
          {
            type: "p",
            text: "El sistema tiene tres piezas: la Forja (crear colecciones + Oracle x402), la Cámara (settlement, visualización del artefacto, recompensas) y el Mercado (catálogo de colecciones, listados, vault por wallet).",
          },
          {
            type: "table",
            headers: ["Ruta", "Función principal"],
            rows: [
              ["/forge", "Registrar colección + Oracle x402-gated AI"],
              ["/chamber", "Settlement, ver artefacto, colectar NFT, recompensas PHASELQ"],
              ["/dashboard", "Mercado de colecciones, listados activos, vault por wallet"],
              ["/explore", "Galería pública de NFTs acuñados (sin wallet)"],
              ["/docs", "Esta página"],
            ],
          },
        ],
      },
      {
        id: "x402",
        title: "x402: el paywall on-chain",
        blocks: [
          {
            type: "p",
            text: "HTTP 402 (\"Payment Required\") existe desde 1996 pero nunca tuvo un estándar para uso máquina. x402 le da significado concreto: el servidor responde 402 con un challenge de pago estructurado, el cliente liquida on-chain, y el servidor verifica la prueba de ledger antes de liberar el recurso.",
          },
          {
            type: "p",
            text: "En PHASE, x402 es el gate de acceso al Oracle de IA. El servidor nunca corre el pipeline especulativamente — el hash de la transacción Stellar es el recibo de pago.",
          },
          {
            type: "image",
            src: "/docs/diagram-forge-flow.png",
            alt: "Flujo x402 completo: browser → 402 challenge → firma Soroban → verificación RPC → pipeline IA → mint",
            label: "Flujo x402 completo",
          },
          {
            type: "table",
            headers: ["Paso", "Endpoint", "Quién actúa", "Qué ocurre"],
            rows: [
              ["1. Challenge", "POST /api/forge-agent", "Cliente", "Servidor responde HTTP 402 con amount, token, network"],
              ["2. Pago", "Soroban RPC", "Usuario (wallet)", "Firma transfer PHASELQ → protocolo; obtiene txHash"],
              ["3. Verificación", "POST /api/forge-agent", "Servidor", "Lee tx en RPC, decodifica invocación, valida monto y pagador"],
              ["4. Generación", "APIs externas", "Servidor", "Gemini (lore) + Nano Banana / Pollinations (imagen)"],
              ["5. Sellado", "Pinata IPFS", "Servidor", "Sube metadata JSON, obtiene CID permanente"],
              ["6. Mint", "Soroban contract", "Servidor", "Llama initiate_phase, registra token_id y owner"],
            ],
          },
        ],
      },
      {
        id: "nft-flow",
        title: "Creación de NFTs: ciclo completo",
        blocks: [
          {
            type: "image",
            src: "/docs/diagram-phases.png",
            alt: "Ciclo de vida del artefacto: Register → Pay → Verify → Generate → Mint",
            label: "Ciclo de vida del artefacto",
          },
          {
            type: "p",
            text: "El token sigue la interfaz SEP-50 draft en Soroban. Todos los parámetros token_id son u32 — requerido para compatibilidad con Freighter SEP-50.",
          },
          {
            type: "table",
            headers: ["Función", "Firma", "Descripción"],
            rows: [
              ["owner_of", "(token_id: u32) → Address", "Propietario actual del token"],
              ["token_uri", "(token_id: u32) → String", "URI de metadata IPFS"],
              ["token_metadata", "(token_id: u32) → Map", "Atributos on-chain del artefacto"],
              ["get_creator_collection_ids", "(creator: Address) → Vec<u64>", "Todos los IDs de colecciones del creador"],
              ["get_user_phase", "(wallet: Address, cid: u32) → u32", "Token ID acuñado para esa wallet en esa colección"],
              ["create_collection", "(creator, price, uri)", "Registra colección — múltiples por wallet permitidas"],
              ["initiate_phase", "(collection_id, minter, uri)", "Acuña el NFT con la URI IPFS sellada"],
            ],
          },
        ],
      },
      {
        id: "token",
        title: "PHASELQ: el token de pago",
        blocks: [
          {
            type: "p",
            text: "PHASELQ es un asset Clásico de Stellar con un Stellar Asset Contract (SAC) desplegado. Esto lo hace compatible con SEP-41 (llamable desde Soroban como transfer/mint/balance) y también visible en Horizon como asset clásico con trustlines.",
          },
          {
            type: "table",
            headers: ["Propiedad", "Valor"],
            rows: [
              ["Símbolo", "PHASELQ"],
              ["Decimales", "7 (stroops)"],
              ["Estándar", "SEP-41 (Stellar Asset Contract)"],
              ["Visibilidad", "Soroban + Horizon (asset clásico)"],
              ["Trustline", "Requerida para recibir PHASELQ en la wallet"],
              ["Red", "Stellar testnet"],
            ],
          },
          {
            type: "p",
            text: "El SAC es el token que x402 usa como medio de pago. Cuando el usuario firma la transacción de pago, llama a transfer() en el contrato SAC de PHASELQ vía Soroban.",
          },
        ],
      },
      {
        id: "rewards",
        title: "Recompensas PHASELQ",
        blocks: [
          {
            type: "p",
            text: "El endpoint /api/faucet distribuye PHASELQ para onboarding y uso recurrente. La elegibilidad de las quests se verifica contra el ledger — el servidor no confía en su propio store para determinar si un quest está completo.",
          },
          {
            type: "table",
            headers: ["Recompensa", "Monto", "Condición", "Renovable"],
            rows: [
              ["genesis", "10 PHASELQ", "Primera conexión de wallet", "No (única vez)"],
              ["daily", "2 PHASELQ", "Ventana de 24 horas", "Sí, cada 24h"],
              ["quest_connect_wallet", "3 PHASELQ", "Wallet conectada", "No (única vez)"],
              ["quest_first_collection", "3 PHASELQ", "Forjó colección o acuñó en alguna", "No (única vez)"],
              ["quest_first_settle", "3 PHASELQ", "Settlement on-chain completado", "No (única vez)"],
            ],
          },
        ],
      },
      {
        id: "indexing",
        title: "Indexación de NFTs",
        blocks: [
          {
            type: "p",
            text: "Soroban no expone una query nativa de \"tokens que posee una dirección\". PHASE resuelve esto con dos estrategias:",
          },
          {
            type: "image",
            src: "/docs/diagram-wallet-indexing.png",
            alt: "Estrategia de indexación: Mercury JWT → Classic REST o RPC scan → NFT list",
            label: "Estrategia de indexación",
          },
          {
            type: "table",
            headers: ["Estrategia", "Velocidad", "Dependencia", "Activación"],
            rows: [
              ["Mercury Classic", "Milisegundos", "Mercury REST + JWT", "MERCURY_JWT en .env"],
              ["RPC scan (fallback)", "Segundos", "Soroban RPC público", "Automático sin Mercury"],
            ],
          },
        ],
      },
      {
        id: "world",
        title: "06 / World Mode (opcional)",
        blocks: [
          {
            type: "p",
            text: "Las colecciones pueden activar un mundo narrativo — una capa opcional que le da al conjunto un contexto de universo persistente.",
          },
          {
            type: "ul",
            items: [
              "world_name y world_prompt se guardan off-chain (JSON sidecar)",
              "Cada mint en esa colección inyecta el contexto del mundo en la instrucción de sistema de Gemini",
              "Un agente narrador autónomo genera una conexión narrativa de 2-3 oraciones después de cada mint",
              "Las narrativas son idempotentes — una segunda llamada devuelve el resultado en caché sin llamar a Gemini",
            ],
          },
          {
            type: "table",
            headers: ["Aspecto", "Detalle"],
            rows: [
              ["Activación", "Toggle en la UI de Forge al registrar una colección"],
              ["Almacenamiento", "JSON sidecars off-chain (worldCollections.json, worldNarratives.json)"],
              ["Agente narrador", "POST /api/narrator — activado lazily desde el Chamber al primer cargado"],
            ],
          },
        ],
      },
      {
        id: "api",
        title: "Superficie de API",
        blocks: [
          {
            type: "table",
            headers: ["Ruta", "Método", "Propósito"],
            rows: [
              ["/api/forge-agent", "POST", "Oracle x402: challenge 402 o generar + acuñar si hay pago"],
              ["/api/x402", "GET / POST", "Challenge 402 + facilitator local"],
              ["/api/x402/verify", "POST", "Verificar pago contra challenge"],
              ["/api/x402/settle", "POST", "Liquidar pago vía facilitator"],
              ["/api/faucet", "GET / POST", "Estado de recompensas + distribución de PHASELQ"],
              ["/api/classic-liq", "GET / POST", "Estado trustline + bootstrap del asset clásico"],
              ["/api/classic-liq/trustline", "POST", "Enviar XDR de changeTrust firmado por el usuario"],
              ["/api/explore", "GET", "Galería paginada de NFTs (público)"],
              ["/api/wallet/phase-nfts", "GET", "NFTs por wallet (Mercury o RPC scan)"],
              ["/api/phase-nft/verify", "POST", "Verificar ownership on-chain con backoff"],
              ["/api/phase-nft/custodian-release", "POST", "Transfer custodia → wallet (firmado por servidor)"],
              ["/api/soroban-rpc", "POST", "Proxy RPC con URLs de fallback"],
              ["/api/nft-listings", "GET / POST", "Listados de mercado (JSON store)"],
              ["/api/world", "POST", "Guardar configuración de mundo narrativo para una colección"],
              ["/api/world/[id]", "GET", "Obtener configuración de mundo o null"],
              ["/api/world/narrative/[token_id]", "GET", "Obtener narrativa guardada para un token"],
              ["/api/narrator", "POST", "Generar narrativa vía Gemini + guardar (idempotente)"],
              ["/api/og/chamber", "GET", "Imagen Open Graph dinámica para URLs del Chamber"],
            ],
          },
        ],
      },
      {
        id: "security",
        title: "Modelo de seguridad",
        blocks: [
          {
            type: "p",
            text: "El servidor nunca tiene las claves del usuario. Toda firma ocurre en la wallet del cliente. El contrato Soroban es la fuente de verdad — ownership, colecciones y estado de settlement siempre se leen desde el ledger, no desde el store del servidor.",
          },
          {
            type: "table",
            headers: ["Qué tiene el servidor", "Para qué"],
            rows: [
              ["ADMIN_SECRET_KEY / FAUCET_DISTRIBUTOR_SECRET_KEY", "Pagar recompensas del faucet (mint o transfer)"],
              ["PINATA_JWT", "Subir metadata a IPFS"],
              ["GOOGLE_AI_STUDIO_API_KEY", "Llamadas a Gemini"],
              ["CLASSIC_LIQ_ISSUER_SECRET (opcional)", "Bootstrap del asset clásico PHASELQ"],
            ],
          },
          {
            type: "p",
            text: "La verificación x402 decodifica la transacción Soroban real — valida los argumentos de la invocación, la dirección del pagador y el monto contra los parámetros del challenge. El servidor no acepta output de IA basado en afirmaciones del cliente.",
          },
        ],
      },
      {
        id: "links",
        title: "Referencias y estándares",
        blocks: [
          {
            type: "links",
            items: [
              {
                label: "x402 en Stellar (guía oficial)",
                href: "https://developers.stellar.org/docs/build/agentic-payments/x402",
                description: "Flujo x402 canónico en Stellar, wallets compatibles y facilitators.",
              },
              {
                label: "x402-stellar (npm)",
                href: "https://www.npmjs.com/package/x402-stellar",
                description: "Paquete oficial para construir flujos x402 en apps sobre Stellar.",
              },
              {
                label: "SEP-50 (NFT en Soroban)",
                href: "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0050.md",
                description: "Borrador del estándar de coleccionables/NFT en Stellar Soroban.",
              },
              {
                label: "SEP-41 (token interface)",
                href: "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md",
                description: "Interfaz estándar de tokens fungibles en Soroban.",
              },
              {
                label: "Stellar Asset Contract",
                href: "https://developers.stellar.org/docs/tokens/stellar-asset-contract",
                description: "Cómo Stellar modela assets clásicos como contratos Soroban (SAC).",
              },
              {
                label: "Soroban — Smart contracts",
                href: "https://developers.stellar.org/docs/build/smart-contracts",
                description: "Contratos inteligentes en Stellar: Rust, WASM, entorno de pruebas.",
              },
              {
                label: "Stellar Expert (testnet)",
                href: "https://stellar.expert/explorer/testnet",
                description: "Explorador de bloques, contratos y transacciones.",
              },
            ],
          },
        ],
      },
    ],
  },
  en: {
    pageTitle: "PHASE Documentation",
    pageSubtitle:
      "How PHASE Protocol works: x402 as an on-chain paywall, NFT creation on Soroban, atomic payment flow, and PHASELQ rewards.",
    tocLabel: "Contents",
    recipeLabels: {
      steps: "Steps",
      failures: "Failure branches",
      when: "When",
      outcome: "Outcome",
      code: "Code",
      tested: "CI-tested",
    },
    sections: [
      {
        id: "overview",
        title: "What PHASE is",
        blocks: [
          {
            type: "p",
            text: "PHASE Protocol turns AI generation into a cryptographic paywall. Every generated NFT requires a verified on-chain payment before the server runs the AI pipeline. There is no subscription, no API key billing, and no way to receive the output without first settling PHASELQ on the ledger.",
          },
          {
            type: "p",
            text: "The system has three pieces: the Forge (create collections + x402 Oracle), the Chamber (settlement, artifact viewer, rewards), and the Dashboard (collection market, listings, per-wallet vault).",
          },
          {
            type: "table",
            headers: ["Route", "Primary function"],
            rows: [
              ["/forge", "Register collection + x402-gated AI Oracle"],
              ["/chamber", "Settlement, view artifact, collect NFT, PHASELQ rewards"],
              ["/dashboard", "Collection market, active listings, per-wallet vault"],
              ["/explore", "Public gallery of all minted NFTs (no wallet needed)"],
              ["/docs", "This page"],
            ],
          },
        ],
      },
      {
        id: "x402",
        title: "x402: the on-chain paywall",
        blocks: [
          {
            type: "p",
            text: "HTTP 402 (\"Payment Required\") has existed since 1996 but never had a machine-readable standard. x402 gives it concrete meaning: the server responds 402 with a structured payment challenge, the client settles on-chain, and the server verifies the ledger proof before releasing the resource.",
          },
          {
            type: "p",
            text: "In PHASE, x402 is the access gate to the AI Oracle. The server never runs the pipeline speculatively — the Stellar transaction hash is the payment receipt.",
          },
          {
            type: "image",
            src: "/docs/diagram-forge-flow.png",
            alt: "Complete x402 flow: browser → 402 challenge → Soroban sign → RPC verification → AI pipeline → mint",
            label: "Complete x402 flow",
          },
          {
            type: "table",
            headers: ["Step", "Endpoint", "Actor", "What happens"],
            rows: [
              ["1. Challenge", "POST /api/forge-agent", "Client", "Server returns HTTP 402 with amount, token, network"],
              ["2. Payment", "Soroban RPC", "User (wallet)", "Signs PHASELQ transfer → protocol; gets txHash"],
              ["3. Verification", "POST /api/forge-agent", "Server", "Reads tx on RPC, decodes invocation, validates amount and payer"],
              ["4. Generation", "External APIs", "Server", "Gemini (lore) + Nano Banana / Pollinations (image)"],
              ["5. Seal", "Pinata IPFS", "Server", "Uploads metadata JSON, gets permanent CID"],
              ["6. Mint", "Soroban contract", "Server", "Calls initiate_phase, records token_id and owner"],
            ],
          },
        ],
      },
      {
        id: "nft-flow",
        title: "NFT creation: full lifecycle",
        blocks: [
          {
            type: "image",
            src: "/docs/diagram-phases.png",
            alt: "Artifact lifecycle: Register → Pay → Verify → Generate → Mint",
            label: "Artifact lifecycle",
          },
          {
            type: "p",
            text: "The token implements the SEP-50 draft NFT interface on Soroban. All token_id parameters are u32 — required for Freighter SEP-50 compatibility.",
          },
          {
            type: "table",
            headers: ["Function", "Signature", "Description"],
            rows: [
              ["owner_of", "(token_id: u32) → Address", "Current owner of the token"],
              ["token_uri", "(token_id: u32) → String", "IPFS metadata URI"],
              ["token_metadata", "(token_id: u32) → Map", "On-chain artifact attributes"],
              ["get_creator_collection_ids", "(creator: Address) → Vec<u64>", "All collection IDs created by this wallet"],
              ["get_user_phase", "(wallet: Address, cid: u32) → u32", "Token ID minted for that wallet in that collection"],
              ["create_collection", "(creator, price, uri)", "Registers collection — multiple per wallet allowed"],
              ["initiate_phase", "(collection_id, minter, uri)", "Mints the NFT with the sealed IPFS URI"],
            ],
          },
        ],
      },
      {
        id: "token",
        title: "PHASELQ: the payment token",
        blocks: [
          {
            type: "p",
            text: "PHASELQ is a Stellar Classic asset with a deployed Stellar Asset Contract (SAC). This makes it SEP-41 compatible (callable from Soroban as transfer/mint/balance) and also visible on Horizon as a classic asset with trustlines.",
          },
          {
            type: "table",
            headers: ["Property", "Value"],
            rows: [
              ["Symbol", "PHASELQ"],
              ["Decimals", "7 (stroops)"],
              ["Standard", "SEP-41 (Stellar Asset Contract)"],
              ["Visibility", "Soroban + Horizon (classic asset)"],
              ["Trustline", "Required to receive PHASELQ in a wallet"],
              ["Network", "Stellar testnet"],
            ],
          },
          {
            type: "p",
            text: "The SAC is the token x402 uses as the payment medium. When the user signs the payment transaction, they are calling transfer() on the PHASELQ SAC contract via Soroban.",
          },
        ],
      },
      {
        id: "rewards",
        title: "PHASELQ rewards",
        blocks: [
          {
            type: "p",
            text: "The /api/faucet endpoint distributes PHASELQ for onboarding and recurring use. Quest eligibility is verified against the ledger — the server does not trust its own store to determine if a quest is complete.",
          },
          {
            type: "table",
            headers: ["Reward", "Amount", "Condition", "Renewable"],
            rows: [
              ["genesis", "10 PHASELQ", "First wallet connection", "No (once)"],
              ["daily", "2 PHASELQ", "24-hour window", "Yes, every 24h"],
              ["quest_connect_wallet", "3 PHASELQ", "Wallet connected", "No (once)"],
              ["quest_first_collection", "3 PHASELQ", "Forged a collection or minted in any", "No (once)"],
              ["quest_first_settle", "3 PHASELQ", "On-chain settlement completed", "No (once)"],
            ],
          },
        ],
      },
      {
        id: "indexing",
        title: "NFT indexing",
        blocks: [
          {
            type: "p",
            text: "Soroban does not expose a native query for \"tokens owned by address\". PHASE resolves this with two strategies:",
          },
          {
            type: "image",
            src: "/docs/diagram-wallet-indexing.png",
            alt: "Indexing strategy: Mercury JWT → Classic REST or RPC scan → NFT list",
            label: "Indexing strategy",
          },
          {
            type: "table",
            headers: ["Strategy", "Speed", "Dependency", "Activation"],
            rows: [
              ["Mercury Classic", "Milliseconds", "Mercury REST + JWT", "Set MERCURY_JWT in .env"],
              ["RPC scan (fallback)", "Seconds", "Public Soroban RPC", "Automatic without Mercury"],
            ],
          },
        ],
      },
      {
        id: "world",
        title: "06 / World Mode (optional)",
        blocks: [
          {
            type: "p",
            text: "Collections can activate a narrative world — an optional layer that gives the collection a persistent universe context.",
          },
          {
            type: "ul",
            items: [
              "world_name and world_prompt are saved off-chain (JSON sidecar)",
              "Every mint in that collection injects the world context into Gemini's system instruction",
              "An autonomous narrator agent generates a 2-3 sentence narrative connection after each mint",
              "Narratives are idempotent — a second call returns the cached result without hitting Gemini",
            ],
          },
          {
            type: "table",
            headers: ["Aspect", "Detail"],
            rows: [
              ["Activation", "Toggle in the Forge UI when registering a collection"],
              ["Storage", "Off-chain JSON sidecars (worldCollections.json, worldNarratives.json)"],
              ["Narrator agent", "POST /api/narrator — triggered lazily from the Chamber on first load"],
            ],
          },
        ],
      },
      {
        id: "api",
        title: "API surface",
        blocks: [
          {
            type: "table",
            headers: ["Route", "Method", "Purpose"],
            rows: [
              ["/api/forge-agent", "POST", "x402 Oracle: return 402 challenge or generate + mint if payment included"],
              ["/api/x402", "GET / POST", "402 challenge + local facilitator"],
              ["/api/x402/verify", "POST", "Verify payment against challenge"],
              ["/api/x402/settle", "POST", "Settle payment via facilitator"],
              ["/api/faucet", "GET / POST", "Reward status + PHASELQ distribution"],
              ["/api/classic-liq", "GET / POST", "Trustline status + classic asset bootstrap"],
              ["/api/classic-liq/trustline", "POST", "Submit user-signed changeTrust XDR"],
              ["/api/explore", "GET", "Paginated public NFT gallery"],
              ["/api/wallet/phase-nfts", "GET", "NFTs by wallet (Mercury or RPC scan)"],
              ["/api/phase-nft/verify", "POST", "On-chain ownership check with backoff"],
              ["/api/phase-nft/custodian-release", "POST", "Transfer custody → wallet (server-signed)"],
              ["/api/soroban-rpc", "POST", "Proxied RPC with fallback URLs"],
              ["/api/nft-listings", "GET / POST", "Market listings (JSON store)"],
              ["/api/world", "POST", "Save narrative world config for a collection"],
              ["/api/world/[id]", "GET", "Fetch world config or null"],
              ["/api/world/narrative/[token_id]", "GET", "Fetch saved narrative for a token"],
              ["/api/narrator", "POST", "Generate narrative via Gemini + save (idempotent)"],
              ["/api/og/chamber", "GET", "Dynamic Open Graph image for Chamber URLs"],
            ],
          },
        ],
      },
      {
        id: "security",
        title: "Security model",
        blocks: [
          {
            type: "p",
            text: "The server never holds user keys. All signing happens in the client's wallet. The Soroban contract is the source of truth — ownership, collections, and settlement state are always read from the ledger, not from the server's store.",
          },
          {
            type: "table",
            headers: ["What the server holds", "Why"],
            rows: [
              ["ADMIN_SECRET_KEY / FAUCET_DISTRIBUTOR_SECRET_KEY", "Pay faucet rewards (mint or transfer)"],
              ["PINATA_JWT", "Upload metadata to IPFS"],
              ["GOOGLE_AI_STUDIO_API_KEY", "Gemini calls"],
              ["CLASSIC_LIQ_ISSUER_SECRET (optional)", "Classic PHASELQ asset bootstrap"],
            ],
          },
          {
            type: "p",
            text: "x402 verification decodes the actual Soroban transaction — it validates the invocation arguments, payer address, and amount against the challenge parameters. The server does not release AI output based on client assertions.",
          },
        ],
      },
      {
        id: "links",
        title: "References and standards",
        blocks: [
          {
            type: "links",
            items: [
              {
                label: "x402 on Stellar (official guide)",
                href: "https://developers.stellar.org/docs/build/agentic-payments/x402",
                description: "Canonical x402 flow on Stellar, compatible wallets, and facilitator options.",
              },
              {
                label: "x402-stellar (npm)",
                href: "https://www.npmjs.com/package/x402-stellar",
                description: "Official package for x402 payment flows on Stellar.",
              },
              {
                label: "SEP-50 (NFT on Soroban)",
                href: "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0050.md",
                description: "Draft standard for NFT/collectible interfaces in Stellar Soroban.",
              },
              {
                label: "SEP-41 (token interface)",
                href: "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md",
                description: "Standard interface for fungible tokens on Soroban.",
              },
              {
                label: "Stellar Asset Contract",
                href: "https://developers.stellar.org/docs/tokens/stellar-asset-contract",
                description: "How Stellar represents classic assets as Soroban contracts (SAC).",
              },
              {
                label: "Soroban — Smart contracts",
                href: "https://developers.stellar.org/docs/build/smart-contracts",
                description: "Smart contracts on Stellar: Rust, WASM, testing workflow.",
              },
              {
                label: "Stellar Expert (testnet)",
                href: "https://stellar.expert/explorer/testnet",
                description: "Block explorer for accounts, contracts, and transactions.",
              },
            ],
          },
        ],
      },
    ],
  },
}

export function sanitizeDocText(text: string): string {
  if (typeof text !== "string") return ""
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
}

// ─── phase-668: integration recipes ──────────────────────────────────────────
// Snippet code is shared by both languages so EN and ES can never drift apart.
// lib/__tests__/integration-recipes.test.ts extracts every snippet from the
// rendered page data and runs it against the real route handlers, so a
// breaking API change fails CI until the affected recipe is updated in the
// same PR. Snippets are plain JavaScript (no imports, no process.env): they
// receive everything through one context argument.

const RECIPE_CODE: Record<IntegrationRecipeId, string> = {
  "trustline-bootstrap": `// StellarSdk = import * as StellarSdk from "@stellar/stellar-sdk"
// wallet.signTransaction(xdr) = Freighter / Stellar Wallets Kit. Signing stays in the browser.
async function ensurePhaseTrustline({ baseUrl, wallet, StellarSdk, maxAttempts = 2 }) {
  const statusRes = await fetch(baseUrl + "/api/classic-liq?walletAddress=" + encodeURIComponent(wallet.address))
  const info = await statusRes.json()
  if (!statusRes.ok) return { ok: false, code: "STATUS_UNAVAILABLE", error: info.error }
  if (!info.status.accountExists) return { ok: false, code: "ACCOUNT_MISSING" }
  if (info.status.hasTrustline) return { ok: true, alreadyTrusted: true }

  const horizon = new StellarSdk.Horizon.Server("https://horizon-testnet.stellar.org")
  const asset = new StellarSdk.Asset(info.asset.code, info.asset.issuer)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Rebuild from a fresh sequence on every attempt: an expired envelope can't be resubmitted.
    const account = await horizon.loadAccount(wallet.address)
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(StellarSdk.Operation.changeTrust({ asset }))
      .setTimeout(60)
      .build()
    const signedXdr = await wallet.signTransaction(tx.toXDR())
    const res = await fetch(baseUrl + "/api/classic-liq/trustline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedXdr }),
    })
    const body = await res.json()
    if (res.ok && body.ok === true) return { ok: true, hash: body.hash, attempts: attempt }
    if (body.code !== "tx_too_late") {
      return { ok: false, code: "SUBMIT_FAILED", resultCode: body.code, error: body.error }
    }
  }
  return { ok: false, code: "TX_TOO_LATE" }
}`,

  "liq-bootstrap-claim": `async function claimPhaseLiqBootstrap({ baseUrl, wallet }) {
  const res = await fetch(baseUrl + "/api/classic-liq", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet.address }),
  })
  const body = await res.json()
  if (res.ok && body.ok === true) return { ok: true, hash: body.hash, amount: body.amount }
  // 409: an earlier request already paid this wallet, possibly one whose response
  // was lost to a client timeout. The claim is idempotent, so this is success.
  if (res.status === 409) return { ok: true, alreadyFunded: true, fundedAt: body.fundedAt }
  if (res.status === 412) {
    return { ok: false, code: body.code === "trustline_missing" ? "TRUSTLINE_MISSING" : "ACCOUNT_MISSING" }
  }
  if (res.status === 503) return { ok: false, code: "BOOTSTRAP_DISABLED" }
  return { ok: false, code: "SUBMIT_FAILED", resultCode: body.code, error: body.error }
}`,

  "x402-settle": `async function settleX402Invoice({ baseUrl, wallet, invoice, amountStroops }) {
  const paymentToken = btoa(JSON.stringify({ invoice, amount: amountStroops, network: "stellar-testnet" }))
  const res = await fetch(baseUrl + "/api/x402/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payment_token: paymentToken, user_address: wallet.address }),
  })
  const body = await res.json()
  // Never infer success from a 200 alone: require the explicit settled flag.
  if (res.ok && body.settled === true) {
    return { ok: true, invoice: body.invoice, tokenContract: body.token_contract }
  }
  if (res.status === 401) return { ok: false, code: "PAYMENT_INSUFFICIENT" }
  if (res.status === 503) return { ok: false, code: "SETTLEMENT_UNAVAILABLE" }
  return { ok: false, code: "BAD_REQUEST", error: body.error }
}`,

  "forge-job-polling": `async function waitForForgeJob({
  baseUrl,
  txHash,
  intervalMs = 4000,
  timeoutMs = 180000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(baseUrl + "/api/jobs/" + encodeURIComponent(txHash), { cache: "no-store" })
    if (res.status === 400) return { ok: false, code: "INVALID_TX_HASH" }
    if (res.ok) {
      const { job } = await res.json()
      if (job.status === "completed") return { ok: true, job }
      if (job.status === "failed") return { ok: false, code: "JOB_FAILED", error: job.error }
    }
    // 404: the job row is not written yet (settlement still confirming). 5xx: transient. Keep polling.
    await sleep(intervalMs)
  }
  return { ok: false, code: "TIMEOUT" }
}`,

  "ownership-listing": `async function listOwnedPhaseNfts({ baseUrl, address }) {
  const res = await fetch(baseUrl + "/api/wallet/phase-nfts?address=" + encodeURIComponent(address))
  const body = await res.json()
  if (res.status === 400) return { ok: false, code: "INVALID_ADDRESS" }
  if (!res.ok) return { ok: false, code: "CONFIG_ERROR", error: body.detail }
  // The route answers 200 even when every index path failed. Check indexedVia.
  if (body.indexedVia === "unavailable") return { ok: false, code: "INDEX_UNAVAILABLE", retryable: true }
  return {
    ok: true,
    contractId: body.contractId,
    stale: body.indexedVia.endsWith("-stale"),
    items: body.items,
  }
}`,
}

const RECIPE_ENTRY: Record<IntegrationRecipeId, string> = {
  "trustline-bootstrap": "ensurePhaseTrustline",
  "liq-bootstrap-claim": "claimPhaseLiqBootstrap",
  "x402-settle": "settleX402Invoice",
  "forge-job-polling": "waitForForgeJob",
  "ownership-listing": "listOwnedPhaseNfts",
}

type RecipeText = Omit<DocsRecipe, "id" | "entry" | "code">

const RECIPE_TEXT: Record<LandingLang, Record<IntegrationRecipeId, RecipeText>> = {
  es: {
    "trustline-bootstrap": {
      title: "1. Trustline PHASELQ",
      summary:
        "Abre la trustline clásica de PHASELQ desde la wallet del usuario. El servidor nunca firma: solo envía a Horizon el XDR que la wallet ya firmó.",
      steps: [
        "GET /api/classic-liq?walletAddress= devuelve el asset (code + issuer) y el estado de la cuenta.",
        "Si la trustline ya existe, termina sin firmar nada.",
        "Construye changeTrust con la secuencia actual, fírmalo en Freighter y envíalo a POST /api/classic-liq/trustline.",
      ],
      failures: [
        { when: "La cuenta no existe en testnet", outcome: "ACCOUNT_MISSING: fondéala con Friendbot y vuelve a ejecutar." },
        { when: "Horizon responde tx_too_late", outcome: "Reconstruye con secuencia nueva y reintenta; tras maxAttempts devuelve TX_TOO_LATE." },
        { when: "Cualquier otro rechazo de Horizon", outcome: "SUBMIT_FAILED con resultCode de Horizon (p. ej. tx_bad_seq)." },
      ],
    },
    "liq-bootstrap-claim": {
      title: "2. Fondeo inicial de PHASELQ",
      summary:
        "Reclama el fondeo inicial de PHASELQ clásico. Es idempotente por wallet: reintentar tras un timeout nunca paga dos veces.",
      steps: [
        "POST /api/classic-liq con walletAddress.",
        "El servidor comprueba cuenta y trustline, reserva el claim bajo lock y paga desde el issuer.",
      ],
      failures: [
        { when: "Falta la trustline", outcome: "TRUSTLINE_MISSING (412): ejecuta la receta 1 primero." },
        { when: "La cuenta no existe", outcome: "ACCOUNT_MISSING (412)." },
        { when: "Ya se reclamó (doble envío, timeout)", outcome: "409 tratado como éxito: alreadyFunded con fundedAt." },
        { when: "Fondeo no configurado en el servidor", outcome: "BOOTSTRAP_DISABLED (503)." },
        { when: "Horizon rechaza el pago", outcome: "SUBMIT_FAILED; el claim se libera y se puede reintentar." },
      ],
    },
    "x402-settle": {
      title: "3. Settlement x402 (shim local)",
      summary:
        "Liquida una factura x402 contra el shim local de demo. Solo testnet: en producción el settlement es la transacción Soroban settle.",
      steps: [
        "Codifica { invoice, amount, network } en base64 como payment_token.",
        "POST /api/x402/settle y exige settled === true en la respuesta.",
      ],
      failures: [
        { when: "Monto menor que REQUIRED_AMOUNT o sin invoice", outcome: "PAYMENT_INSUFFICIENT (401)." },
        { when: "Shim deshabilitado (X402_LOCAL_SHIM_ENABLED)", outcome: "SETTLEMENT_UNAVAILABLE (503)." },
        { when: "Body inválido", outcome: "BAD_REQUEST (400)." },
      ],
    },
    "forge-job-polling": {
      title: "4. Seguimiento del job de la Forja",
      summary:
        "Tras el settlement, consulta el estado del job de generación con el hash de la transacción hasta que termine.",
      steps: [
        "GET /api/jobs/{txHash} cada 3–5 s.",
        "Termina en completed o failed; 404 significa que el job aún no existe.",
      ],
      failures: [
        { when: "txHash inválido", outcome: "INVALID_TX_HASH (400), sin reintentos." },
        { when: "El pipeline falla", outcome: "JOB_FAILED con el error del job." },
        { when: "No termina antes de timeoutMs", outcome: "TIMEOUT." },
      ],
    },
    "ownership-listing": {
      title: "5. NFTs de una wallet",
      summary:
        "Lista los artefactos PHASE de una wallet con metadata. La ruta responde 200 aunque el índice falle, así que la receta revisa indexedVia.",
      steps: [
        "GET /api/wallet/phase-nfts?address=.",
        "Usa contractId de la respuesta; nunca lo fijes en el código.",
      ],
      failures: [
        { when: "Dirección inválida", outcome: "INVALID_ADDRESS (400)." },
        { when: "Todos los índices caídos y sin caché", outcome: "INDEX_UNAVAILABLE con retryable: true." },
        { when: "Índice servido desde caché vieja (phase-135)", outcome: "ok con stale: true." },
      ],
    },
  },
  en: {
    "trustline-bootstrap": {
      title: "1. PHASELQ trustline",
      summary:
        "Open the classic PHASELQ trustline from the user's wallet. The server never signs: it only forwards the XDR the wallet already signed to Horizon.",
      steps: [
        "GET /api/classic-liq?walletAddress= returns the asset (code + issuer) and the account status.",
        "If the trustline already exists, stop without signing anything.",
        "Build changeTrust from the current sequence, sign it in Freighter, and send it to POST /api/classic-liq/trustline.",
      ],
      failures: [
        { when: "Account does not exist on testnet", outcome: "ACCOUNT_MISSING: fund it with Friendbot and rerun." },
        { when: "Horizon returns tx_too_late", outcome: "Rebuild with a fresh sequence and retry; after maxAttempts returns TX_TOO_LATE." },
        { when: "Any other Horizon rejection", outcome: "SUBMIT_FAILED with Horizon's resultCode (e.g. tx_bad_seq)." },
      ],
    },
    "liq-bootstrap-claim": {
      title: "2. PHASELQ bootstrap funding",
      summary:
        "Claim the initial classic PHASELQ funding. It is idempotent per wallet: retrying after a timeout never pays twice.",
      steps: [
        "POST /api/classic-liq with walletAddress.",
        "The server checks account and trustline, reserves the claim under a lock, and pays from the issuer.",
      ],
      failures: [
        { when: "Trustline missing", outcome: "TRUSTLINE_MISSING (412): run recipe 1 first." },
        { when: "Account does not exist", outcome: "ACCOUNT_MISSING (412)." },
        { when: "Already claimed (double submit, timeout)", outcome: "409 treated as success: alreadyFunded with fundedAt." },
        { when: "Funding not configured on the server", outcome: "BOOTSTRAP_DISABLED (503)." },
        { when: "Horizon rejects the payment", outcome: "SUBMIT_FAILED; the claim is released so the call can be retried." },
      ],
    },
    "x402-settle": {
      title: "3. x402 settlement (local shim)",
      summary:
        "Settle an x402 invoice against the local demo shim. Testnet only: in production, settlement is the Soroban settle transaction.",
      steps: [
        "Base64-encode { invoice, amount, network } as payment_token.",
        "POST /api/x402/settle and require settled === true in the response.",
      ],
      failures: [
        { when: "Amount below REQUIRED_AMOUNT or no invoice", outcome: "PAYMENT_INSUFFICIENT (401)." },
        { when: "Shim disabled (X402_LOCAL_SHIM_ENABLED)", outcome: "SETTLEMENT_UNAVAILABLE (503)." },
        { when: "Invalid body", outcome: "BAD_REQUEST (400)." },
      ],
    },
    "forge-job-polling": {
      title: "4. Forge job tracking",
      summary:
        "After settlement, poll the generation job by transaction hash until it finishes.",
      steps: [
        "GET /api/jobs/{txHash} every 3–5 s.",
        "Stop on completed or failed; 404 means the job does not exist yet.",
      ],
      failures: [
        { when: "Invalid txHash", outcome: "INVALID_TX_HASH (400), no retries." },
        { when: "The pipeline fails", outcome: "JOB_FAILED with the job's error." },
        { when: "Not finished before timeoutMs", outcome: "TIMEOUT." },
      ],
    },
    "ownership-listing": {
      title: "5. A wallet's NFTs",
      summary:
        "List a wallet's PHASE artifacts with metadata. The route answers 200 even when the index fails, so the recipe checks indexedVia.",
      steps: [
        "GET /api/wallet/phase-nfts?address=.",
        "Use contractId from the response; never hardcode it.",
      ],
      failures: [
        { when: "Invalid address", outcome: "INVALID_ADDRESS (400)." },
        { when: "Every index path down and nothing cached", outcome: "INDEX_UNAVAILABLE with retryable: true." },
        { when: "Index served from stale cache (phase-135)", outcome: "ok with stale: true." },
      ],
    },
  },
}

const RECIPE_SECTION_TEXT: Record<LandingLang, { title: string; intro: string }> = {
  es: {
    title: "Recetas de integración",
    intro:
      "Código ejecutable para integrar PHASE desde tu app, en orden: trustline → fondeo → pago → job → NFTs. Cada fragmento se ejecuta en CI contra las rutas reales, incluidas sus ramas de error. Todo apunta a testnet.",
  },
  en: {
    title: "Integration recipes",
    intro:
      "Runnable code for integrating PHASE from your app, in order: trustline → funding → payment → job → NFTs. Every snippet runs in CI against the real routes, failure branches included. Everything targets testnet.",
  },
}

export const INTEGRATION_RECIPE_IDS = Object.keys(RECIPE_CODE) as IntegrationRecipeId[]

function recipesSection(lang: LandingLang): DocsSection {
  return {
    id: "recipes",
    title: RECIPE_SECTION_TEXT[lang].title,
    blocks: [
      { type: "p", text: RECIPE_SECTION_TEXT[lang].intro },
      ...INTEGRATION_RECIPE_IDS.map(
        (id): DocsBlock => ({
          type: "recipe",
          recipe: { id, entry: RECIPE_ENTRY[id], code: RECIPE_CODE[id], ...RECIPE_TEXT[lang][id] },
        }),
      ),
    ],
  }
}

export function pickProjectDocs(lang: LandingLang, opts: { recipes?: boolean } = {}): ProjectDocsPage {
  const page = projectDocs[lang]
  if (!opts.recipes) return page
  // Recipes go just before the external links section.
  const linksAt = page.sections.findIndex((s) => s.id === "links")
  const sections = [...page.sections]
  sections.splice(linksAt === -1 ? sections.length : linksAt, 0, recipesSection(lang))
  return { ...page, sections }
}
