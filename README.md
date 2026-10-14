# aseprite-mcp

A fast, token-efficient [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, Claude Desktop, Cursor, …) **make pixel art, animate it, and export game-ready sprite sheets** with your local [Aseprite](https://www.aseprite.org/).

It also includes a CLI (`aseprite-mcp build recipe.json`), so the same animation recipes can run in your game's asset pipeline without an AI involved.

## Highlights

- **Built for how a model draws.** `draw` takes ASCII rows plus a color legend, shape tuples and dithered gradients. `read_pixels` returns the same grid format. `preview` returns a zoomed image with a pixel grid that the model can actually look at.
- **Fast.** One persistent Aseprite worker process handles every call, so typical calls take **0.5–2 ms** (a cold `aseprite -b` start is ~70 ms per call). `batch` runs many steps with one open and one save.
- **Cheap on context.** 15 tools totalling ~3.6k tokens of schema. Inputs and outputs are terse.
- **Art helpers.** Selective auto-outline, light-direction shading with hue-shifted shadows and highlights, palette ramps, palette extraction, quantize-to-palette with Bayer or Floyd–Steinberg dithering, mirroring, region copy, seamless tile shifting.
- **Importing existing art.** Upscaled pixel art is detected and reduced to its native resolution. Hi-res art can be pixelated to a target size by majority color per block. `separate` splits the background from the subject (and fills the hole behind it) so only the subject animates.
- **Animation framework.** 22 presets (`breathe`, `hop`, `hit`, `death`, `spin`, `sway`, `wave`, `cycle`, …), composable per-layer tracks with keyframes, waves and easing, secondary motion via per-layer lag, and RotSprite-smoothed rotation.
- **Game export.** Sprite sheet + Aseprite JSON (frame tags), plus a **Godot 4 `SpriteFrames` `.tres`** and a **Bevy-friendly atlas JSON**.
- **Safe with your assets.** It refuses to overwrite existing non-`.aseprite` images. You import them, edit the import, then export.

## Tools

| Tool | What it does |
|---|---|
| `create_sprite` | New sprite, or import an image (`from`) with auto native-resolution detection or pixelation to `width`/`height` |
| `sprite_info` | Size, mode, layers, frame durations, tags (palette on request) |
| `draw` | `shapes` (`line`/`rect`/`ellipse` with fill, dithered `gradient`), `rows` + `legend`, `pixels` |
| `edit` | `fill`, `replace`, `mirror`, `outline`, `shade`, `copy`, `shift`, `quantize`, `separate`, `split` |
| `palette` | Extract dominant colors (from a sprite or any image), generate hue-shifted ramps, set the palette |
| `read_pixels` | Pixels → character grid + legend |
| `preview` | Rendered PNG the model can see; frames, contact sheet, or one row per animation tag |
| `layer` | add / update / delete / clear / merge_down |
| `frames` | add (copy) / duration / delete / tag |
| `resize` | Nearest-neighbor scale or canvas resize with anchor |
| `export` | PNG/GIF/sequence, or sprite sheet + JSON (+ Godot / Bevy files) |
| `animate` | Static art → tagged animations → sprite sheet, from inline args or a recipe file |
| `ingest` | AI/video/hand-made frames → background removed, palette-locked, grid-snapped, aligned, tagged animation |
| `batch` | Many steps in one call |
| `run_lua` | Escape hatch: Aseprite Lua with `sprite` and `params` |

Conventions: coordinates are 0-based from the top-left. Frames are 1-based (as in Aseprite). Colors are `#rgb`, `#rrggbb`, `#rrggbbaa` or `transparent`. Drawing replaces pixels.

## Animation recipes

A recipe describes how static art becomes a set of animations and a sprite sheet. Keep it next to your art and rebuild whenever the art changes:

```json
{
  "source": "art/slime.aseprite",
  "output": "build/slime_anim.aseprite",
  "padding": [0, 6, 0, 0],
  "animations": [
    { "name": "idle",  "preset": { "name": "breathe", "lag": { "eyes": 0.1 } } },
    { "name": "jump",  "preset": "hop" },
    { "name": "hit",   "preset": { "name": "hit", "layers": "body" } },
    { "name": "die",   "preset": "death" },
    { "name": "blink", "frames": 6, "durationMs": 120,
      "tracks": [{ "layer": "eyes", "visible": { "seq": [1, 1, 1, 1, 1, 0] } }] }
  ],
  "export": { "sheet": "game/sprites/slime.png", "engines": ["godot", "bevy"] }
}
```

```bash
npx aseprite-mcp build art/slime.anim.json          # once
npx aseprite-mcp build art/slime.anim.json --watch  # rebuild on save
```

From the MCP side, `animate` with `saveRecipe` writes this file for you, with paths relative to the recipe.

**Presets:** `bob`, `breathe`, `float`, `hop`, `walk`, `hit`, `flash`, `blink`, `shake`, `sway`, `wobble`, `pulse`, `spin`, `swing`, `spawn`, `death`, `fade_out`, `fade_in`, `wave`, `cycle`. Each takes `amount`, `layers` (which layers move) and `lag` (`{layer: delay}` for secondary motion). Combine several by passing a list.

**Tracks** (per layer, composable): `x`, `y`, `sx`, `sy`, `sxPx`, `syPx` (scale by pixels), `rot` (degrees, RotSprite-smoothed), `shear`, `waveAmp`, `alpha`, `flash` + `flashColor`, `dissolve` (ordered dither), `visible`, `cycle` (palette cycling). Each value is a curve:

- a number,
- `{ "seq": [...] }` with one value per frame,
- `{ "keys": [[t, v, ease?], ...] }` with `t` from 0 to 1 and eases `in`, `out`, `inout`, `step` or `back`,
- `{ "wave": "sine" | "triangle" | "square" | "saw", "amp", "base", "phase", "cycles" }`.

Tip: draw parts (body, head, eyes, cape) on separate layers. Then `lag` and per-layer tracks give much livelier motion than moving the whole sprite.

### Rigging existing art (idle and walk from one static image)

Existing single-layer art can be cut into parts and walked:

1. `create_sprite` with `from` imports the art at native resolution.
2. `edit separate` takes off the background.
3. `edit split` cuts the parts onto layers named `head`, `torso`, `arm_l`, `arm_r`, `leg_l` and `leg_r`. Put legs `below` the torso.
4. Animate with the rig presets:

```json
[{ "op": "edit", "action": "split", "layer": "art", "toLayer": "leg_l", "below": true, "rects": [[0, 51, 30, 63]] },
 { "op": "edit", "action": "split", "layer": "art", "toLayer": "leg_r", "below": true, "rects": [[31, 51, 63, 63]] },
 { "op": "edit", "action": "split", "layer": "art", "toLayer": "arm_l", "rects": [[14, 36, 23, 43], [14, 44, 22, 49]] },
 { "op": "edit", "action": "split", "layer": "art", "toLayer": "head", "rects": [[0, 0, 63, 31]], "backfill": 0 }]
```

- **Rig presets:** `idle_rig` (staggered breathing) and `walk_front` (alternating leg lifts, body bob and weight shift, opposite arm swing).
- **Remapping:** use `parts` for other layer names, e.g. `{"name": "walk_front", "parts": {"head": "skull"}}`.
- **Backfill:** `split` grows the remaining layer into the cut by `backfill` px (default 1), so a moving arm reveals torso, not a hole.

## AI-generated frames → clean pixel art (`ingest`)

Diffusion models, image editors and video models can produce new poses that procedural animation can't. Their output isn't pixel art yet: soft edges, noise, off-palette colors, backgrounds, drifting scale and position. `ingest` cleans it up:

1. **Background removal.** Uses existing alpha, a given color, or auto-detected border colors, flood-filled with a Lab tolerance that also follows smooth gradients.
2. **Palette.** Colors are pulled to the reference sprite's palette, a preset, or one extracted from the frames, at full resolution.
3. **Pixel grid.** The image is reduced by majority color per block, which keeps edges crisp and introduces no blended colors.
4. **Specks.** Orphan pixels are removed.
5. **Alignment.**
   - `sequence` uses one shared transform and keeps the source's own motion; use it for video.
   - `feet` puts each frame's feet on the ground line and its center of mass on the reference anchor; use it for separately generated poses.

Inputs: image files, a sprite sheet grid, or a video (`ffmpeg` required). Each call appends one tagged animation, so a character's `idle`, `walk` and `attack` all end up in one file:

```json
{ "path": "build/hero.aseprite", "frames": ["gen/walk_1.png", "gen/walk_2.png", "..."],
  "reference": "art/hero.aseprite", "align": "feet", "tag": "walk", "durationMs": 100 }
```

Measured on synthetic diffusion-style frames (8× upscale, blurred edges, color noise and tint, gradient background), `ingest` recovers the original 64×64 frames at **~99% per-pixel accuracy** in about 0.5 s per 512px frame.

## Game engines

Each sheet export writes `sheet.png` + `sheet.json` (Aseprite json-array with `frameTags`). With `engines`:

- **Godot 4**: `sheet.tres`, a `SpriteFrames` resource with one animation per tag, correct per-frame timing, and loop off for one-shot animations (`hit`, `death`, …). The `res://` path is detected from the nearest `project.godot`. Drop it on an `AnimatedSprite2D`.
- **Bevy**: `sheet.atlas.json`:

  ```json
  { "image": "slime.png", "size": [w, h], "frame_size": [fw, fh],
    "frames": [{ "rect": [x, y, w, h], "offset": [ox, oy], "duration_ms": 100 }],
    "animations": { "idle": { "frames": [0, 1, 2], "looping": true } } }
  ```

  Load it with `serde_json` and build a `TextureAtlasLayout` from `frames[].rect`.

## Install

Requires Node ≥ 20 and Aseprite (Steam or standalone).

```bash
git clone https://github.com/MJSchut/aseprite-mcp.git
cd aseprite-mcp
npm install   # also builds dist/
```

**Claude Code**

```bash
claude mcp add aseprite -s user -- node /absolute/path/to/aseprite-mcp/dist/index.js
```

**Claude Desktop / Cursor / others**

```json
{ "mcpServers": { "aseprite": { "command": "node", "args": ["/absolute/path/to/aseprite-mcp/dist/index.js"] } } }
```

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `ASEPRITE_PATH` | Aseprite executable. Otherwise found on `PATH` or in common install/Steam locations (macOS, Windows, Linux). |
| `ASEPRITE_MCP_DIR` | Base directory for relative paths (default: the server's working directory). |
| `ASEPRITE_TIMEOUT_MS` | Per-call timeout, default 60000. |
| `ASEPRITE_MCP_WORKER` | `0` to disable the persistent worker (one Aseprite process per call). |
| `ASEPRITE_MCP_ALLOW_IMAGE_WRITES` | `1` to allow saving edits over existing PNG/GIF/... files. |

## Notes

- Edits operate on files. If a file is open in the Aseprite GUI, use File → Revert to see changes.
- Tilemap layers are not supported by the drawing tools (use `run_lua`).

## Development

```bash
npm run build   # tsc → dist/
npm test        # end-to-end tests against your real Aseprite (skipped if not installed)
```

Layout:

- `src/index.ts`: tools and the CLI.
- `src/aseprite.ts`: binary discovery, the persistent worker, the runner.
- `src/animate.ts`: presets and recipes.
- `src/export.ts`: sheet export, Godot and Bevy writers.
- `src/palettes.ts`: palette presets.
- `lua/ops.lua`: every sprite operation, run inside Aseprite.

## License

MIT
