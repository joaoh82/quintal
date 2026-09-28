<!-- Copied verbatim from the Shared World pack by tools/sync-world-assets.mjs.
     Edit it in the pack and re-run the script; edits here are overwritten. -->

# Shared World — asset design guidelines

Version 1.0 · 28 September 2026

Use this document and the approved native PNGs together when creating additional assets. This is an art contract for an independent asset library, not a specification for a game implementation.

## 1. Visual identity

A warm, practical workplace with inviting social and outdoor spaces. Use pale wood, blue slate furniture, ivory walls, muted foliage and restrained teal accents. Keep objects recognizable at native resolution. Props support characters rather than competing for attention.

People and agents share the same human visual language. Roles, names and live status belong in separate overlays in the consuming project; never bake them into the body sprite. The twelve supplied characters are optional personalities, not locked job roles.

### Projection and lighting

- Orthogonal top-down RPG projection, with visible tops and front faces on freestanding furniture.
- Horizontal furniture edges remain horizontal. No isometric diamond grid or vanishing point.
- Tall objects rise visually upward from a ground footprint.
- Light comes from the upper left; highlights sit on top/left faces and shadows on lower/right faces.
- Cardinal wall-cap tiles are flat plan-view shapes. Back-wall faces provide vertical height separately.
- The larger decorative wall-face corner sprites are optional accents. Use the cardinal cap family for exact map connections.

## 2. Scale and PNG contracts

| Asset | Cell / sheet | Anchor |
| --- | --- | --- |
| Terrain | 32×32; shared sheet 128×128 | top-left |
| Cardinal wall caps | 32×32; sheet 128×128 | center (16,16) |
| Original office props | 64×64; atlas 256×256 | ground (32,62) |
| New props | 128×96; atlas 512×384 | ground (64,94) |
| Modular meeting table | 32×96 sections | ground (16,94) |
| Avatars | 32×48; sheet 256×192 | foot (16,42) |

The larger new prop cells provide room for trees, long tables and padding. They do **not** change the world scale. A standard desk remains approximately 62 pixels wide, an office chair 25 pixels wide, and a standing character approximately 34 pixels tall. Do not stretch a prop to fill its cell.

Native exports use hard alpha for isolated sprites and opaque pixels for floor surfaces. Use sRGB PNG. Keep transparent padding. Sheet margin and inter-cell spacing are both zero. Preserve nearest-neighbor sampling and inspect at 1× and an integer 2× or 4× enlargement.

Generation tools may ignore requested resolution or spacing. Measure the returned image; verify all rows and columns before slicing. The native exports, not the large generated source sheets, define the delivered dimensions.

### Typical visible dimensions

| Prop | Approximate maximum bounds |
| --- | --- |
| Office desk | 62×44 |
| Office / meeting chair | 25×32 |
| Dining chair | 23×30 |
| Long dining table | 94×44 |
| Reception counter | 96×48 |
| Bookcase | 40×62 |
| Door | 32×52; double glass doors 64×52 |
| Tall indoor plant | 28×48 |
| Garden tree | 80×94 |
| Bench | 62×36; side-facing variants up to 32×42 |
| Fountain | 80×70 |

Use `asset-manifest.json` for exact exported visible bounds and source crop rectangles. Asset names are stable identifiers; filenames alone do not imply collision geometry.

## 3. Palette

These are palette anchors, not a claim that the generated files contain only these exact colors. Preserve the ramps and overall balance when adding work; hand-finishing may reduce nearby generated shades.

| Material | Shadow | Midtone | Highlight |
| --- | --- | --- | --- |
| Outline / metal | `#29313B` | `#414E60` | `#64758B` |
| Blue upholstery | `#414E60` | `#64758B` | `#9AAABC` |
| Wall / ceramic | `#CCC5B7` | `#EEE7D7` | `#FAF5E9` |
| Pale wood | `#BC8D61` | `#DFB886` | `#F0D1A0` |
| Foliage | `#365444` | `#52735C` | `#83A06C` |
| Teal fabric | `#46786E` | `#6DAFA0` | `#96C6B2` |
| Brown hair | `#463529` | `#634835` | `#947052` |
| Warm skin example | `#B77D58` | `#DBA478` | `#EFC399` |

Use small independent ramps for different skin tones. Preserve natural variety in the cast. Outfit accents may include mustard, rust, rose, lavender or indigo, but keep saturation below the point where one person overwhelms a room.

### Environment accents

