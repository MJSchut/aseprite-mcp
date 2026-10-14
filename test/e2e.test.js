// End-to-end: spawns the built server over stdio and drives a real Aseprite.
// Skipped when Aseprite cannot be found.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asepriteBinary } from "../dist/aseprite.js";

let hasAseprite = true;
try { asepriteBinary(); } catch { hasAseprite = false; }
const opts = { skip: !hasAseprite && "Aseprite not installed" };

let client, dir, file, mock;
// Fake Replicate API: one model with a schema, predictions that need one poll, PNG outputs from the test dir.
const replicateCalls = [];
function startMockReplicate() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname.startsWith("/out/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(await readFile(join(dir, url.pathname.slice(5))));
    }
    if (req.headers.authorization !== "Bearer test-token") return json({ detail: "unauthorized" }, 401);
    if (req.method === "GET" && url.pathname === "/v1/models/test/pixel") {
      return json({ latest_version: { id: "v1", openapi_schema: { components: { schemas: {
        Input: { required: ["prompt"], properties: {
          prompt: { type: "string", description: "What to draw" },
          input_image: { type: "string", format: "uri" },
          steps: { type: "integer", default: 20, minimum: 1, maximum: 50 },
          style: { allOf: [{ $ref: "#/components/schemas/style" }], default: "a" },
        } },
        style: { enum: ["a", "b"] },
      } } } } });
    }
    if (req.method === "POST" && url.pathname === "/v1/models/test/pixel/predictions") {
      let body = "";
      for await (const c of req) body += c;
      const n = replicateCalls.push(JSON.parse(body));
      return json({ id: `p${n}`, status: "starting", urls: { get: `${base}/v1/predictions/p${n}` } });
    }
    const m = /^\/v1\/predictions\/p(\d+)$/.exec(url.pathname);
    if (m) {
      return json({ id: `p${m[1]}`, status: "succeeded", output: [`${base}/out/ai_${((m[1] - 1) % 2) + 1}.png`],
        metrics: { predict_time: 1.5 }, urls: { get: `${base}${url.pathname}` } });
    }
    json({ detail: "not found" }, 404);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

