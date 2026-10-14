#!/usr/bin/env node
import { watch } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolvePath, runSteps, runWithPreview, stopWorker, type Step } from "./aseprite.js";
import { buildRecipe, loadRecipe, PRESET_HELP, saveRecipe, type Recipe } from "./animate.js";
import { exportSprite } from "./export.js";
import { PALETTES, resolvePalette } from "./palettes.js";

// ---------------------------------------------------------------------------
// CLI: `aseprite-mcp build <recipe.json> [--watch]` for game build pipelines
// ---------------------------------------------------------------------------

if (process.argv[2] === "build") {
  const file = process.argv[3];
  if (!file) {
    console.error("usage: aseprite-mcp build <recipe.json> [--watch]");
    process.exit(2);
  }
  const once = async () => {
    const t0 = Date.now();
    try {
      const { summary, files } = await buildRecipe(await loadRecipe(file));
      console.log(`built in ${Date.now() - t0}ms`, JSON.stringify(summary), "\n  " + files.join("\n  "));
    } catch (e) {
      console.error("build failed:", e instanceof Error ? e.message : e);
      if (!process.argv.includes("--watch")) process.exitCode = 1;
    }
  };
  await once();
  if (process.argv.includes("--watch")) {
    const recipe = await loadRecipe(file);
    let timer: NodeJS.Timeout | undefined;
    const trigger = () => {
      clearTimeout(timer);
      timer = setTimeout(once, 150);
    };
    for (const f of [resolvePath(file), recipe.source]) watch(f, trigger);
    console.log("watching", file, "and", recipe.source);
  } else {
    stopWorker();
  }
} else {
  await startServer();
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

async function startServer() {
  const INSTRUCTIONS = `Aseprite pixel art. Coords 0-based from top-left; frames 1-based. Colors "#rgb" "#rrggbb" "#rrggbbaa" "transparent". Drawing replaces pixels.
Good pixel art: small palette (presets ${Object.keys(PALETTES).join(", ")} or palette ramps), big shapes first with draw, then edit outline/shade, check preview, refine with read_pixels. Separate layers per part (body, head, eyes...) so animate can move them independently. Use batch for many edits. Animate static art with animate presets; export sheets for games.`;

  const server = new McpServer({ name: "aseprite-mcp", version: "2.0.0" }, { instructions: INSTRUCTIONS });

  const path = z.string();
  const color = z.string();
  const int = z.number();
  const layer = z.union([z.string(), int]).optional().describe("default top layer");
  const frame = int.optional().describe("default 1");
  const preview = z.boolean().optional().describe("return preview image");
  const palette = z.union([z.array(color), z.string()]).describe(`hex list or preset (${Object.keys(PALETTES).join("|")})`);

  const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
  const errorResult = (e: unknown): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  });
  const compact = (r: unknown) => (r === true ? "ok" : JSON.stringify(r));

  function normalizeStep(step: Step): Step {
    const s = { ...step };
    if (s.op === "create_sprite") {
      if (s.palette !== undefined) s.palette = resolvePalette(s.palette);
      if (typeof s.from === "string") s.from = resolvePath(s.from);
    }
    if (s.op === "palette" && s.colors !== undefined) s.colors = resolvePalette(s.colors);
    if (s.op === "edit" && s.action === "quantize" && s.palette !== "sprite" && s.palette !== undefined)
      s.palette = resolvePalette(s.palette);
    return s;
  }

  async function run(
    file: string | undefined,
    steps: Step[],
    pv?: Record<string, unknown> | false,
    format: (results: unknown[]) => string = (r) => r.map(compact).join("\n"),
  ): Promise<CallToolResult> {
    try {
      const p = file ? resolvePath(file) : undefined;
      const normalized = steps.map(normalizeStep);
      if (pv) {
        const { results, png } = await runWithPreview(p, normalized, pv);
        return { content: [{ type: "text", text: format(results) }, { type: "image", data: png, mimeType: "image/png" }] };
      }
      return text(format(await runSteps(p, normalized)));
    } catch (e) {
      return errorResult(e);
    }
  }

  /** Single-step tool: `path` + `preview` lifted out, the rest becomes the step. */
  const single =
    (op: string) =>
    ({ path: file, preview: pv, ...args }: { path?: string; preview?: boolean; [k: string]: unknown }) =>
      run(file, [{ op, ...args }], pv ? { frame: args.frame } : false);

  server.registerTool(
    "create_sprite",
    {
      description:
        "New sprite file. Or import an image with `from` (png/gif/...): upscaled pixel art is auto-downscaled to native size; " +
        "width/height with `from` pixelates to that size (majority color per block). Edit the import, not the original image.",
      inputSchema: {
        path,
        width: int.optional(),
        height: int.optional(),
        from: z.string().optional(),
        downscale: z.union([int, z.literal("auto")]).optional().describe("import scale factor, default auto"),
        colorMode: z.enum(["rgb", "indexed", "grayscale"]).optional(),
        background: color.optional().describe("adds a filled background layer"),
        palette: palette.optional(),
        overwrite: z.boolean().optional(),
      },
    },
    single("create_sprite"),
  );

  server.registerTool(
    "sprite_info",
    {
      description: "Size, mode, layers, frame durations, tags. palette=true adds palette colors.",
      inputSchema: { path, palette: z.boolean().optional() },
    },
    single("sprite_info"),
  );

  server.registerTool(
    "draw",
    {
      description:
        "Draw on a layer, in order: shapes, rows, pixels. " +
        "shapes: [kind,x1,y1,x2,y2,color,fill?] kind line|rect|ellipse (fill = interior color); " +
        'or ["gradient",x1,y1,x2,y2,[colors...],"v"|"h"|"r"] (Bayer-dithered). ' +
        "rows: char grid, legend maps char->color, '.'/space skipped; x,y offset rows. pixels: [[x,y,color]...].",
      inputSchema: {
        path,
        shapes: z.array(z.array(z.union([z.string(), int, z.array(z.string())]))).optional(),
        rows: z.array(z.string()).optional(),
        legend: z.record(z.string(), color).optional(),
        x: int.optional(),
        y: int.optional(),
        pixels: z.array(z.array(z.union([int, color]))).optional(),
        layer,
        frame,
        preview,
      },
    },
    single("draw"),
  );

  server.registerTool(
    "edit",
    {
      description:
        "fill{x,y,color,contiguous?} | replace{from,to} (all cels unless layer/frame) | " +
        "mirror{mode:left_to_right|right_to_left|top_to_bottom|bottom_to_top|flip_h|flip_v} | " +
        'outline{color?="auto" (darker hue-shifted neighbor), mode?:outside|inside, corners?} | ' +
        "shade{light?:top_left|top|...|bottom_right, depth?, highlightDepth?, shadow?/highlight?: color|\"auto\"|false, ignore?: colors (e.g. outline), strength?} | " +
        "copy{x,y,width,height,toX,toY,fromLayer?,fromFrame?,flip?:h|v} | shift{dx,dy,wrap?} | " +
        "separate{colors?(default: border colors), seeds?:[[x,y]], toLayer?=\"background\"|false, islands?=6, fillHole?=true} (split background from subject) | " +
        'quantize{palette?: hex list|preset|"sprite", dither?:none|bayer|fs, strength? 0-1, setPalette?} (pull colors to a palette)',
      inputSchema: z.looseObject({
        path,
        action: z.enum(["fill", "replace", "mirror", "outline", "shade", "copy", "shift", "quantize", "separate"]),
        layer,
        frame,
        preview,
      }),
    },
    // action-specific args pass through untouched
    single("edit"),
  );

  server.registerTool(
    "palette",
    {
      description:
        "Read/extract/generate/set palettes. extract{max}: dominant colors of the sprite or any image path. " +
        "ramps:[{base,steps?=5,hueShift?=20,contrast?=1}]: hue-shifted shading ramps. colors: hex list/preset. " +
        "set=true writes colors+extracted+ramps to the sprite palette. No args: current palette.",
      inputSchema: {
        path: path.optional(),
        extract: z.object({ max: int.optional(), frame: int.optional() }).optional(),
        ramps: z.array(z.object({ base: color, steps: int.optional(), hueShift: int.optional(), contrast: int.optional() })).optional(),
        colors: palette.optional(),
        set: z.boolean().optional(),
      },
    },
    single("palette"),
  );

  server.registerTool(
    "read_pixels",
    {
      description: "Pixels as char grid + legend (draw rows format, '.'=transparent). Flattened unless layer. Optional region.",
      inputSchema: { path, layer, frame, x: int.optional(), y: int.optional(), width: int.optional(), height: int.optional() },
    },
    ({ path: file, ...args }) =>
      run(file, [{ op: "read_pixels", ...args }], false, ([r]) => {
        const g = r as { x: number; y: number; w: number; h: number; rows: string[]; legend: Record<string, string> };
        return `${g.w}x${g.h}@${g.x},${g.y} ${JSON.stringify(g.legend)}\n${g.rows.join("\n")}`;
      }),
  );

  server.registerTool(
    "preview",
    {
      description:
        "See the sprite: zoomed, checkerboard transparency, pixel grid. frames=\"all\" contact sheet; tags=true one row per animation; tag=name.",
      inputSchema: {
        path,
        frame,
        frames: z.literal("all").optional(),
        tags: z.boolean().optional(),
        tag: z.string().optional(),
        layer: z.union([z.string(), int]).optional(),
        scale: int.optional().describe("default fits maxSize"),
        maxSize: int.optional().describe("px, default 320"),
        grid: z.boolean().optional(),
      },
    },
    ({ path: file, ...args }) => run(file, [], args, () => "preview"),
  );

  server.registerTool(
    "layer",
    {
      description:
        "add{name,group?,parent?,below?,opacity?} | update{layer,rename?,visible?,opacity?} | delete{layer} | clear{layer,frame?} | merge_down{layer}",
      inputSchema: z.looseObject({
        path,
        action: z.enum(["add", "update", "delete", "clear", "merge_down"]),
        name: z.string().optional(),
        layer,
      }),
    },
    single("layer"),
  );

  server.registerTool(
    "frames",
    {
      description:
        "add{count?,after?,copyFrom?,durationMs?} | duration{durationMs,frames?} | delete{frames} | tag{name,from,to,direction?}",
      inputSchema: z.looseObject({ path, action: z.enum(["add", "duration", "delete", "tag"]) }),
    },
    single("frames"),
  );

  server.registerTool(
    "resize",
    {
      description: "scale{factor|width,height} nearest-neighbor | canvas{width,height,anchor?:center|top_left|top|...}",
      inputSchema: z.looseObject({ path, mode: z.enum(["scale", "canvas"]) }),
    },
    single("resize"),
  );

  const sheetSchema = z
    .object({
      type: z.enum(["packed", "rows", "columns", "horizontal", "vertical"]).optional(),
      columns: int.optional(),
      data: z.string().optional().describe("JSON path, default <sheet>.json"),
      trim: z.boolean().optional(),
      padding: int.optional(),
      extrude: z.boolean().optional(),
      splitTags: z.boolean().optional(),
      engines: z.array(z.enum(["godot", "bevy"])).optional().describe("also write <sheet>.tres / <sheet>.atlas.json"),
      godotResPath: z.string().optional(),
    })
    .optional();

  server.registerTool(
    "export",
    {
      description: "Export png/gif/sequence, or a spritesheet + Aseprite JSON (tags) when sheet is set. Frames 1-based.",
      inputSchema: {
        path,
        output: z.string(),
        scale: int.optional(),
        frames: z.array(int).optional().describe("[from, to]"),
        tag: z.string().optional(),
        layer: z.string().optional(),
        splitLayers: z.boolean().optional(),
        sheet: sheetSchema,
      },
    },
    async ({ path: file, output, sheet, ...rest }) => {
      try {
        const files = await exportSprite(resolvePath(file), {
          ...rest,
          frames: rest.frames && [rest.frames[0], rest.frames[1] ?? rest.frames[0]],
          output: resolvePath(output),
          sheet: sheet && { ...sheet, data: sheet.data && resolvePath(sheet.data) },
        });
        return text(files.join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "animate",
    {
      description:
        "Static art -> animations. Reads `source` (never modified), writes `output` .aseprite with one tag per animation, " +
        "optionally exports a sheet. Each animation: {name, preset?, frames?, durationMs?, loop?, pivot?:bottom|center|top|[x,y], sourceFrames?|sourceTag?, tracks?}. " +
        "preset: name | {name, amount?, layers?, lag?:{layer:0.1}, color?, colors?} | list (combined). " +
        `Presets: ${PRESET_HELP}. ` +
        "tracks: [{layer?:\"*\"|name, x,y,sxPx,syPx,sx,sy,rot,shear,waveAmp,alpha,flash,dissolve,visible: curve}] " +
        "curve = number | {seq:[per frame]} | {keys:[[t,v,ease?]]} (ease in|out|inout|step|back) | {wave:sine|triangle|square|saw,amp,base?,phase?,cycles?}. " +
        "Use padding when motion leaves the canvas. saveRecipe writes a re-runnable recipe (CLI: aseprite-mcp build recipe.json).",
      inputSchema: {
        recipe: z.string().optional().describe("load recipe JSON file instead of inline fields"),
        source: z.string().optional(),
        output: z.string().optional(),
        padding: z.union([int, z.array(int)]).optional().describe("px or [left,top,right,bottom]"),
        animations: z.array(z.looseObject({ name: z.string() })).optional(),
        export: z.looseObject({ sheet: z.string() }).optional().describe("{sheet, ...export sheet options, scale?}"),
        saveRecipe: z.string().optional(),
        preview: z.boolean().optional().describe("default true"),
      },
    },
    async ({ recipe: recipeFile, saveRecipe: savePath, preview: pv, ...inline }) => {
      try {
        let recipe: Recipe;
        if (recipeFile) recipe = await loadRecipe(recipeFile);
        else {
          if (!inline.source || !inline.output || !inline.animations) throw new Error("need recipe, or source + output + animations");
          recipe = inline as unknown as Recipe;
        }
        const saved = savePath ? await saveRecipe(recipe, savePath) : undefined;
        const { summary, files, png } = await buildRecipe(recipe, { preview: pv !== false });
        const lines = [compact(summary), ...files, ...(saved ? [`recipe ${saved}`] : [])].join("\n");
        const content: CallToolResult["content"] = [{ type: "text", text: lines }];
        if (png) content.push({ type: "image", data: png, mimeType: "image/png" });
        return { content };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const BATCH_OPS = [
    "create_sprite", "sprite_info", "draw", "edit", "palette", "read_pixels", "layer", "frames", "resize", "animate", "run_lua",
  ] as const;

  server.registerTool(
    "batch",
    {
      description:
        "Many steps on one sprite in one call (one open, one save, all-or-nothing). Step = {op, ...that tool's args minus path/preview}. " +
        'e.g. [{"op":"create_sprite","width":16,"height":16,"palette":"pico8"},{"op":"draw","rows":["kk"],"legend":{"k":"#000"}},{"op":"edit","action":"outline"}]',
      inputSchema: {
        path,
        steps: z.array(z.looseObject({ op: z.enum(BATCH_OPS) })),
        preview: z.union([z.boolean(), z.looseObject({})]).optional().describe("true or preview options"),
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
      description: "Run Aseprite Lua (API 1.3). Globals: sprite (from path), params. Returns the script's return value. Saves unless save=false.",
      inputSchema: {
        path: path.optional(),
        code: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        save: z.boolean().optional(),
      },
    },
    ({ path: file, ...args }) => run(file, [{ op: "run_lua", ...args }]),
  );

  // Token diet: drop per-tool boilerplate the client never needs.
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })
    ._requestHandlers;
  const listTools = handlers?.get("tools/list");
  if (listTools) {
    handlers.set("tools/list", async (...a) => {
      const res = (await listTools(...a)) as { tools: Record<string, unknown>[] };
      for (const t of res.tools) {
        delete t.execution;
        const s = t.inputSchema as Record<string, unknown>;
        delete s.$schema;
      }
      return res;
    });
  }

  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    stopWorker();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
