import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Separate output dir for production builds (SILICR_NEXT_DIST=.next-build) so a
  // build never touches a running dev server's .next.
  distDir: process.env.SILICR_NEXT_DIST ?? '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  // @silicr/api ships TypeScript source (type-only; nothing from it reaches the bundle).
  transpilePackages: ['@silicr/api'],
  // Allow opening the dev server as http://127.0.0.1:7703 as well as localhost.
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
