# Asset credits

Everything in this directory is CC0 (public domain) or derived from CC0 work.
Quintal itself is AGPL-3.0, but these assets carry no such obligation — you can
lift them for anything.

## Tileset and character sprites

**`tilesets/kenney-rpg-urban-32.png`**

- Source: [RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack) v1.0 by
  [Kenney](https://kenney.nl) (created 2019-01-05)
- Downloaded from:
  <https://kenney.nl/media/pages/assets/rpg-urban-pack/0a097d1dc7-1677578575/kenney_rpg-urban-pack.zip>
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) —
  free for personal, educational and commercial use. Crediting Kenney is
  optional; we do it because it's the decent thing to do.

**How this file was derived.** We took `Tilemap/tilemap_packed.png` from the zip
(432×288, 27×18 grid of 16×16 tiles, no margin or spacing) and upscaled it ×2
with **nearest-neighbour** resampling to 864×576, giving a 27×18 grid of 32×32
tiles. Nothing else was changed: no recolouring, no re-arranging, so tile
indices match Kenney's original sheet exactly.

The upscale exists because Quintal's world grid is 32px (`TILE_SIZE` in
`@quintal/shared`). Doing it in the source image rather than at render time
keeps the pixel art crisp and avoids half-pixel seams between tiles.

To reproduce: download the zip, then run the equivalent of

```python
from PIL import Image
src = Image.open("Tilemap/tilemap_packed.png").convert("RGBA")
w, h = src.size
src.resize((w * 2, h * 2), Image.NEAREST).save("kenney-rpg-urban-32.png")
```

**Character sprites** come from the same sheet — columns 23–26 of each row. Each
character occupies a 4×3 block: the four columns are facing left, down, up and
right; the three rows are walk-cycle frames. Quintal's default avatar is the
first block (tile indices 23–26, 50–53, 77–80).

## Map

`packages/shared/maps/hq.json` is Quintal's own work (AGPL-3.0, like the rest of
the repo), authored against the tileset above. It's a standard
[Tiled](https://www.mapeditor.org/) map — open it in Tiled and edit away.
