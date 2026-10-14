#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { exportSprite, resolvePath, runSteps, runWithPreview, type Step } from "./aseprite.js";
import { PALETTES, resolvePalette } from "./palettes.js";

const INSTRUCTIONS = `Edit Aseprite sprites. Pixel coords are 0-based from top-left; frames are 1-based.
Colors: "#rgb", "#rrggbb", "#rrggbbaa" or "transparent". Drawing replaces pixels (no blending).
Workflow for good pixel art: pick a small palette (presets: ${Object.keys(PALETTES).join(", ")}), lay down shapes with draw_grid, check with preview, refine. Use batch for several edits at once (one process, one save). Use separate layers for outline/shading so they are easy to fix. Prefer .aseprite files; export to png/gif at the end.`;

const server = new McpServer({ name: "aseprite-mcp", version: "1.0.0" }, { instructions: INSTRUCTIONS });

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

const path = z.string().describe("Sprite file (.aseprite recommended)");
const color = z.string();
const layer = z.union([z.string(), z.number()]).optional().describe("Layer name or index; default top layer");
const frame = z.number().min(1).optional().describe("Default 1");
const preview = z.boolean().optional().describe("Return a preview image after the edit");
const palette = z
  .union([z.array(color), z.string()])
  .optional()
  .describe(`Hex colors or preset: ${Object.keys(PALETTES).join("|")}`);

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function compact(r: unknown): string {
  if (r === true) return "ok";
  return JSON.stringify(r);
}

function errorResult(e: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
}

function normalizeStep(step: Step): Step {
  const s = { ...step };
  if (s.op === "create_sprite" || s.op === "set_palette") s.palette = resolvePalette(s.palette);
  return s;
}

