# @silicr/landing

The Silicr landing page: one long, static page (Next.js `output: 'export'`) whose "Launch app" buttons open the local web terminal (`apps/web`).

## Run

```bash
pnpm --filter @silicr/landing dev        # http://127.0.0.1:7704
pnpm --filter @silicr/landing typecheck
SILICR_NEXT_DIST=.next-build pnpm --filter @silicr/landing build   # static site in apps/landing/out
```

`SILICR_NEXT_DIST` moves the build's working directory, so a production build can run while `next dev` holds `.next`. The output in `out/` is plain files: serve it from any static host.

## Configuration

All optional; see [.env.example](.env.example). Values are inlined at build time.

| Variable | Default | Effect |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `http://127.0.0.1:7703` | Target of every "Launch app" button |
| `NEXT_PUBLIC_REPO_URL` | unset | Shows the Source, Threat model and `git clone` links |
| `NEXT_PUBLIC_REPO_BRANCH` | `main` | Branch for links to files in the repo |
| `NEXT_PUBLIC_DEMO_VIDEO_URL` | unset | Shows the "Watch the demo" links |
| `NEXT_PUBLIC_SITE_URL` | unset | Makes the Open Graph / Twitter image (`public/og.png`) URL absolute; without it the image tags are omitted |

Unset links are hidden, never shown as placeholders.

## Rules for this page

- **Claims must match the code and the docs.** The Leak Inspector matrix and the protect/limits lists are copied from `THREAT_MODEL.md`; update them together. Settlement numbers are computed in `lib/settlement.ts` with the engine's own rules (`perInterval`, `padBucket`, ZIP 317) and the payment timing in `ARCHITECTURE.md` §4 (buyer's clock, 60 s lead, about 1.25 intervals of exposure), not typed in.
- **No third-party requests.** Fonts are self-hosted by `next/font`; no external images, scripts or analytics; no cookies. The footer says so, so check after every build:

  ```bash
  # Absolute URLs in HTML attributes: expect only <a href> links you configured (and og:image on your own site).
  grep -rhoE '(src|href|content)="https?://[^"]+"' apps/landing/out --include='*.html' | sort -u
  # Tags that would load something from another origin, and CSS url()s: expect no output.
  grep -rhoE '<(script|link|img|iframe)[^>]+(src|href)="(https?:)?//[^"]+"' apps/landing/out --include='*.html'
  grep -rhoE 'url\(.?https?://[^)]*\)' apps/landing/out --include='*.css'
  ```

  The JS bundles also contain URL-like string literals (React/Next error-doc links, core-js feature tests, SVG namespaces); none of them is fetched. A headless-browser network capture of the built page shows only same-origin requests.
- Colors are the terminal's tokens (`apps/web/app/globals.css`); the theme toggle stores `silicr-theme` in localStorage, as the terminal does.
