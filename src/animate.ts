import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { resolvePath, runSteps, runWithPreview } from "./aseprite.js";
import { exportSprite, type ExportOptions } from "./export.js";

// ---------------------------------------------------------------------------
// Curves & tracks (evaluated in lua/ops.lua)
// ---------------------------------------------------------------------------
// Curve: number | {seq:[...]} | {keys:[[t,v,ease?]...]} | {wave:"sine"|"triangle"|"square"|"saw", amp, base, phase, cycles}
// Track: { layer?: "*"|name|names, exclude?, timeOffset?, pivot?, smooth?,
//          x, y, sx, sy, sxPx, syPx, rot, shear, waveAmp (+waveLen, waveSpeed), alpha, flash (+flashColor),
//          dissolve, visible, cycle: [hex...] (+cycleStep) }

type Curve = number | boolean | Record<string, unknown>;
export type Track = { layer?: string | string[]; [k: string]: unknown };
export type Animation = {
  name: string;
  preset?: string | PresetRef | (string | PresetRef)[];
  frames?: number;
  durationMs?: number;
  durations?: number[];
  loop?: boolean;
  direction?: string;
  pivot?: string | [number, number];
  sourceFrame?: number;
  sourceFrames?: number[];
  sourceTag?: string;
  tracks?: Track[];
};
type PresetRef = { name: string; [opt: string]: unknown };
type PresetOpts = {
  amount?: number;
  layers?: string | string[];
  lag?: Record<string, number>;
  color?: string;
  colors?: string[];
  [k: string]: unknown;
};
type PresetResult = { frames: number; durationMs: number; loop?: boolean; pivot?: string; tracks: Track[] };

const sine = (amp: number, base = 0, extra: Record<string, unknown> = {}): Curve => ({ wave: "sine", amp, base, ...extra });
const keys = (...k: (number | string)[][]): Curve => ({ keys: k });
const seq = (...v: (number | boolean)[]): Curve => ({ seq: v });

/** Preset definitions: amount = main strength (pixels unless noted). */
const PRESETS: Record<string, { help: string; make: (a: number, o: PresetOpts) => PresetResult }> = {
  bob: {
    help: "idle up/down bob (amount px, 1)",
    make: (a) => ({ frames: 4, durationMs: 180, tracks: [{ y: seq(0, 0, a, a) }] }),
  },
  breathe: {
    help: "squash/stretch breathing, feet planted (amount px, 1)",
    make: (a) => ({ frames: 8, durationMs: 120, tracks: [{ syPx: sine(-a), sxPx: sine(a * 0.5) }] }),
  },
  float: {
    help: "smooth hover (amount px, 2)",
    make: (a) => ({ frames: 12, durationMs: 90, tracks: [{ y: sine(a) }] }),
  },
  hop: {
    help: "squash, jump, land (amount = height px, 6)",
    make: (a) => ({
      frames: 10, durationMs: 70, tracks: [{
        y: keys([0, 0], [0.15, 0], [0.5, -a, "out"], [0.85, 0, "in"], [1, 0]),
        syPx: keys([0, 0], [0.1, -2], [0.2, 2], [0.45, 0], [0.8, 1], [0.9, -2], [1, 0]),
        sxPx: keys([0, 0], [0.1, 2], [0.2, -1], [0.45, 0], [0.8, 0], [0.9, 2], [1, 0]),
      }],
    }),
  },
  walk: {
    help: "two-step bounce + tilt for walking without leg frames (amount px, 1)",
    make: (a) => ({ frames: 4, durationMs: 120, tracks: [{ y: seq(0, -a, 0, -a), rot: seq(-3, 0, 3, 0), smooth: false }] }),
  },
  hit: {
    help: "knockback shake + white flash, one-shot (amount px, 2)",
    make: (a, o) => ({
      frames: 5, durationMs: 50, loop: false,
      tracks: [{ x: seq(-a, a, -a / 2, a / 2, 0), flash: seq(1, 1, 0.5, 0, 0), flashColor: o.color ?? "#ffffff" }],
    }),
  },
  flash: {
    help: "alternate flash color (color, #fff)",
    make: (_a, o) => ({ frames: 2, durationMs: 60, tracks: [{ flash: seq(1, 0), flashColor: o.color ?? "#ffffff" }] }),
  },
  blink: {
    help: "invincibility blink",
    make: () => ({ frames: 2, durationMs: 80, tracks: [{ visible: seq(true, false) }] }),
  },
  shake: {
    help: "fast horizontal jitter (amount px, 1)",
    make: (a) => ({ frames: 4, durationMs: 40, tracks: [{ x: seq(a, -a, a, 0) }] }),
  },
  sway: {
    help: "plants/hair/flames bend, base fixed (amount = shear, 0.15)",
    make: (a) => ({ frames: 12, durationMs: 100, tracks: [{ shear: sine(a) }] }),
  },
  wobble: {
    help: "jelly wobble (amount px, 1)",
    make: (a) => ({ frames: 8, durationMs: 90, tracks: [{ sxPx: sine(a), syPx: sine(-a) }] }),
  },
  pulse: {
    help: "grow/shrink from center (amount px, 1)",
    make: (a) => ({ frames: 8, durationMs: 90, pivot: "center", tracks: [{ sxPx: sine(a), syPx: sine(a) }] }),
  },
  spin: {
    help: "full rotation, RotSprite-smoothed",
    make: () => ({ frames: 8, durationMs: 80, pivot: "center", tracks: [{ rot: keys([0, 0], [1, 360]) }] }),
  },
  swing: {
    help: "pendulum from the top (amount degrees, 15)",
    make: (a) => ({ frames: 12, durationMs: 90, pivot: "top", tracks: [{ rot: sine(a) }] }),
  },
  spawn: {
    help: "pop in with overshoot, one-shot",
    make: () => ({ frames: 6, durationMs: 60, loop: false, tracks: [{ sx: keys([0, 0.2], [0.6, 1.15, "out"], [1, 1, "inout"]), sy: keys([0, 0.2], [0.6, 1.15, "out"], [1, 1, "inout"]) }] }),
  },
  death: {
    help: "flash, sink and dither-dissolve, one-shot (amount = sink px, 2)",
    make: (a) => ({
      frames: 8, durationMs: 80, loop: false,
      tracks: [{ flash: seq(1, 0, 0, 0, 0, 0, 0, 0), dissolve: keys([0, 0], [0.2, 0], [1, 1]), y: keys([0, 0], [1, a]) }],
    }),
  },
  fade_out: {
    help: "fade (alpha in RGB, dither otherwise), one-shot",
    make: () => ({ frames: 6, durationMs: 80, loop: false, tracks: [{ alpha: keys([0, 1], [1, 0]) }] }),
  },
  fade_in: {
    help: "reverse of fade_out, one-shot",
    make: () => ({ frames: 6, durationMs: 80, loop: false, tracks: [{ alpha: keys([0, 0], [1, 1]) }] }),
  },
  wave: {
    help: "horizontal ripple: flags, water, heat (amount px, 1)",
    make: (a, o) => ({ frames: 8, durationMs: 90, tracks: [{ waveAmp: a, waveLen: o.length ?? 8, waveSpeed: 1 }] }),
  },
  cycle: {
    help: "palette cycling: colors rotate each frame (colors, required)",
    make: (_a, o) => {
      if (!o.colors?.length) throw new Error("cycle preset needs options.colors");
      return { frames: o.colors.length, durationMs: 100, tracks: [{ cycle: o.colors }] };
    },
  },
};