/** Run one or more steps on a sprite, optionally returning a preview image. */
async function run(
  file: string | undefined,
  steps: Step[],
  previewOpts?: Record<string, unknown> | false,
  format: (results: unknown[]) => string = (r) => r.map(compact).join("\n"),
): Promise<CallToolResult> {
  try {
    const p = file ? resolvePath(file) : undefined;
    const normalized = steps.map(normalizeStep);
    if (previewOpts) {
      const { results, png } = await runWithPreview(p, normalized, previewOpts);
      return {
        content: [
          { type: "text", text: format(results) },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      };
    }
    return { content: [{ type: "text", text: format(await runSteps(p, normalized)) }] };
  } catch (e) {
    return errorResult(e);
  }
}

/** Single-step tool: `path` + `preview` are lifted out, the rest becomes the step. */
function single(op: string) {
  return ({ path: file, preview: pv, ...args }: { path: string; preview?: boolean; [k: string]: unknown }) =>
    run(file, [{ op, ...args }], pv ? { frame: args.frame, layer: undefined } : false);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  "create_sprite",
  {
    description: "Create a new sprite file.",
    inputSchema: {
      path,
      width: z.number().min(1).max(4096),
      height: z.number().min(1).max(4096),
      colorMode: z.enum(["rgb", "indexed", "grayscale"]).optional(),
      background: color.optional().describe("Fill color; default transparent"),
      palette,
      overwrite: z.boolean().optional(),
    },
  },
  single("create_sprite"),
);

server.registerTool(
  "sprite_info",
  {
    description: "Size, color mode, layers, frames, tags. Set palette=true to include palette colors.",
    inputSchema: { path, palette: z.boolean().optional() },
  },
  single("sprite_info"),
);

server.registerTool(
  "draw_grid",
  {
    description:
      "Draw pixels from a character grid. Each row string is one pixel row; each char maps to a color via legend. " +
      "'.' and space are skipped (left untouched) — map a char to \"transparent\" to erase. Most token-efficient way to draw.",
    inputSchema: {
      path,
      rows: z.array(z.string()),
      legend: z.record(z.string(), color).describe('e.g. {"k":"#000","r":"#e43b44"}'),
      x: z.number().optional().describe("Top-left offset, default 0"),
      y: z.number().optional(),
      layer,
      frame,
      preview,
    },
  },
  single("draw_grid"),
);

server.registerTool(
  "draw_pixels",
  {
    description: "Set individual pixels. pixels: [[x, y, color], ...]",
    inputSchema: {
      path,
      pixels: z.array(z.tuple([z.number(), z.number(), color])),
      layer,
      frame,
      preview,
    },
  },
  single("draw_pixels"),
);

server.registerTool(
  "draw_shape",
  {
    description: "Draw a 1px pixel-perfect line, rectangle or ellipse (ellipse fits the box x1,y1-x2,y2).",
    inputSchema: {
      path,
      shape: z.enum(["line", "rectangle", "ellipse"]),
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      color: color.describe("Outline color"),
      filled: z.boolean().optional(),
      fillColor: color.optional().describe("Interior color; default = color"),
      layer,
      frame,
      preview,
    },
  },
  single("draw_shape"),
);

server.registerTool(
  "fill",
  {
    description: "Paint-bucket fill from (x, y). contiguous=false replaces that color everywhere on the layer.",
    inputSchema: {
      path,
      x: z.number(),
      y: z.number(),
      color,
      contiguous: z.boolean().optional(),
      layer,
      frame,
      preview,
    },
  },
  single("fill"),
);

server.registerTool(
  "replace_color",
  {
    description: "Replace one exact color with another (all layers/frames unless given).",
    inputSchema: { path, from: color, to: color, layer, frame, preview },
  },
  single("replace_color"),
);

server.registerTool(
  "mirror",
  {
    description: "Mirror one half of a layer onto the other (for symmetric sprites) or flip the whole layer.",
    inputSchema: {
      path,
      mode: z.enum(["left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top", "flip_horizontal", "flip_vertical"]),
      layer,
      frame,
      preview,
    },
  },
  single("mirror"),
);

server.registerTool(
  "read_pixels",
  {
    description:
      "Read pixels as a character grid + legend (same format draw_grid takes; '.' = transparent). " +
      "Reads the flattened image unless layer is given. Optional region x,y,width,height.",
    inputSchema: {
      path,
      layer,
      frame,
      x: z.number().min(0).optional(),
      y: z.number().min(0).optional(),
      width: z.number().min(1).optional(),
      height: z.number().min(1).optional(),
    },
  },
  ({ path: file, ...args }) =>
    run(file, [{ op: "read_pixels", ...args }], false, ([r]) => {
      const g = r as { x: number; y: number; width: number; height: number; rows: string[]; legend: Record<string, string> };
      return `${g.width}x${g.height} at ${g.x},${g.y}\nlegend ${JSON.stringify(g.legend)}\n${g.rows.join("\n")}`;
    }),
);

server.registerTool(
  "preview",
  {
    description:
      "Render the sprite as an image you can see: scaled up, checkerboard behind transparency, pixel grid lines when zoomed. " +
      'frames="all" shows every frame side by side.',
    inputSchema: {
      path,
      frame,
      frames: z.literal("all").optional(),
      layer: z.union([z.string(), z.number()]).optional().describe("Only this layer; default all visible"),
      scale: z.number().min(1).max(64).optional().describe("Default: fit ~320px"),
      maxSize: z.number().min(16).max(2048).optional(),
      grid: z.boolean().optional(),
    },
  },
  ({ path: file, ...args }) => run(file, [], args, () => "preview"),
);

server.registerTool(
  "layer",
  {
    description: "Manage layers. add: new layer `name`. update: rename/visible/opacity. delete. clear: remove pixels (all frames unless frame given).",
    inputSchema: {
      path,
      action: z.enum(["add", "update", "delete", "clear"]),
      name: z.string().optional().describe("New layer name (add) or target layer (others)"),
      layer: layer.describe("Target layer (update/delete/clear)"),
      group: z.boolean().optional().describe("add: create a group"),
      parent: z.string().optional().describe("add: parent group"),
      below: z.string().optional().describe("add: insert below this layer; default on top"),
      rename: z.string().optional(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(255).optional(),
      frame,
    },
  },
  single("layer"),
);

server.registerTool(
  "frames",
  {
    description:
      "Manage animation frames. add: `count` new frames after `after` (default end), copying `copyFrom` if set. " +
      "duration: set durationMs for `frames` (default all). delete: delete `frames`. tag: name frames from..to.",
    inputSchema: {
      path,
      action: z.enum(["add", "duration", "delete", "tag"]),
      count: z.number().min(1).optional(),
      after: z.number().min(0).optional(),
      copyFrom: z.number().min(1).optional(),
      durationMs: z.number().min(1).optional(),
      frames: z.array(z.number().min(1)).optional(),
      name: z.string().optional(),
      from: z.number().min(1).optional(),
      to: z.number().min(1).optional(),
      direction: z.enum(["forward", "reverse", "pingpong", "pingpong_reverse"]).optional(),
    },
  },
  single("frames"),
);

server.registerTool(
  "set_palette",
  {
    description: "Replace the sprite palette.",
    inputSchema: { path, palette: palette.unwrap() },
  },
  single("set_palette"),
);

server.registerTool(
  "resize",
  {
    description: "scale: resample sprite (nearest neighbor) by factor or to width/height. canvas: change canvas size, content anchored.",
    inputSchema: {
      path,
      mode: z.enum(["scale", "canvas"]),
      factor: z.number().positive().optional(),
      width: z.number().min(1).optional(),
      height: z.number().min(1).optional(),
      anchor: z
        .enum(["center", "top_left", "top", "top_right", "left", "right", "bottom_left", "bottom", "bottom_right"])
        .optional(),
    },
  },
  single("resize"),
);

server.registerTool(
  "export",
  {
    description:
      "Export to .png/.gif/etc (multi-frame png → numbered files), or a spritesheet when `sheet` is set. Frames 1-based.",
    inputSchema: {
      path,
      output: z.string(),
      scale: z.number().min(1).max(64).optional(),
      frames: z.tuple([z.number().min(1), z.number().min(1)]).optional().describe("[from, to]"),
      tag: z.string().optional(),
      layer: z.string().optional(),
      splitLayers: z.boolean().optional(),
      sheet: z
        .object({
          type: z.enum(["horizontal", "vertical", "rows", "columns", "packed"]).optional(),
          columns: z.number().min(1).optional(),
          data: z.string().optional().describe("Write JSON frame data here"),
        })
        .optional(),
    },
  },
  async ({ path: file, output, sheet, ...rest }) => {
    try {
      const out = await exportSprite(resolvePath(file), {
        ...rest,
        output: resolvePath(output),
        sheet: sheet && { ...sheet, data: sheet.data && resolvePath(sheet.data) },
      });
      return { content: [{ type: "text", text: `exported ${out}` }] };
    } catch (e) {
      return errorResult(e);
    }
  },
);

const BATCH_OPS = [
  "create_sprite", "sprite_info", "draw_grid", "draw_pixels", "draw_shape", "fill", "replace_color", "mirror",
  "read_pixels", "layer", "frames", "set_palette", "resize", "run_lua",
] as const;

server.registerTool(
  "batch",
  {
    description:
      "Run many edits on one sprite in a single Aseprite process (one open, one save; all-or-nothing). " +
      "Each step is {op, ...same args as that tool, without path/preview}. E.g. " +
      '[{"op":"create_sprite","width":16,"height":16,"palette":"pico8"},{"op":"layer","action":"add","name":"outline"},' +
      '{"op":"draw_grid","layer":"outline","rows":["..kk..",".k..k."],"legend":{"k":"#000"}}]',
    inputSchema: {
      path,
      steps: z.array(z.looseObject({ op: z.enum(BATCH_OPS) })).min(1),
      preview: z
        .union([z.boolean(), z.looseObject({})])
        .optional()
        .describe('true, or preview options e.g. {"frames":"all"}'),
    },
  },
  ({ path: file, steps, preview: pv }) =>
    run(file, steps as Step[], pv === true ? {} : pv || false, (results) =>
      results.map((r, i) => `${i + 1}:${compact(r)}`).join("\n"),
    ),
);

server.registerTool(
  "run_lua",
  {
    description:
      "Escape hatch: run Aseprite Lua (API v1.3). Globals: `sprite` (opened from path, if given), `params`. " +
      "Return a JSON-able value. The sprite is saved afterwards unless save=false.",
    inputSchema: {
      path: path.optional(),
      code: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      save: z.boolean().optional(),
    },
  },
  ({ path: file, ...args }) => run(file, [{ op: "run_lua", ...args }]),
);

await server.connect(new StdioServerTransport());
