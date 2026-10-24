import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/**
 * Static export: the landing page is plain files that can be hosted anywhere.
 *
 * With `output: 'export'`, Next treats a custom `distDir` as the export target
 * and always keeps its build internals in `.next` (see hasCustomExportOutput in
 * next/dist/export/utils.js). So builds never set distDir: the site always lands
 * in `out/`. SILICR_NEXT_DIST still moves the dev server's directory if set. In
 * Next 16 `next dev` works in `.next/dev`, so a build can run while dev is up.
 */
export default function config(phase: string): NextConfig {
  const devDist = phase !== PHASE_PRODUCTION_BUILD ? process.env.SILICR_NEXT_DIST : undefined;
  return {
    output: 'export',
    ...(devDist ? { distDir: devDist } : {}),
    images: { unoptimized: true },
    reactStrictMode: true,
    poweredByHeader: false,
  };
}