- **Office:** blue carpet, ivory walls, pale wood, teal clothing and green plants.
- **Garden:** muted grass, pale gravel, cream stone and foliage; flowers are small yellow/white accents.
- **Cafeteria:** ivory ceramic, terracotta service area, warm wood; food provides limited brighter detail.
- **Hallway:** light terrazzo and charcoal entrance carpet; slate door frames and blue waiting benches.
- **Meeting room:** quiet teal carpet, pale wood and muted blue acoustic panels.

## 4. Pixel construction

Prefer one-pixel contours at native size. Use connected clusters and deliberate stair steps. Two or three shades per material should normally be enough. Avoid random speckles, photographic texture, soft glow, blur, airbrushing and excessively glossy surfaces.

Carpet should remain quiet, with very sparse weave marks. A busy floor makes small avatars hard to read. Wood grain runs horizontally and should not become a row of dark stripes at every pixel. Keep tiny props identifiable through silhouette and one or two meaningful details.

Always inspect transparency against light and dark backgrounds. A preview that appears transparent may still contain low-alpha residue, colored halos, or a painted checkerboard. The accepted native sprites use only alpha 0 and 255.

## 5. Terrain and modular architecture

The shared surface sheet contains sixteen named cells. Each environment includes a smaller selected sheet and a `.tsj` definition. These share one visual scale and can be mixed by material zones.

Opposite edges of each floor tile are registered for self-repetition. Inspect a 5×5 patch as well as checking edge pixels; a matching seam does not automatically eliminate a distracting repeated motif. Material-to-material boundaries are intentionally hard cuts, as in the examples.

### Cardinal wall caps

`shared/walls/walls.png` contains sixteen connection masks in row-major order. Add the values for connected neighbors: **N=1, E=2, S=4, W=8**. Frame 0 is isolated; 5 is north/south; 10 is east/west; 15 is a cross. The remaining frames provide ends, bends and T-junctions.

Compatible endpoint pixels are matched. Preserve that contract when replacing artwork. Do not reshape only one direction's endpoint. If adding a different wall material, produce a complete sixteen-frame family with the same ordering and endpoint profile.

`wall-face.png` is a repeating back-wall face that can sit below the cap row. Doors and windows are independent props. Open and closed wood/glass door states are separate frames in the hallway set.

The larger architecture sprites are decorative wall faces/corners; their cell padding and perspectives are not the cardinal tiling contract. Keep those uses distinct.

### Extendable meeting table

`environments/meeting/modular-table/` contains left, middle and right 32-pixel-wide sections derived from the approved oval table. Place the left and right ends around one or more repeated middle sections. Keep y/anchor alignment unchanged. Do not rescale sections independently.

## 6. Avatar identity and animation

All twelve avatars share the same frame contract. Each identity has its own silhouette, hair, skin and outfit. Personality descriptions are in `AVATARS.md` and can be changed without changing the art.

### Layout

Rows, top to bottom: **south, west, east, north**.

| Columns | State | Motion |
| --- | --- | --- |
| 0–1 | idle | standing blink or subtle body change |
| 2–3 | walk | alternating stepping poses |
| 4–5 | sit | bent-knee seated rest, small breathing/hand change |
| 6–7 | work | seated forearms forward, alternating typing/hand poses |

Frames are named `state-direction-0` and `state-direction-1`. Each sheet contains 32 frames and 16 two-frame loops. Keep the body scale consistent between standing and sitting; do not enlarge a seated pose just to fill the standing silhouette's height.

### Suggested timing

| State | Frame A | Frame B |
| --- | --- | --- |
| Idle | 1400 ms | 120 ms |
| Walk | 180 ms | 180 ms |
| Sit | 800 ms | 800 ms |
| Work | 250 ms | 250 ms |

The JSON metadata records these timings. Walking is intentionally a compact two-pose loop; longer cycles may be added later without renaming existing poses. Sitting is a sustained pose loop, not a stand-to-sit transition. Working is a typing gesture rather than a complete task simulation.

North-facing idle, sitting and working changes are subtle because the hands and face are partly hidden. Review the animated GIFs, not only contact sheets. All two-frame pairs differ at native resolution, but a numerical difference is not a substitute for judging motion.

### Seating integration

Export bodies separately from chairs and desks. Align the seated body to a seat-specific position and use the relevant chair/desk layers to hide legs or chair backs where needed. Do not bake a person's identity into furniture. Preserve head size between idle, walk, sit and work.

## 7. Depth and placement metadata

Use the ground anchor's y coordinate to sort freestanding objects, and the foot anchor's y for standing/walking avatars. Top-left sprite position is not a reliable depth value. Wall-mounted decorations can use a fixed background layer. Small desk props belong above the desktop.