// ---------------------------------------------------------------------------
// Rig presets: characters cut into part layers (edit split). Default layer names below;
// remap with options.parts, e.g. {"head":"skull"}. Parts a character lacks are simply skipped.
// ---------------------------------------------------------------------------

const PART_NAMES = ["head", "jaw", "torso", "arm_l", "arm_r", "leg_l", "leg_r"] as const;
type Part = (typeof PART_NAMES)[number];

function partsOf(o: PresetOpts): Record<Part, string> {
  const map = (o.parts ?? {}) as Partial<Record<Part, string>>;
  return Object.fromEntries(PART_NAMES.map((p) => [p, map[p] ?? p])) as Record<Part, string>;
}

const round = (v: number) => Math.round(v);

Object.assign(PRESETS, {
  idle_rig: {
    help: "rigged idle: torso breathes, head and arms follow 1-2 frames later (amount px, 1)",
    make: (a: number, o: PresetOpts): PresetResult => {
      const p = partsOf(o);
      const breath = [0, 0, 1, 1, 1, 1, 0, 0].map((v) => round(v * a));
      const lag = (n: number) => breath.map((_, i) => breath[(i - n + 8) % 8]);
      return {
        frames: 8, durationMs: 140, tracks: [
          { layer: p.torso, y: { seq: breath } },
          { layer: [p.head, p.jaw], y: { seq: lag(1) } },
          { layer: [p.arm_l, p.arm_r], y: { seq: lag(2) } },
        ],
      };
    },
  },
  walk_front: {
    help: "rigged front-facing walk: alternating leg lifts, body bob + weight shift, opposite arm swing (amount = lift px, 2)",
    make: (a: number, o: PresetOpts): PresetResult => {
      const p = partsOf(o);
      const lift = [0, -a / 2, -a, -a / 2, 0, 0, 0, 0].map(round);
      const half = (s: number[]) => s.map((_, i) => s[(i + 4) % 8]);
      const body = [p.torso, p.arm_l, p.arm_r, p.head, p.jaw];
      return {
        frames: 8, durationMs: 100, tracks: [
          { layer: p.leg_l, y: { seq: lift } },
          { layer: p.leg_r, y: { seq: half(lift) } },
          { layer: body, y: { seq: [1, 0, 0, 0, 1, 0, 0, 0] }, x: { seq: [0, 0, 1, 0, 0, 0, -1, 0] } },
          { layer: [p.head, p.jaw], y: { seq: [0, 1, 0, 0, 0, 1, 0, 0] } },
          { layer: p.arm_l, y: { seq: [0, 0, 0, 0, 0, -1, -1, 0] } },
          { layer: p.arm_r, y: { seq: [0, -1, -1, 0, 0, 0, 0, 0] } },
        ],
      };
    },
  },
});

