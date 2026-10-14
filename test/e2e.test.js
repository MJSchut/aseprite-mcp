// End-to-end: spawns the built server over stdio and drives a real Aseprite.
// Skipped when Aseprite cannot be found.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { asepriteBinary } from "../dist/aseprite.js";

let hasAseprite = true;
try { asepriteBinary(); } catch { hasAseprite = false; }
const opts = { skip: !hasAseprite && "Aseprite not installed" };

let client, dir, file;
before(async () => {
  if (!hasAseprite) return;
  dir = await mkdtemp(join(tmpdir(), "aseprite-mcp-test-"));
  file = join(dir, "t.aseprite");
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));
});
after(async () => {
  await client?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r;
};
const text = (r) => r.content[0].text;

test("create, draw_grid, read_pixels round-trip", opts, async () => {
  await call("create_sprite", { path: file, width: 8, height: 8, palette: "pico8" });
  await call("draw_grid", { path: file, x: 1, y: 1, rows: ["kk.", "krk", ".kk"], legend: { k: "#000", r: "#ff004d" } });
  const r = text(await call("read_pixels", { path: file, x: 0, y: 0, width: 4, height: 4 }));
  assert.match(r, /^4x4 at 0,0/);
  const [, legendLine, ...rows] = r.split("\n");
  const legend = JSON.parse(legendLine.slice(7));
  const inv = Object.fromEntries(Object.entries(legend).map(([c, h]) => [h, c]));
  const k = inv["#000000"], red = inv["#ff004d"];
  assert.deepEqual(rows, ["....", `.${k}${k}.`, `.${k}${red}${k}`, `..${k}${k}`]);
});

test("shapes, fill, mirror, replace_color", opts, async () => {
  await call("draw_shape", { path: file, shape: "rectangle", x1: 0, y1: 0, x2: 7, y2: 7, color: "#fff", filled: false });
  await call("fill", { path: file, x: 6, y: 6, color: "#00e436" });
  await call("mirror", { path: file, mode: "left_to_right" });
  await call("replace_color", { path: file, from: "#ffffff", to: "#29adff" });
  const r = text(await call("read_pixels", { path: file }));
  assert.ok(r.includes("#29adff") && !r.includes("#ffffff"), r);
});

test("batch with layers, frames, preview image", opts, async () => {
  const r = await call("batch", {
    path: file,
    steps: [
      { op: "layer", action: "add", name: "fx" },
      { op: "draw_pixels", layer: "fx", pixels: [[0, 0, "#ffec27"], [7, 7, "#ffec27"]] },
      { op: "frames", action: "add", count: 2, copyFrom: 1 },
      { op: "frames", action: "duration", durationMs: 120 },
      { op: "frames", action: "tag", name: "idle", from: 1, to: 3 },
      { op: "sprite_info" },
    ],
    preview: { frames: "all" },
  });
  const info = JSON.parse(text(r).split("\n")[5].slice(2));
  assert.equal(info.frames.length, 3);
  assert.equal(info.frames[2].durationMs, 120);
  assert.deepEqual(info.layers.map((l) => l.name), ["Layer 1", "fx"]);
  assert.equal(info.tags[0].name, "idle");
  assert.equal(r.content[1].type, "image");
  assert.ok(r.content[1].data.length > 100);
});

test("failing batch step reports step and saves nothing", opts, async () => {
  const before = (await stat(file)).mtimeMs;
  const r = await client.callTool({
    name: "batch",
    arguments: { path: file, steps: [{ op: "fill", x: 0, y: 0, color: "#000" }, { op: "draw_grid", rows: ["z"], legend: {} }] },
  });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /step 2 \(draw_grid\)/);
  assert.equal((await stat(file)).mtimeMs, before);
});

test("export png and spritesheet", opts, async () => {
  await call("export", { path: file, output: join(dir, "f1.png"), frames: [1, 1], scale: 4 });
  await call("export", { path: file, output: join(dir, "sheet.png"), sheet: { data: join(dir, "sheet.json") } });
  assert.ok((await stat(join(dir, "f1.png"))).size > 0);
  assert.ok((await stat(join(dir, "sheet.json"))).size > 0);
});

test("run_lua escape hatch", opts, async () => {
  const r = await call("run_lua", { path: file, code: "return { w = sprite.width, n = params.n }", params: { n: 3 }, save: false });
  assert.deepEqual(JSON.parse(text(r)), { w: 8, n: 3 });
});

test("resize, layer update/delete, frame delete, preview tool", opts, async () => {
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
  assert.equal(info.width, 20);
  assert.equal(info.height, 18);
  assert.deepEqual(info.layers.map((l) => [l.name, l.opacity]), [["Layer 1", 255], ["glow", 128]]);
  assert.equal(info.frames.length, 2);
  const p = await call("preview", { path: file, layer: "glow", scale: 4 });
  assert.equal(p.content[1].type, "image");
});
