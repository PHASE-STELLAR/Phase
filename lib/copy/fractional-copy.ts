/**
 * phase-80: EN/ES copy for fractional-ownership UI.
 * Keys are stable — add languages, never rename.
 */

export type FractionalLang = "en" | "es"

export type FractionalCopy = {
  pageTitle: string
  pageDescription: string
  noEscrowDisclaimer: string
  createListing: {
    heading: string
    totalSharesLabel: string
    sharePriceLabel: string
    submitButton: string
  }
  listing: {
    sharesAvailable: string
    totalShares: string
    holderCount: string
    holderCapLabel: string
    statusListing: string
    statusFullyOwned: string
    statusCancelled: string
    buyShares: string
    sharesLabel: string
    confirmPurchase: string
  }
  errors: {
    holderCapReached: string
    notEnoughShares: string
    concurrentConflict: string
    flagDisabled: string
  }
}

const copy: Record<FractionalLang, FractionalCopy> = {
  en: {
    pageTitle: "Co-ownership",
    pageDescription:
      "Buy fractional shares in high-value artifacts. 2–10,000 shares per listing, up to 100 co-owners.",
    noEscrowDisclaimer:
      "Share balances are recorded off-chain. No on-chain escrow exists for this feature yet.",
    createListing: {
      heading: "Create a co-ownership listing",
      totalSharesLabel: "Total shares (2–10,000)",
      sharePriceLabel: "Share price (stroops)",
      submitButton: "Create listing",
    },
    listing: {
      sharesAvailable: "shares available",
      totalShares: "total shares",
      holderCount: "co-owners",
      holderCapLabel: "Max 100 co-owners",
      statusListing: "Open",
      statusFullyOwned: "Fully owned",
      statusCancelled: "Cancelled",
      buyShares: "Buy shares",
      sharesLabel: "Number of shares",
      confirmPurchase: "Confirm purchase",
    },
    errors: {
      holderCapReached: "This listing has reached the 100 co-owner cap.",
      notEnoughShares: "Not enough shares available. Try a smaller amount.",
      concurrentConflict:
        "Someone else just bought shares at the same time. Please refresh and try again.",
      flagDisabled: "Co-ownership is not enabled on this instance.",
    },
  },
  es: {
    pageTitle: "Co-propiedad",
    pageDescription:
      "Compra fracciones de artefactos de alto valor. De 2 a 10 000 participaciones por listado, hasta 100 co-propietarios.",
    noEscrowDisclaimer:
      "Los saldos de participaciones se registran fuera de la cadena. Aún no existe custodia en cadena para esta función.",
    createListing: {
      heading: "Crear un listado de co-propiedad",
      totalSharesLabel: "Total de participaciones (2–10 000)",
      sharePriceLabel: "Precio por participación (stroops)",
      submitButton: "Crear listado",
    },
    listing: {
      sharesAvailable: "participaciones disponibles",
      totalShares: "participaciones totales",
      holderCount: "co-propietarios",
      holderCapLabel: "Máximo 100 co-propietarios",
      statusListing: "Abierto",
      statusFullyOwned: "Completamente comprado",
      statusCancelled: "Cancelado",
      buyShares: "Comprar participaciones",
      sharesLabel: "Número de participaciones",
      confirmPurchase: "Confirmar compra",
    },
    errors: {
      holderCapReached: "Este listado ha alcanzado el límite de 100 co-propietarios.",
      notEnoughShares:
        "No hay suficientes participaciones disponibles. Intenta con una cantidad menor.",
      concurrentConflict:
        "Alguien más compró participaciones al mismo tiempo. Actualiza la página e intenta de nuevo.",
      flagDisabled: "La co-propiedad no está habilitada en esta instancia.",
    },
  },
}

export function getFractionalCopy(lang: FractionalLang = "en"): FractionalCopy {
  return copy[lang] ?? copy.en
}
