import type { NextConfig } from "next";

// Security headers that do not vary per request. The Content-Security-Policy
// (nonce-based) is set in middleware.ts so scripts can be allowed per request.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@print/shared", "@print/db", "@print/geometry"],
  poweredByHeader: false,
  experimental: {
    // three.js and react-pdf are large; keep them out of the server bundle graph
    // where possible.
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
