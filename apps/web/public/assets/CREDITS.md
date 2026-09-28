# Asset credits

Everything in this directory is CC0 (public domain) or derived from CC0 work.
Quintal itself is AGPL-3.0, but these assets carry no such obligation — you can
lift them for anything.

## The world: Shared World v1.0

**`world/`** — terrain, walls, furniture and the twelve avatars.

- Source: **Shared World** v1.0 (28 September 2026), an art-only pixel library
  authored for Quintal by João Henrique Machado Silva.
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Made with an image-generation tool, then sliced, anchored, alpha-hardened and
  exported at native scale by hand. The external pack at
  <https://masalimov-ilnur.itch.io/pixel-office> was a style reference only; no
  sprite file from it was extracted or included.

The library ships more than a game needs — per-frame PNGs, animated previews,
contact sheets and the generated sources. Only what the browser loads is
vendored here, by `tools/sync-world-assets.mjs`; the same script copies the
pack's art contract to [`docs/world-assets.md`](../../../../docs/world-assets.md),
which is what to follow when drawing more.

| Path | What it is |
| --- | --- |
| `world/terrain/surfaces.png` | 16 seamless 32×32 floor materials, one 128×128 sheet |
| `world/walls/walls.png` | 16 cardinal wall caps. Frame index = N 1 + E 2 + S 4 + W 8 |
| `world/props/*.png` + `.json` | Prop atlases with named frames, in Phaser's atlas format |
| `world/avatars/*.png` | One 256×192 sheet per body: 8 columns × 4 rows of 32×48 frames |

**Scale contracts.** The world grid is 32px (`TILE_SIZE` in `@quintal/shared`).
The 16 retained office props are 64×64 cells anchored at (32,62); every other
prop is a 128×96 cell anchored at (64,94). The padding is padding — a desk is
61×44 inside it, which is why what a prop *blocks* is authored into the map's
`collision` layer rather than taken from its cell. Avatar frames are 32×48 with
the feet at (16,42).

**Avatar sheets.** Rows are south, west, east, north. Columns pair up into idle,
walk, sit and work. The office plays idle and walk; the sit and work frames are
loaded and indexed (`BODY_STATE_COLUMN` in `apps/web/src/game/constants.ts`) but
nothing drives them until the map has seats in it.

To re-vendor after the pack changes:

```sh
node tools/sync-world-assets.mjs /path/to/shared-world-assets-v1
```

## Map

`packages/shared/maps/hq.json` is Quintal's own work (AGPL-3.0, like the rest of
the repo). It is ordinary [Tiled](https://www.mapeditor.org/) JSON and opens in
Tiled, but it is **generated** by `tools/build-hq-map.mjs` — the floor plan, the
wall connection indices, the collision grid and 304 prop placements have to stay
consistent with each other, and that is a job for a script. Edit the builder and
re-run it:

```sh
node tools/build-hq-map.mjs
```

It refuses to write a map whose spawns are blocked or whose zones can't be
walked to. `packages/shared/src/maps/hq.test.ts` checks the committed file for
the same things, because the file is what actually ships.

## Emotes

**`emotes/kenney-emotes-32.png`**

- Source: [Emotes Pack](https://kenney.nl/assets/emotes-pack) v1.0 by
  [Kenney](https://kenney.nl) (2018)
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)

The balloons stayed when the rest of the Kenney art went. They are a UI
vocabulary rather than scenery — a thinking balloon over an agent's head means
the same thing in any art style — and Shared World has no equivalent.

**How this file was derived.** The pack ships 30 balloons in 8 styles as
16×16 PNGs. We took **Pixel / Style 1** (the square balloon with a tail — the
one that sits naturally over a 32px sprite), picked the 21 we use, upscaled each
×2 with **nearest-neighbour** to 32×32, and packed them into a 7×3 sheet. The
order on the sheet is the order in `EMOTE_FRAMES` in
`packages/shared/src/emotes.ts`; change one and regenerate the other.

To reproduce, with the pack unzipped at `assets/kenney_emotes-pack/`:

```python
from PIL import Image
src = "assets/kenney_emotes-pack/PNG/Pixel/Style 1"
order = ["dots1","dots2","dots3","idea","question","cross","alert","sleeps",
         "faceHappy","faceSad","faceAngry","laugh","heart","heartBroken","swirl",
         "star","music","drop","cash","exclamation","cloud"]
cols, size = 7, 32
sheet = Image.new("RGBA", (cols * size, ((len(order) + cols - 1) // cols) * size))
for i, name in enumerate(order):
    im = Image.open(f"{src}/emote_{name}.png").convert("RGBA").resize((size, size), Image.NEAREST)
    sheet.paste(im, ((i % cols) * size, (i // cols) * size))
sheet.save("apps/web/public/assets/emotes/kenney-emotes-32.png")
```
