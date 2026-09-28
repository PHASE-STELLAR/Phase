/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@creit.tech/stellar-wallets-kit"],
  // Rust build trees are committed in this repo; exclude from serverless traces (250 MB limit on Vercel).
  outputFileTracingExcludes: {
    "*": ["./contracts/**/*", "./scripts/**/*"],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "gateway.pinata.cloud",
        pathname: "/ipfs/**",
      },
      {
        protocol: "https",
        hostname: "ipfs.io",
        pathname: "/ipfs/**",
      },
      {
        protocol: "https",
        hostname: "dweb.link",
        pathname: "/ipfs/**",
      },
      {
        protocol: "https",
        hostname: "*.nanobananaapi.ai",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "nanobananaapi.ai",
        pathname: "/**",
      },
    ],
  },
  async headers() {
    return [
      // Security headers — applied to every route
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options",             value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options",       value: "nosniff" },
          { key: "Strict-Transport-Security",    value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Cross-Origin-Opener-Policy",   value: "same-origin-allow-popups" },
          { key: "Referrer-Policy",              value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy",           value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://vercel.live https://va.vercel-scripts.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https: http:",
              "font-src 'self' data: https://fonts.gstatic.com",
              "connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
              "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org https://albedo.link",
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              "form-action 'self'",
              "base-uri 'self'",
              "manifest-src 'self'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/.well-known/stellar.toml",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
        ],
      },
      {
        source: "/phaser-liq-token.png",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Cache-Control",                value: "public, max-age=86400, must-revalidate" },
        ],
      },
      {
        source: "/assets/(.*)",
        headers: [
          { key: "Cache-Control",                value: "public, max-age=86400, must-revalidate" },
        ],
      },
    ]
  },
}

export default nextConfig