const DEFAULT_AMOUNT: Record<string, number> = { float: 2, hop: 6, hit: 2, sway: 0.15, swing: 15, death: 2, walk_front: 2 };

export const PRESET_HELP = Object.entries(PRESETS)
  .map(([k, v]) => `${k}: ${v.help}`)
  .join("; ");

/** Expand preset references into concrete tracks (presets combine; explicit fields win). */
export function expandAnimation(anim: Animation): Record<string, unknown> {
  const refs = anim.preset === undefined ? [] : Array.isArray(anim.preset) ? anim.preset : [anim.preset];
  const tracks: Track[] = [];
  let base: Partial<PresetResult> = {};
  for (const r of refs) {
    const ref: PresetRef = typeof r === "string" ? { name: r } : r;
    const def = PRESETS[ref.name];
    if (!def) throw new Error(`unknown preset '${ref.name}'. Presets: ${Object.keys(PRESETS).join(", ")}`);
    const o = ref as PresetOpts;
    const res = def.make(o.amount ?? DEFAULT_AMOUNT[ref.name] ?? 1, o);
    if (!base.frames) base = res;
    for (const t of res.tracks) {
      const layers = o.layers;
      const lag = o.lag ?? {};
      const lagged = Object.keys(lag);
      tracks.push({ ...t, layer: layers ?? t.layer ?? "*", ...(lagged.length ? { exclude: lagged } : {}) });
      // secondary motion: lagged layers follow the same motion, delayed
      for (const [layer, delay] of Object.entries(lag)) tracks.push({ ...t, layer, timeOffset: -delay });
    }
  }
  const { preset: _p, tracks: extra, ...rest } = anim;
  return {
    frames: base.frames,
    durationMs: base.durationMs,
    loop: base.loop,
    pivot: base.pivot,
    ...rest,
    tracks: [...tracks, ...(extra ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Recipes: declarative, re-runnable "static art -> animated spritesheet" builds
// ---------------------------------------------------------------------------

export type Recipe = {
  source: string;
  output: string;
  padding?: number | [number, number, number, number];
  animations: Animation[];
  export?: Omit<ExportOptions, "output" | "sheet"> & { sheet: string } & NonNullable<ExportOptions["sheet"]>;
};

/** Resolve recipe paths relative to `base` (the recipe file's directory). */
function resolveRecipe(r: Recipe, base?: string): Recipe {
  const res = (p: string) => resolvePath(p, base);
  return {
    ...r,
    source: res(r.source),
    output: res(r.output),
    export: r.export && {
      ...r.export,
      sheet: res(r.export.sheet),
      data: r.export.data && res(r.export.data),
    },
  };
}

export async function loadRecipe(file: string): Promise<Recipe> {
  const abs = resolvePath(file);
  return resolveRecipe(JSON.parse(await readFile(abs, "utf8")), dirname(abs));
}

/** Store a recipe with paths relative to its own location so it can live in a game repo. */
export async function saveRecipe(r: Recipe, file: string): Promise<string> {
  const abs = resolvePath(file);
  const dir = dirname(abs);
  const rel = (p: string) => (isAbsolute(p) ? relative(dir, p) || "." : p);
  const out: Recipe = {
    ...r,
    source: rel(r.source),
    output: rel(r.output),
    export: r.export && { ...r.export, sheet: rel(r.export.sheet), data: r.export.data && rel(r.export.data) },
  };
  await mkdir(dir, { recursive: true });
  await writeFile(abs, JSON.stringify(out, null, 2) + "\n");
  return abs;
}

export type BuildResult = { summary: unknown; files: string[]; png?: string };

/** Build animations from the recipe's source into its output, then export. Source is never modified. */
export async function buildRecipe(recipe: Recipe, opts: { preview?: boolean; base?: string } = {}): Promise<BuildResult> {
  const r = resolveRecipe(recipe, opts.base);
  const step = {
    op: "animate",
    output: r.output,
    padding: r.padding,
    animations: r.animations.map(expandAnimation),
  };
  let summary: unknown;
  let png: string | undefined;
  if (opts.preview) {
    // render the preview from the built output in a second request so tags are in place
    [summary] = await runSteps(r.source, [step]);
    ({ png } = await runWithPreview(r.output, [], { tags: true }));
  } else {
    [summary] = await runSteps(r.source, [step]);
  }
  const files = [r.output];
  if (r.export) {
    const { sheet, scale, ...sheetOpts } = r.export;
    files.push(...(await exportSprite(r.output, { output: sheet, scale, sheet: sheetOpts })));
  }
  return { summary, files, png };
}
