import type React from "react"
import type { Metadata } from "next"
import { IBM_Plex_Sans, IBM_Plex_Mono, Bebas_Neue, Orbitron } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { AppProviders } from "@/components/app-providers"
import { SmoothScroll } from "@/components/smooth-scroll"
import { WebVitalsReporter } from "@/components/web-vitals-reporter"
import "./globals.css"

const PRODUCTION_SITE = "https://www.phasee.xyz"

function siteMetadataBase(): URL {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim()?.replace(/\/+$/, "")
  if (fromEnv) return new URL(fromEnv.includes("://") ? fromEnv : `https://${fromEnv}`)
  // Production must not use VERCEL_URL for OG/canonical: preview hostnames break crawlers
  // (e.g. WhatsApp falls back to favicon if og:image is on an unreachable deployment URL).
  if (process.env.VERCEL_ENV === "production") return new URL(PRODUCTION_SITE)
  const vercel = process.env.VERCEL_URL?.trim()?.replace(/\/+$/, "")
  if (vercel) return new URL(`https://${vercel}`)
  return new URL(PRODUCTION_SITE)
}

const ibmPlexSans = IBM_Plex_Sans({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
})
const ibmPlexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  fallback: ["monospace"],
})
const bebasNeue = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bebas",
  display: "optional",
  fallback: ["sans-serif"],
})
const orbitron = Orbitron({
  subsets: ["latin"],
  variable: "--font-orbitron",
  weight: ["600", "700", "800"],
  display: "optional",
  fallback: ["sans-serif"],
})

const defaultTitle = "P H A S E   P R O T O C O L"
const defaultDescription =
  "PHASE is a cryptographic paywall for AI-generated NFTs on Stellar Soroban. Pay with PHASELQ via x402. The ledger confirms. Your artifact is minted."

const metadataBaseResolved = siteMetadataBase()
const canonicalUrl = new URL("/", metadataBaseResolved).href

function ogImageUrl(): string {
  const override = process.env.NEXT_PUBLIC_OG_IMAGE_URL?.trim()
  if (override) return override
  return new URL("/og-phase.png", metadataBaseResolved).href
}

export const metadata: Metadata = {
  metadataBase: metadataBaseResolved,
  title: {
    template: "%s | P H A S E",
    default: defaultTitle,
  },
  description: defaultDescription,
  keywords: [
    "Stellar",
    "Soroban",
    "Web3",
    "x402",
    "NFT",
    "Digital Artifacts",
    "SEP-41",
    "SEP-50",
    "creators",
    "PHASE Protocol",
  ],
  alternates: {
    canonical: canonicalUrl,
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: canonicalUrl,
    title: defaultTitle,
    description: defaultDescription,
    siteName: "P H A S E   P R O T O C O L",
    images: [
      {
        url: ogImageUrl(),
        width: 1024,
        height: 573,
        alt: "PHASE Protocol — x402 settlement on Soroban: liquid energy to solid-state artifacts",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: defaultDescription,
    images: [ogImageUrl()],
  },
  icons: {
    icon: [{ url: "/icon-sphere.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
    shortcut: "/icon-sphere.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark bg-background" suppressHydrationWarning>
      <body
        className={`${ibmPlexSans.variable} ${bebasNeue.variable} ${ibmPlexMono.variable} ${orbitron.variable} font-sans antialiased overflow-x-hidden`}
      >
        <div className="noise-overlay" aria-hidden="true" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              "name": "PHASE Protocol",
              "description": "Cryptographic paywall for AI-generated NFTs on Stellar Soroban",
              "url": "https://www.phasee.xyz",
              "applicationCategory": "BlockchainApplication",
              "operatingSystem": "Web",
            }),
          }}
        />
        <SmoothScroll>
          <AppProviders>
            <WebVitalsReporter />
            {children}
          </AppProviders>
        </SmoothScroll>
        <Analytics />
      </body>
    </html>
  )
}