before(async () => {
  if (!hasAseprite) return;
  dir = await mkdtemp(join(tmpdir(), "aseprite-mcp-test-"));
  file = join(dir, "t.aseprite");
  mock = await startMockReplicate();
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, REPLICATE_API_TOKEN: "test-token", REPLICATE_API_BASE: `http://127.0.0.1:${mock.address().port}/v1` },
  }));
});
after(async () => {
  mock?.close();
  await client?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r;
};
const text = (r) => r.content[0].text;
const grid = async (path, extra = {}) => {
  const [head, ...rows] = text(await call("read_pixels", { path, ...extra })).split("\n");
  const legend = JSON.parse(head.slice(head.indexOf(" ") + 1));
  const inv = Object.fromEntries(Object.entries(legend).map(([c, h]) => [h, c]));
  return { rows, legend, inv };
};

test("create, draw rows, read_pixels round-trip", opts, async () => {
  await call("create_sprite", { path: file, width: 8, height: 8, palette: "pico8" });
  await call("draw", { path: file, x: 1, y: 1, rows: ["kk.", "krk", ".kk"], legend: { k: "#000", r: "#ff004d" } });
  const { rows, inv } = await grid(file, { width: 4, height: 4 });
  const k = inv["#000000"], red = inv["#ff004d"];
  assert.deepEqual(rows, ["....", `.${k}${k}.`, `.${k}${red}${k}`, `..${k}${k}`]);
});

test("shapes, gradient, fill, mirror, replace", opts, async () => {
  await call("draw", { path: file, shapes: [["rect", 0, 0, 7, 7, "#fff"], ["line", 0, 7, 7, 0, "#ffec27"]] });
  await call("edit", { path: file, action: "fill", x: 6, y: 6, color: "#00e436" });
  await call("edit", { path: file, action: "mirror", mode: "left_to_right" });
  await call("edit", { path: file, action: "replace", from: "#ffffff", to: "#29adff" });
  const { legend } = await grid(file);
  const colors = Object.values(legend);
  assert.ok(colors.includes("#29adff") && !colors.includes("#ffffff"), colors.join());
  const g = join(dir, "g.aseprite");
  await call("create_sprite", { path: g, width: 8, height: 8 });
  await call("draw", { path: g, shapes: [["gradient", 0, 0, 7, 7, ["#000000", "#ffffff"], "v"]] });
  const r = await grid(g);
  assert.equal(Object.keys(r.legend).length, 2, "gradient is dithered between exactly 2 colors");
});

test("outline and shade", opts, async () => {
  const f = join(dir, "o.aseprite");
  await call("create_sprite", { path: f, width: 8, height: 8 });
  await call("draw", { path: f, shapes: [["rect", 2, 2, 5, 5, "#3366cc", "#3366cc"]] });
  await call("edit", { path: f, action: "shade", light: "top_left" });
  await call("edit", { path: f, action: "outline" });
  const { rows, legend } = await grid(f);
  assert.equal(rows[0], "........");
  assert.equal(rows[1][1], ".", "no corners by default");
  assert.notEqual(rows[1][2], ".", "outline above the box");
  assert.ok(Object.keys(legend).length >= 4, JSON.stringify(legend));
});

test("batch with layers, frames, preview image", opts, async () => {
  const r = await call("batch", {
    path: file,
    steps: [
      { op: "layer", action: "add", name: "fx" },
      { op: "draw", layer: "fx", pixels: [[0, 0, "#ffec27"], [7, 7, "#ffec27"]] },
      { op: "frames", action: "add", count: 2, copyFrom: 1 },
      { op: "frames", action: "duration", durationMs: 120 },
      { op: "frames", action: "tag", name: "idle", from: 1, to: 3 },
      { op: "sprite_info" },
    ],
    preview: { frames: "all" },
  });
  const info = JSON.parse(text(r).split("\n")[5].slice(2));
  assert.deepEqual(info.frameMs, [120, 120, 120]);
  assert.deepEqual(info.layers, ["Layer 1", "fx"]);
  assert.deepEqual(info.tags, ["idle 1-3"]);
  assert.equal(r.content[1].type, "image");
});

test("failing batch step reports step and saves nothing", opts, async () => {
  const before = (await stat(file)).mtimeMs;
  const r = await client.callTool({
    name: "batch",
    arguments: { path: file, steps: [{ op: "edit", action: "fill", x: 0, y: 0, color: "#000" }, { op: "draw", rows: ["z"], legend: {} }] },
  });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /step 2 \(draw\)/);
  assert.equal((await stat(file)).mtimeMs, before);
});

test("resize, layer update/delete, frame delete, layer preview", opts, async () => {
  const r = await call("batch", {
    path: file,
    steps: [
      { op: "resize", mode: "scale", factor: 2 },
      { op: "resize", mode: "canvas", width: 20, height: 18, anchor: "top_left" },
      { op: "layer", action: "update", layer: "fx", rename: "glow", opacity: 128 },
      { op: "layer", action: "add", name: "tmp", below: "glow" },
      { op: "layer", action: "delete", layer: "tmp" },
      { op: "frames", action: "delete", frames: [3] },
      { op: "sprite_info" },
    ],
  });
  const info = JSON.parse(text(r).split("\n")[6].slice(2));
  assert.equal(info.size, "20x18");
  assert.deepEqual(info.layers, ["Layer 1", "glow [opacity 128]"]);
  assert.equal(info.frameMs.length, 2);
  const p = await call("preview", { path: file, layer: "glow", scale: 4 });
  assert.equal(p.content[1].type, "image");
});

test("import upscaled image, extract palette, quantize", opts, async () => {
  const src = join(dir, "src.aseprite");
  await call("create_sprite", { path: src, width: 6, height: 6 });
  await call("draw", { path: src, shapes: [["rect", 0, 0, 5, 5, "#102030", "#c04020"]], pixels: [[2, 2, "#c84828"]] });
  await call("export", { path: src, output: join(dir, "big.png"), scale: 5 });
  const imp = join(dir, "imp.aseprite");
  const r = await call("create_sprite", { path: imp, from: join(dir, "big.png") });
  assert.match(text(r), /"downscaled":5/);
  const pal = JSON.parse(text(await call("palette", { path: imp, extract: { max: 2 } })));
  assert.equal(pal.uniqueColors, 3);
  assert.equal(pal.extracted.length, 2);
  await call("edit", { path: imp, action: "quantize", palette: pal.extracted });
  const { legend } = await grid(imp);
  assert.deepEqual(new Set(Object.values(legend)), new Set(pal.extracted));
  const ramps = JSON.parse(text(await call("palette", { ramps: [{ base: "#3366cc", steps: 3 }] })));
  assert.equal(ramps.ramps[0].length, 3);
  assert.equal(ramps.ramps[0][1], "#3366cc");
});

