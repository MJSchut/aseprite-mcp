# aseprite-mcp

A small, fast, token-efficient [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, Claude Desktop, Cursor, …) **create pixel art and animations with [Aseprite](https://www.aseprite.org/)**.

It drives your local Aseprite headlessly (`aseprite -b --script`) through a single Lua script. Nothing leaves your machine.

## Why another one?

Designed around how a language model actually draws:

- **`draw_grid`**: draw with ASCII art plus a color legend. A 16×16 sprite costs ~16 short strings instead of 256 JSON pixel objects.
- **`read_pixels`** returns the same grid format, so the model can read, tweak and redraw exactly.
- **`preview`** returns an image the model can *see*: zoomed, with pixel grid lines and a checkerboard behind transparency. `frames: "all"` shows an animation strip. Every drawing tool takes `preview: true` to get this in the same call.
- **`batch`** runs many edits in **one Aseprite process with one open and one save**, all-or-nothing. A full create + draw + preview round trip takes ~100 ms.
- **17 tools, ~3.7k tokens of schema** in total. Compact inputs (`[x, y, color]` tuples) and terse outputs (`ok`, `{"drawn":140}`).
- Palette presets: `pico8`, `db16`, `sweetie16`, `gameboy`.

## Tools

| Tool | What it does |
|---|---|
| `create_sprite` | New sprite (size, rgb/indexed/grayscale, background, palette) |
| `sprite_info` | Size, mode, layers, frames + durations, tags (palette on request) |
| `draw_grid` | Draw from character rows + legend (`.` = skip, map a char to `transparent` to erase) |
| `draw_pixels` | `[[x, y, color], …]` |
| `draw_shape` | Pixel-perfect line / rectangle / ellipse, optional fill |
| `fill` | Flood fill, or global color replace on a layer |
| `replace_color` | Swap a color across layers/frames (recolors, palette swaps) |
| `mirror` | Mirror half onto the other half (symmetric sprites), or flip |
| `read_pixels` | Pixels → character grid + legend (flattened or one layer, optional region) |
| `preview` | Rendered PNG for the model to look at |
| `layer` | add / update (rename, visibility, opacity) / delete / clear |
| `frames` | add (optionally copying a frame) / duration / delete / tag |
| `set_palette` | Hex list or preset |
| `resize` | Nearest-neighbor scale, or canvas resize with anchor |
| `export` | PNG / GIF / sequences / spritesheets (+ JSON data), scale, tag, layer |
| `batch` | Any of the above as steps in one process |
| `run_lua` | Escape hatch: arbitrary Aseprite Lua with `sprite` and `params` globals |

Conventions: pixel coordinates are 0-based from the top-left; frames are 1-based (as in the Aseprite UI). Colors are `#rgb`, `#rrggbb`, `#rrggbbaa` or `transparent`. Drawing replaces pixels (no alpha blending), so results are predictable.

## Install

Requires Node ≥ 20 and Aseprite (Steam or standalone).

```bash
git clone https://github.com/MJSchut/aseprite-mcp.git
cd aseprite-mcp
npm install   # also builds dist/
```

### Claude Code

```bash
claude mcp add aseprite -s user -- node /absolute/path/to/aseprite-mcp/dist/index.js
```

### Claude Desktop / Cursor / others

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["/absolute/path/to/aseprite-mcp/dist/index.js"]
    }
  }
}
```

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `ASEPRITE_PATH` | Path to the Aseprite executable. Otherwise found on `PATH` or in common install/Steam locations (macOS, Windows, Linux). |
| `ASEPRITE_MCP_DIR` | Base directory for relative file paths (default: the server's working directory). |
| `ASEPRITE_TIMEOUT_MS` | Per-call timeout, default 60000. |

## Example

A single `batch` call:

```json
{
  "path": "~/art/heart.aseprite",
  "steps": [
    { "op": "create_sprite", "width": 16, "height": 16, "palette": "pico8" },
    { "op": "draw_grid", "y": 2, "legend": { "k": "#1d2b53", "r": "#ff004d", "w": "#fff1e8" },
      "rows": ["..kkkk....kkkk..", ".krrrrk..krrrrk.", "krrwwrrkkrrrrrrk", "..."] }
  ],
  "preview": true
}
```

## Notes

- Edits operate on files. If the same file is open in the Aseprite GUI, reload it there (File → Revert) to see changes.
- Tilemap layers are not supported by the drawing tools (use `run_lua`).

## Development

```bash
npm run build   # tsc → dist/
npm test        # end-to-end tests against your real Aseprite (skipped if not installed)
```

Layout: `src/index.ts` (tool definitions), `src/aseprite.ts` (binary discovery, process runner, CLI export), `lua/ops.lua` (all sprite operations, executed inside Aseprite).

## License

MIT
