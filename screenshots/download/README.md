# Download page verification — QUIN-36

Verified locally on 2026-09-15 in the implementation worktree, using Node
24.13.0 and pnpm 11.0.9. The browser checked the production static export served
at `http://127.0.0.1:3106`; nothing was started on port 3000.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm --filter @quintal/website build` | PASS; `/download` is statically prerendered |
| `pnpm --filter @quintal/website typecheck` | PASS |
| `pnpm test:release` | PASS; 7 tests, 0 failures |
| `node scripts/check-release-links.mjs` | PASS; all 5 installers referenced, 28 source/doc files checked |
| Rename one manifest asset | PASS; checker exits 1 with unknown old name and missing renamed installer |
| Inject an invalid download URL separately in README, desktop docs and quickstart | PASS; checker exits 1 for each location |
| Restore sabotage edits and rerun checker | PASS |
| `git diff --check` | PASS |

No standalone lint script is defined for the website. Dependency installation
used the frozen lockfile; the unbuilt ACP workspace CLI produced a bin-link
warning, which did not affect these checks.

## Browser and HTTP smoke checks

- [Light, 1440px](./light.png), [dark, 1440px](./dark.png), and
  [dark mobile, 390px](./mobile-dark.png): three OS cards, five installer buttons,
  setup instructions and first-launch notes render without overlap.
- `/download` at 390px and 320px: `document.documentElement.scrollWidth` equals
  viewport width. The landing page also has no horizontal overflow at 320px.
- Mobile menu exposes Download and clicking it reaches `/download/`.
- The landing hero opens `/download/`; desktop-section and closing-section
  CTA hrefs also equal `/download/`.
- “Bring your first agent” opens `/docs/getting-started/`. Its rendered headings
  start with Start your office, Install the app, Make an identity, and Bring
  your first agent; From source is last.
- Copy button: `writeText` received the exact displayed curl/compose command,
  the real clipboard write promise resolved, and the button displayed `Copied`.
  Direct clipboard readback was denied by browser permissions; it is not claimed
  as verified. A temporary browser-only wrapper recorded the write argument and
  resolution; no application code was changed for this check.
- Browser page-error output was empty.
- `/`, `/download/`, `/docs/getting-started/`, and `/sitemap.xml`: HTTP 200.
  Sitemap includes `https://quintal.sh/download/`.
- README's existing server-picker screenshot is present on disk.

The five links extracted from the exported download page exactly match the
manifest. `curl -fsSLI` returned the following for each:

| Installer | Response chain |
| --- | --- |
| Quintal-macos-arm64.dmg | 302 → 302 → 200 |
| Quintal-macos-x64.dmg | 302 → 302 → 200 |
| Quintal-windows-x64-setup.exe | 302 → 302 → 200 |
| Quintal-linux-x64.AppImage | 302 → 302 → 200 |
| Quintal-linux-x64.deb | 302 → 302 → 200 |

## Scope limits

Backend/database tests, Docker startup, and native installation on each OS were
excluded from the approved plan because their implementation is unchanged.
The new manual GitHub Actions workflow has not been dispatched; the equivalent
live URL checks ran locally. No follow-up issue is recommended from these results.
