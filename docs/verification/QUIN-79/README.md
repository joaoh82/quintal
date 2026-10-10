# QUIN-79 — website getting-started and download for the personal office

Verified locally on 2026-10-10 in the `ys/update-website-s-getting` worktree,
against the static export at `http://127.0.0.1:3106` (`apps/website/out`).

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm --filter @quintal/website build` | PASS; `/`, `/download/`, `/docs/getting-started/` statically exported |
| `pnpm --filter @quintal/website typecheck` | PASS |
| `node scripts/check-release-links.mjs` | PASS; 5 installers on `/download`, 112 files checked |
| `git diff --check` | PASS |

## Smoke checks

- `/`, `/download/`, `/docs/getting-started/`, `/sitemap.xml` → HTTP 200.
- Download OCR of §2 includes **Create a personal office** and **“Local” means
  Quintal and your agents run on this computer… Neither mode promises offline AI**.
- Getting-started viewport shows the same Local / cloud-backed boundary.
- Home HTML contains `A personal office runs inside the app` and
  `Host people with Docker` (not `Run your own office with Docker`).
- Picker screenshot OCR: **Where is your office?** / **Create a personal office**
  (from v0.7.0 `appimage-smoke`, cropped into `screenshots/release-smoke/`).

### Evidence

| File | What it shows |
| --- | --- |
| [download.png](./download.png) | Install-first download page (1440×1100) |
| [download-open-office.png](./download-open-office.png) | §2 Open your office + Local boundary (OCR’d) |
| [getting-started.png](./getting-started.png) | Quickstart with Local boundary visible |
| [home.png](./home.png) | Landing hero |

## Scope limits

Native OS installs, Docker self-hosting guide, and Stage 2 agent onboarding
were out of ticket scope. The committed picker PNGs are cropped from the
Linux AppImage smoke; a clean-machine macOS DMG retake can replace them later
under the same filenames.