Collision footprints, walkable areas, seat reservations and live status are responsibilities of the consuming project. They are not baked into these images. A 128×96 cell often contains a much smaller object and must not automatically become a 128×96 obstacle.

Example `layout.json` files provide native pixel positions, source filenames, anchors and draw order. Their scenes are static compositions of actual exports. The supplied image layers preserve floor, architecture, and depth-ordered objects/avatars independently.

## 8. Reusable generation prompts

Attach the approved native sheet and, if useful, its generated source. Label the image as a style reference unless you are explicitly editing it. Generate one object or one character identity at a time whenever possible.

### Furniture / environment prop

> Create an original [OBJECT] matching the attached Shared World assets. Orthogonal top-down RPG projection with visible top and front faces; horizontal edges stay horizontal. Match pale wood, ivory, blue slate and muted green/teal material ramps. Upper-left lighting. Native visible bounds [W×H], export cell [W×H], ground anchor [X,Y]. Clean one-pixel contours and deliberate square pixel clusters; two or three shades per material. Genuine transparent PNG, no backdrop, glow, labels or grid lines. Keep the full object inside its cell. Do not include people. Do not add chairs to a requested standalone table. Match the reference desk and avatar scale. Enlarged previews must use integer nearest-neighbor scaling.

### Complete avatar sheet

> Create ONE character: [APPEARANCE]. Match the attached Shared World avatar proportions and pixel treatment. Exact eight-column, four-row sheet. Each cell represents 32×48 native pixels; soles at (16,42); standing body approximately 34 pixels tall. Rows: south, west, east, north. In every row the eight columns are idle A, idle B, walk A, walk B, sit A, sit B, work A, work B. Keep identity, head size, outfit and lighting consistent across all 32 cells. Idle B blinks or subtly breathes. Walking alternates limbs. Sitting bends knees and rests hands on the lap. Working remains seated with arms extended and alternate typing hands. Preserve head scale in shorter seated poses. No chair, desk, role label, floor or background. Genuine transparent PNG; crisp pixel clusters; no gradients, blur or antialiasing.

### Seamless surface

> Create one seamless 32×32 logical-pixel [MATERIAL] tile matching the Shared World palette. Flat top-down surface; low contrast and sparse intentional detail. Exact opposite-edge continuity. No border, edge shadow, perspective, objects, labels or random noise. Opaque PNG. Deliver any repetition preview separately from the tile export.

### Wall family

> Create a flat plan-view cardinal wall-cap tileset: sixteen 32×32 cells in four columns, indexed by N=1, E=2, S=4, W=8. Constant-width ivory walls with a thin slate outline. No enlarged central pillars. Straight tiles are plain rectangles, corners are 90-degree bends. Connecting arms end exactly at the cell boundary with identical endpoint profiles. No diagonal/isometric edges or visible vertical wall faces. Transparent outside the wall shapes. No labels or gutters.

### Targeted correction

> Change only [DEFECT]. Preserve identity, silhouette, palette, pixel scale, frame order and anchor. Keep all other artwork unchanged. Preserve real alpha transparency. Do not add new objects or redesign the sheet.

The exact prompts and source-file associations used for this release are recorded in `GENERATION_PROMPTS.md`.

## 9. Acceptance checklist

- [ ] Inspect at native resolution and 4× nearest-neighbor zoom.
- [ ] Match object proportions against the desk and avatar references.
- [ ] Verify dimensions, ordering, anchors and named-frame metadata.
- [ ] Verify alpha against light and dark backgrounds.
- [ ] Review lighting, outlines, palette and projected angle.
- [ ] Repeat terrain 5×5; check both seams and repeating motifs.
- [ ] Check every compatible wall connection.
- [ ] Preview every animation direction, including subtle north-facing movement.
- [ ] Keep head/body scale stable and feet registered.
- [ ] Assemble a small scene from the final exported files.
- [ ] Preserve stable names; version experiments instead of overwriting approvals.
- [ ] Update inventory, prompts and guidelines when changing a contract.

## 10. Provenance

Art was generated using the built-in image-generation tool. Preparation measured source grids, sliced separate assets, registered anchors, hardened alpha, performed nearest-neighbor sizing, and aligned repeatable edges. Example scenes and contact sheets were assembled from those exported assets, not independently illustrated approximations.

The external office pack was a style/subject reference only: https://masalimov-ilnur.itch.io/pixel-office. None of its original sprite files were extracted or included.
