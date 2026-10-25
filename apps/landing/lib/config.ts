/**
 * Build-time configuration for the static landing page.
 *
 * NEXT_PUBLIC_* values are inlined by Next when the site is built, so each one
 * must be referenced literally (no dynamic process.env lookups). Optional links
 * are null when unset or invalid, and the page hides them instead of showing a
 * dead placeholder.
 */

function httpUrl(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Where every "Launch app" button points: the local web terminal unless overridden. */
export const APP_URL: string = httpUrl(process.env.NEXT_PUBLIC_APP_URL) ?? 'http://127.0.0.1:7703';

/**
 * The hosted mainnet demo (real ZEC, a tiny hard-capped shared wallet). Only the final CTA links to
 * it, next to Launch app; hidden when unset.
 */
export const MAINNET_DEMO_URL: string | null = httpUrl(process.env.NEXT_PUBLIC_MAINNET_URL);

/** Public source repository (e.g. https://github.com/org/silicr). Repo links are hidden when unset. */
export const REPO_URL: string | null = httpUrl(process.env.NEXT_PUBLIC_REPO_URL);

/** Branch used for links to files in the repo (GitHub-style /blob/<branch>/<path>). */
export const REPO_BRANCH: string = (process.env.NEXT_PUBLIC_REPO_BRANCH ?? '').trim() || 'main';

/** Recorded demo video. The link is hidden when unset. */
export const DEMO_VIDEO_URL: string | null = httpUrl(process.env.NEXT_PUBLIC_DEMO_VIDEO_URL);

/**
 * Public URL this page is served from. Only used to make the Open Graph and
 * Twitter image URLs absolute; without it those image tags are left out.
 */
export const SITE_URL: string | null = httpUrl(process.env.NEXT_PUBLIC_SITE_URL);

/** Link to a file in the repo, or null when no repo URL is configured. */
export function repoFileUrl(path: string): string | null {
  return REPO_URL ? `${REPO_URL}/blob/${encodeURI(REPO_BRANCH)}/${path}` : null;
}
