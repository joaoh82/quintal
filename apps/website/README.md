# Quintal marketing website

Independent Next.js app for quintal.sh. No office server or database needed.

From the repository root:

```sh
pnpm install
pnpm --filter @quintal/website dev       # http://localhost:3100
pnpm --filter @quintal/website typecheck
pnpm --filter @quintal/website build
```

The production build exports static files to `apps/website/out/`. Deploy that directory to any static host; use its `404.html` for missing pages. The office's existing build and server do not include this app. Port 3000 remains untouched.

## Documentation

The `/docs/` index links to the current technical documentation in the public repository. The local quickstart is a real MDX route at `src/app/docs/getting-started/page.mdx`. Add future guides as `src/app/docs/<slug>/page.mdx`, export `metadata`, and add navigation in `src/app/docs/layout.tsx` and entries to `src/app/sitemap.ts`. MDX can import components; compile only trusted, repository-owned content.

## Design and assets

DM Sans is self-hosted through Fontsource. Theme colors follow the system preference, and interactions respect reduced motion. Screenshots are optimized WebP derivatives of the repository's `screenshots/` assets; the originals are unchanged. Only screenshots not flagged for stale warnings in the brief are used. Pixel art in the product is from Kenney; see `apps/web/public/assets/CREDITS.md`.

The website uses static export and precompressed responsive screenshots through the `Screenshot` component. There is no runtime image server. Each screenshot has 640px, 960px, and full-size WebP versions. Use compression and cache headers on the static host, with immutable caching for `/_next/static/`. After changing domains, update the metadata base, robots, and sitemap.

The platform logo and its generation prompt are in `public/brand/`. The full-resolution transparent PNG is the master; the small PNG and 64px site icon are optimized delivery assets. See `public/brand/README.md` for colors and usage.