test("animate presets -> tagged output + sheet with godot/bevy + recipe CLI", opts, async () => {
  const src = join(dir, "hero.aseprite");
  await call("batch", {
    path: src,
    steps: [
      { op: "create_sprite", width: 8, height: 8, layerName: "body" },
      { op: "draw", shapes: [["rect", 1, 3, 6, 7, "#1d2b53", "#ff004d"]] },
      { op: "layer", action: "add", name: "eyes" },
      { op: "draw", layer: "eyes", pixels: [[2, 4, "#fff"], [5, 4, "#fff"]] },
    ],
  });
  const before = await readFile(src);
  const recipe = join(dir, "anim", "hero.anim.json");
  const r = await call("animate", {
    source: src,
    output: join(dir, "out", "hero_anim.aseprite"),
    padding: [0, 6, 0, 0],
    animations: [
      { name: "idle", preset: { name: "breathe", lag: { eyes: 0.1 } } },
      { name: "jump", preset: "hop" },
      { name: "hit", preset: ["hit"] },
      { name: "spin", preset: "spin", frames: 4 },
      { name: "custom", frames: 3, tracks: [{ layer: "eyes", visible: { seq: [1, 1, 0] } }] },
    ],
    export: { sheet: join(dir, "out", "hero.png"), engines: ["godot", "bevy"] },
    saveRecipe: recipe,
  });
  const out = text(r);
  assert.match(out, /"idle 1-8","jump 9-18","hit 19-23","spin 24-27","custom 28-30"/);
  assert.equal(r.content[1].type, "image");
  assert.deepEqual(await readFile(src), before, "source untouched");
  const ase = JSON.parse(await readFile(join(dir, "out", "hero.json"), "utf8"));
  assert.equal(ase.frames.length, 30);
  assert.equal(ase.meta.frameTags.length, 5);
  const tres = await readFile(join(dir, "out", "hero.tres"), "utf8");
  assert.match(tres, /\[gd_resource type="SpriteFrames"/);
  assert.match(tres, /"name": &"hit"/);
  assert.match(tres, /"loop": false/);
  const bevy = JSON.parse(await readFile(join(dir, "out", "hero.atlas.json"), "utf8"));
  assert.deepEqual(bevy.animations.spin.frames, [23, 24, 25, 26]);
  assert.equal(bevy.frame_size[1], 14);
  // recipe is relative and rebuildable from the CLI
  const saved = JSON.parse(await readFile(recipe, "utf8"));
  assert.equal(saved.source, "../hero.aseprite");
  const { stdout } = await promisify(execFile)(process.execPath, ["dist/index.js", "build", recipe]);
  assert.match(stdout, /built in \d+ms/);
});

test("run_lua escape hatch", opts, async () => {
  const r = await call("run_lua", { path: file, code: "return { w = sprite.width, n = params.n }", params: { n: 3 }, save: false });
  assert.deepEqual(JSON.parse(text(r)), { w: 20, n: 3 });
});

test("worker survives errors and keeps serving", opts, async () => {
  const r = await client.callTool({ name: "run_lua", arguments: { code: "error('boom')" } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /boom/);
  const info = JSON.parse(text(await call("sprite_info", { path: file })));
  assert.equal(info.size, "20x18");
});

test("refuses to overwrite existing images; pixelates imports to a target size", opts, async () => {
  const png = join(dir, "guard.png");
  await call("export", { path: file, output: png, frames: [1, 1] });
  const before = await readFile(png);
  const r = await client.callTool({ name: "draw", arguments: { path: png, pixels: [[0, 0, "#f00"]] } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /refusing to overwrite image/);
  assert.deepEqual(await readFile(png), before);
  const small = join(dir, "small.aseprite");
  const res = await call("create_sprite", { path: small, from: png, width: 10 });
  assert.match(text(res), /"h":9,.*"w":10/);
});

test("separate splits background (with islands) from subject and fills the hole", opts, async () => {
  const f = join(dir, "sep.aseprite");
  await call("batch", {
    path: f,
    steps: [
      { op: "create_sprite", width: 12, height: 12, layerName: "art" },
      { op: "draw", shapes: [["rect", 0, 0, 11, 11, "#332244", "#332244"], ["rect", 4, 4, 8, 8, "#000000", "#ff0000"]], pixels: [[1, 1, "#ffffff"]] },
      { op: "edit", action: "separate" },
    ],
  });
  const info = JSON.parse(text(await call("sprite_info", { path: f })));
  assert.deepEqual(info.layers, ["background", "art"]);
  const art = await grid(f, { layer: "art" });
  const bg = await grid(f, { layer: "background" });
  assert.equal(art.rows[1][1], ".", "star island moved to background");
  assert.notEqual(art.rows[6][6], ".", "subject stays");
  assert.ok(!bg.rows.join("").includes("."), "background hole filled");
});

test("tool schemas avoid tuple-form items (rejected by the Claude API)", opts, async () => {
  const { tools } = await client.listTools();
  const bad = [];
  const walk = (o, p) => {
    if (o && typeof o === "object")
      for (const [k, v] of Object.entries(o)) {
        if (k === "items" && Array.isArray(v)) bad.push(p);
        walk(v, `${p}/${k}`);
      }
  };
  for (const t of tools) walk(t.inputSchema, t.name);
  assert.deepEqual(bad, []);
  assert.equal(tools.length, 16);
});

test("split rigs a character into parts; walk_front lifts legs alternately", opts, async () => {
  const f = join(dir, "rig.aseprite");
  const r = await call("batch", {
    path: f,
    steps: [
      { op: "create_sprite", width: 12, height: 16, layerName: "torso" },
      { op: "draw", shapes: [["rect", 3, 1, 8, 6, "#000", "#fff"], ["rect", 3, 7, 8, 11, "#000", "#ccc"], ["rect", 3, 12, 5, 15, "#000", "#888"], ["rect", 6, 12, 8, 15, "#000", "#888"]] },
      { op: "edit", action: "split", layer: "torso", toLayer: "leg_l", below: true, rects: [[0, 12, 5, 15]] },
      { op: "edit", action: "split", layer: "torso", toLayer: "leg_r", below: true, rects: [[6, 12, 11, 15]] },
      { op: "edit", action: "split", layer: "torso", toLayer: "head", rects: [[0, 0, 11, 6]], backfill: 0 },
    ],
  });
  assert.match(text(r).split("\n")[4], /"layers":\["leg_l","leg_r","torso","head"\]/);
  const out = join(dir, "rig_anim.aseprite");
  await call("animate", {
    source: f, output: out, padding: [0, 2, 0, 1], preview: false,
    animations: [{ name: "walk", preset: "walk_front" }, { name: "idle", preset: "idle_rig" }],
  });
  const bottomRow = async (layer, frame) => {
    const { rows } = await grid(out, { layer, frame });
    return rows.findLastIndex((row) => row.replace(/\./g, "") !== "");
  };
  const rest = await bottomRow("leg_l", 1);
  assert.equal(await bottomRow("leg_l", 3), rest - 2, "left leg lifted on frame 3");
  assert.equal(await bottomRow("leg_r", 3), rest, "right leg planted on frame 3");
  assert.equal(await bottomRow("leg_r", 7), rest - 2, "right leg lifted on frame 7");
  const info = JSON.parse(text(await call("sprite_info", { path: out })));
  assert.deepEqual(info.tags, ["walk 1-8", "idle 9-16"]);
});

test("ingest cleans noisy upscaled frames on a background into pixel art", opts, async () => {
  const truth = join(dir, "truth.aseprite");
  await call("batch", {
    path: truth,
    steps: [
      { op: "create_sprite", width: 16, height: 16 },
      { op: "draw", shapes: [["rect", 4, 3, 11, 14, "#22122c", "#fff2c4"], ["rect", 6, 6, 9, 9, "#22122c", "#b0cfee"]] },
    ],
  });
  // fake "AI output": 6x upscale, noise and tint, on a noisy light background, as numbered PNGs
  await call("run_lua", {
    path: truth, save: false, params: { dir },
    code: `
      local pc = app.pixelColor
      math.randomseed(3)
      local src = Image(sprite.width, sprite.height, ColorMode.RGB); src:drawSprite(sprite, 1)
      for n = 1, 2 do
        local out = Image(96, 96, ColorMode.RGB)
        for y = 0, 95 do for x = 0, 95 do
          local v = src:getPixel(x // 6, y // 6)
          local r, g, b
          if pc.rgbaA(v) == 0 then local c = 220 + math.random(-5, 5); r, g, b = c, c, c + 6
          else r, g, b = pc.rgbaR(v) + 8 + math.random(-9, 9), pc.rgbaG(v) + math.random(-9, 9), pc.rgbaB(v) - 6 + math.random(-9, 9) end
          out:drawPixel(x, y, pc.rgba(math.max(0, math.min(255, r)), math.max(0, math.min(255, g)), math.max(0, math.min(255, b)), 255))
        end end
        out:saveAs(params.dir .. "/ai_" .. n .. ".png")
      end`,
  });
  const out = join(dir, "clean.aseprite");
  const r = await call("ingest", {
    path: out, frames: [join(dir, "ai_1.png"), join(dir, "ai_2.png")], reference: truth, tag: "idle",
  });
  assert.match(text(r), /"frames":2/);
  const a = await grid(out, { frame: 2 });
  const b = await grid(truth);
  assert.deepEqual(a.rows, b.rows);
  assert.deepEqual(new Set(Object.values(a.legend)), new Set(Object.values(b.legend)));
});

test("generate: describe schema, run predictions with the sprite as image, ingest results", opts, async () => {
  const d = text(await call("generate", { model: "test/pixel", describe: true }));
  assert.match(d, /image goes to: input_image/);
  assert.match(d, /style: "a"\|"b" ="a"/);
  assert.match(d, /steps: integer \[1\.\.50\] =20/);
  assert.match(d, /prompt: string \(required\) — What to draw/);
  const truth = join(dir, "truth.aseprite");
  const out = join(dir, "generated.aseprite");
  const r = await call("generate", {
    model: "test/pixel",
    input: { steps: 10 },
    image: { path: truth, size: 64 },
    prompts: ["pose one", "pose two"],
    ingest: { path: out, reference: truth, tag: "gen", align: "feet" },
  });
  assert.match(text(r), /^2 prediction\(s\)/);
  assert.match(text(r), /ingest .*"frames":2/s);
  assert.deepEqual(replicateCalls.map((c) => c.input.prompt).sort(), ["pose one", "pose two"], "parallel: arrival order varies");
  assert.equal(replicateCalls[0].input.steps, 10);
  assert.match(replicateCalls[0].input.input_image, /^data:image\/png;base64,/);
  const a = await grid(out, { frame: 1 });
  const b = await grid(truth);
  assert.deepEqual(a.rows, b.rows);
  const raw = await stat(join(dir, "generated.gen", "gen1_01.png"));
  assert.ok(raw.size > 0, "raw outputs kept for re-ingesting");
});

test("pose track swaps a layer to an alternate drawing; layers without one keep their rest drawing", opts, async () => {
  const f = join(dir, "poses.aseprite");
  await call("batch", {
    path: f,
    steps: [
      { op: "create_sprite", width: 8, height: 8, layerName: "body" },
      { op: "draw", pixels: [[1, 1, "#ff0000"]] },
      { op: "layer", action: "add", name: "arm" },
      { op: "draw", layer: "arm", pixels: [[5, 5, "#00ff00"]] },
      { op: "frames", action: "add", count: 1 },
      // pose sheet (frame 2): only the arm is redrawn
      { op: "draw", layer: "arm", frame: 2, pixels: [[6, 1, "#0000ff"]] },
    ],
  });
  const out = join(dir, "poses_anim.aseprite");
  await call("animate", {
    source: f, output: out, preview: false,
    animations: [{ name: "wave", frames: 2, tracks: [{ layer: "arm", pose: { seq: [1, 2] } }, { layer: "body", pose: { seq: [2, 2] } }] }],
  });
  const f1 = await grid(out, { frame: 1 });
  const f2 = await grid(out, { frame: 2 });
  const at = (g, x, y) => g.legend[g.rows[y][x]];
  assert.equal(at(f1, 5, 5), "#00ff00");
  assert.equal(at(f2, 6, 1), "#0000ff", "arm shows its pose-2 drawing");
  assert.equal(f2.rows[5][5], ".", "rest arm gone in pose 2");
  assert.equal(at(f2, 1, 1), "#ff0000", "body has no pose-2 drawing, keeps rest");
});
