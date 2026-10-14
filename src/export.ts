import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { exec } from "./aseprite.js";

export type ExportOptions = {
  output: string;
  scale?: number;
  frames?: [number, number];
  tag?: string;
  layer?: string;
  splitLayers?: boolean;
  /** Spritesheet mode: writes `output` as a sheet plus JSON data (and engine files). */
  sheet?: {
    type?: "packed" | "rows" | "columns" | "horizontal" | "vertical";
    columns?: number;
    data?: string;
    trim?: boolean;
    padding?: number;
    extrude?: boolean;
    splitTags?: boolean;
    engines?: ("godot" | "bevy")[];
    godotResPath?: string;
  };
};

type AseFrame = {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  duration: number;
};
type AseTag = { name: string; from: number; to: number; direction: string; repeat?: string };
type AseData = { frames: AseFrame[]; meta: { image: string; size: { w: number; h: number }; frameTags?: AseTag[] } };

/** Export via the Aseprite CLI. Frames are 1-based. Returns written files. */
export async function exportSprite(input: string, o: ExportOptions): Promise<string[]> {
  await mkdir(dirname(o.output), { recursive: true });
  const args = ["-b"];
  if (o.layer) args.push("--layer", o.layer);
  if (o.tag) args.push("--tag", o.tag);
  if (o.frames) args.push("--frame-range", `${o.frames[0] - 1},${o.frames[1] - 1}`);
  if (o.splitLayers) args.push("--split-layers");
  const s = o.sheet;
  if (s?.splitTags) args.push("--split-tags");
  args.push(input);
  if (o.scale && o.scale !== 1) args.push("--scale", String(o.scale));
  if (!s) {
    args.push("--save-as", o.output);
    await exec(args);
    return [o.output];
  }
  const data = s.data ?? o.output.replace(/\.[^.]+$/, "") + ".json";
  args.push("--sheet", o.output, "--sheet-type", s.type ?? "packed");
  if (s.columns) args.push("--sheet-columns", String(s.columns));
  if (s.trim) args.push("--trim");
  if (s.padding) args.push("--shape-padding", String(s.padding));
  if (s.extrude) args.push("--extrude");
  args.push("--data", data, "--format", "json-array", "--list-tags", "--filename-format", "{title}_{tag}_{tagframe}");
  await exec(args);
  const files = [o.output, data];
  if (s.splitTags || !s.engines?.length) return files;
  const ase: AseData = JSON.parse(await readFile(data, "utf8"));
  if (s.engines.includes("godot")) files.push(await writeGodot(ase, o.output, s.godotResPath));
  if (s.engines.includes("bevy")) files.push(await writeBevy(ase, o.output));
  return files;
}

/** Animations as frame index lists (pingpong/reverse expanded), with loop flag. */
function animations(ase: AseData) {
  const tags = ase.meta.frameTags?.length
    ? ase.meta.frameTags
    : [{ name: "default", from: 0, to: ase.frames.length - 1, direction: "forward" } as AseTag];
  return tags.map((t) => {
    const fwd = Array.from({ length: t.to - t.from + 1 }, (_, i) => t.from + i);
    let frames = fwd;
    if (t.direction === "reverse") frames = [...fwd].reverse();
    else if (t.direction === "pingpong") frames = [...fwd, ...fwd.slice(1, -1).reverse()];
    else if (t.direction === "pingpong_reverse") frames = [...fwd].reverse().concat(fwd.slice(1, -1));
    return { name: t.name, frames, loop: !t.repeat || t.repeat === "0" };
  });
}

function findGodotRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "project.godot"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** Godot 4 SpriteFrames resource (one animation per tag) next to the sheet. */
async function writeGodot(ase: AseData, sheet: string, resPath?: string): Promise<string> {
  const out = sheet.replace(/\.[^.]+$/, "") + ".tres";
  if (!resPath) {
    const root = findGodotRoot(dirname(sheet));
    resPath = root ? "res://" + relative(root, sheet).split(sep).join("/") : basename(sheet);
  }
  const lines: string[] = [];
  const subs: string[] = [];
  ase.frames.forEach((f, i) => {
    subs.push(`[sub_resource type="AtlasTexture" id="f${i}"]`, `atlas = ExtResource("sheet")`,
      `region = Rect2(${f.frame.x}, ${f.frame.y}, ${f.frame.w}, ${f.frame.h})`);
    if (f.trimmed) {
      const s = f.spriteSourceSize;
      subs.push(`margin = Rect2(${s.x}, ${s.y}, ${f.sourceSize.w - s.w}, ${f.sourceSize.h - s.h})`);
    }
    subs.push("");
  });
  const anims = animations(ase).map((a) => {
    const base = Math.min(...a.frames.map((i) => ase.frames[i].duration));
    const frames = a.frames
      .map((i) => `{\n"duration": ${+(ase.frames[i].duration / base).toFixed(4)},\n"texture": SubResource("f${i}")\n}`)
      .join(", ");
    return `{\n"frames": [${frames}],\n"loop": ${a.loop},\n"name": &"${a.name}",\n"speed": ${+(1000 / base).toFixed(4)}\n}`;
  });
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${ase.frames.length + 2} format=3]`, "",
    `[ext_resource type="Texture2D" path="${resPath}" id="sheet"]`, "", ...subs,
    "[resource]", `animations = [${anims.join(", ")}]`, "");
  await writeFile(out, lines.join("\n"));
  return out;
}

/** Engine-agnostic atlas description shaped for Bevy's TextureAtlasLayout. */
async function writeBevy(ase: AseData, sheet: string): Promise<string> {
  const out = sheet.replace(/\.[^.]+$/, "") + ".atlas.json";
  const json = {
    image: basename(sheet),
    size: [ase.meta.size.w, ase.meta.size.h],
    frame_size: [ase.frames[0]?.sourceSize.w ?? 0, ase.frames[0]?.sourceSize.h ?? 0],
    frames: ase.frames.map((f) => ({
      rect: [f.frame.x, f.frame.y, f.frame.w, f.frame.h],
      offset: [f.spriteSourceSize.x, f.spriteSourceSize.y],
      duration_ms: f.duration,
    })),
    animations: Object.fromEntries(
      animations(ase).map((a) => [a.name, { frames: a.frames, looping: a.loop }]),
    ),
  };
  await writeFile(out, JSON.stringify(json, null, 2) + "\n");
  return out;
}
