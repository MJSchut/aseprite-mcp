// Part library: organic, parameterized character parts that expand into draw primitives.
// Coordinates are relative to the feet (x = center, y = ground) for a ~44px chibi body (head ~16px)
// at scale 1; `scale` multiplies everything. Light comes from the top-left.

type Shape = unknown[];
export type Ramp = [string, string, string, string?]; // shadow, base, light, highlight?

export const RAMPS: Record<string, Ramp> = {
  red: ["#7a1e2c", "#c23434", "#ef6a48", "#ffb08a"],
  crimson: ["#5a1426", "#9a2238", "#d0404e", "#f08080"],
  orange: ["#9a3e1e", "#e07028", "#ffa04a", "#ffd090"],
  gold: ["#9a6a1a", "#e8b030", "#ffe070", "#fff6c0"],
  green: ["#1e4a32", "#2f7a44", "#56b056", "#a8e07c"],
  emerald: ["#103e34", "#1a6a4a", "#2fa060", "#7ee090"],
  teal: ["#1a5258", "#2a8a8a", "#5cc8b8", "#b0f0e0"],
  blue: ["#22305a", "#34568e", "#5a88c4", "#a8d0f0"],
  navy: ["#141c34", "#22304e", "#3a4c72", "#6a82a8"],
  purple: ["#30184e", "#5a2e90", "#8c58cc", "#c8a0f0"],
  violet: ["#3a2a8e", "#5a42c0", "#8a70e8", "#c0b0ff"],
  pink: ["#7a2a4a", "#c04a72", "#ea7a9a", "#ffc0d0"],
  magenta: ["#5a1440", "#9a2a6a", "#d050a0", "#f0a0d0"],
  brown: ["#3e2418", "#6a4028", "#9a6840", "#c89a68"],
  tan: ["#8a5a3a", "#c08a5a", "#e2b888", "#f6dcb4"],
  gray: ["#3c3c4c", "#68687e", "#9a9ab0", "#d0d0e0"],
  steel: ["#3a4458", "#64748e", "#a0b0c8", "#e0e8f4"],
  black: ["#120e18", "#221a2c", "#3a2e46", "#5a4a68"],
  white: ["#8a8aa4", "#c8ccdc", "#eef0f8", "#ffffff"],
  cream: ["#a88a6a", "#e0caa4", "#f6e8cc", "#fffaf0"],
  // skins
  pale: ["#c89a9a", "#f2d4cc", "#fff0ea", "#ffffff"],
  light: ["#c47a62", "#f0b498", "#ffd8c0", "#fff0e4"],
  skinTan: ["#9a5a3a", "#d08a5e", "#eeb486", "#ffd8b0"],
  dark: ["#4a2a22", "#7a4a36", "#a06a4c", "#c89070"],
  skinGreen: ["#2a5a2a", "#4a8a3a", "#7ac05a", "#b0e888"],
  skinBlue: ["#2a3a6a", "#4a62a0", "#7a98d0", "#b0c8f0"],
};
const INK = "#1a1220";

const ramp = (r: string | Ramp | undefined, fallback: string): Ramp =>
  Array.isArray(r) ? (r as Ramp) : RAMPS[r ?? fallback] ?? RAMPS[fallback];
const three = (r: Ramp) => [r[0], r[1], r[2]];
const mostlyBase = (r: Ramp) => [r[0], r[1], r[1], r[1], r[2]];

export type PersonSpec = {
  skin?: string | Ramp;
  eyes?: string; // iris/pupil color
  glowEyes?: boolean;
  hair?: { style?: "long" | "bob" | "spiky" | "bun" | "ponytail" | "none"; color?: string | Ramp };
  hat?: { type: "witch" | "wizard" | "top" | "hood" | "beret" | "crown"; color?: string | Ramp; band?: string | Ramp; height?: number; bend?: number; droop?: number; brim?: number; tilt?: number };
  top?: { type?: "robe" | "dress" | "tunic" | "coat" | "armor"; color?: string | Ramp; inner?: string | Ramp; trim?: string | Ramp; hem?: "straight" | "zigzag" | "ragged" | "flared" };
  sleeves?: { type?: "fitted" | "puffed" | "bell"; color?: string | Ramp };
  cape?: { type?: "flowing" | "ragged" | "tendrils"; color?: string | Ramp };
  legs?: string | Ramp;
  boots?: { type?: "short" | "tall" | "pointy"; color?: string | Ramp };
  belt?: string | Ramp;
  extras?: ("halo" | "catEars" | "elfEars" | "foxTail" | "goggles" | "horns" | "aura" | "spikes" | "staff")[];
  extraColor?: string | Ramp;
};

/** Expand a person into draw shapes (body) and details (drawn after outline). */
export function person(x: number, y: number, spec: PersonSpec, scale = 1): { shapes: Shape[]; details: { shapes: Shape[]; pixels: unknown[] } } {
  const s = scale;
  const lift = (dy: number) => (dy < -15 ? dy - 3 : dy); // upper body raised: longer legs, taller read
  const P = (dx: number, dy: number, corner?: 1): number[] =>
    corner ? [x + dx * s, y + lift(dy) * s, 1] : [x + dx * s, y + lift(dy) * s];
  const pts = (list: number[][]) => list.map(([dx, dy, c]) => P(dx, dy, c as 1 | undefined));
  const out: Shape[] = [];
  const add = (...sh: Shape[]) => out.push(...sh);
  const sk = ramp(spec.skin, "light");
  const top = spec.top ?? {};
  const topR = ramp(top.color, "blue");
  const trimR = top.trim ? ramp(top.trim, "gold") : undefined;
  const sleeveR = ramp(spec.sleeves?.color ?? top.color, "blue");
  const hairR = ramp(spec.hair?.color, "brown");
  const xR = ramp(spec.extraColor, "gold");
  const ex = new Set(spec.extras ?? []);
  const long = top.type === "robe" || top.type === "dress";
  const hemY = top.type === "tunic" || top.type === "armor" ? -12 : top.type === "coat" ? -6 : -1;

  // --- back layer: aura, halo, cape, back hair, tail -------------------------------------------
  if (ex.has("aura")) {
    for (const [a, b, c] of [[-9, -10, -24], [9, -12, -28], [-11, -20, -36], [11, -22, -34]])
      add(["tube", pts([[a, b], [a * 1.2, (b + c) / 2], [a * 0.9, c]]), three(xR), 4 * s, 0]);
  }
  if (ex.has("halo")) {
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      add(["tube", [P(Math.cos(t) * 11, -36 + Math.sin(t) * 11), P(Math.cos(t) * 16, -36 + Math.sin(t) * 16)], three(xR), 3 * s, 0]);
    }
    add(["lobe", ...P(0, -36), 12 * s, 12 * s, three(xR), { bumps: 12, bumpiness: 0.06 }]);
  }
  if (ex.has("spikes")) {
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 0.3], [1, 0.3], [-1, -0.5], [1, -0.5]])
      add(["tube", [P(a * 5, -24), P(a * 16, -24 + b * 10)], three(xR), 2 * s, 0]);
  }
  if (spec.cape) {
    const cR = ramp(spec.cape.color, "red");
    const t = spec.cape.type ?? "flowing";
    if (t === "tendrils") {
      for (const [a, k] of [[-1, 1], [1, 1], [-1, 0.65], [1, 0.65]])
        add(["tube", pts([[a * 5, -12], [a * 12 * k, -3], [a * 18 * k, -2], [a * 20 * k, -7], [a * 17 * k, -10]]), three(cR), 6 * s, 1]);
    } else {
      const hem = t === "ragged"
        ? [[11, -1, 1], [8, -4], [5, 0, 1], [2, -3], [-1, 0, 1], [-4, -3], [-7, 0, 1], [-10, -3], [-12, -1, 1]]
        : [[12, -1], [6, 0], [0, 0], [-6, 0], [-12, -1]];
      add(["form", pts([[-6, -28, 1], [6, -28, 1], [10, -18], ...hem, [-10, -18]]), mostlyBase(cR)]);
    }
  }
  const hairStyle = spec.hair?.style ?? "bob";
  if (hairStyle === "long")
    add(["form", pts([[-9, -38], [-6, -45], [6, -45], [9, -38], [10, -24], [7, -20, 1], [3, -23], [0, -21, 1], [-3, -23], [-7, -20, 1], [-10, -24]]), three(hairR)]);
  if (hairStyle === "long")
    for (const a of [-1, 1]) add(["tube", pts([[a * 8, -38], [a * 11, -31], [a * 12, -25], [a * 15, -22]]), three(hairR), 4 * s, 1]);
  if (hairStyle === "ponytail") add(["tube", pts([[4, -42], [10, -38], [11, -30], [9, -24]]), three(hairR), 6 * s, 1]);
  if (hairStyle === "bun") add(["lobe", ...P(0, -45), 5 * s, 4 * s, three(hairR), { bumps: 5 }]);
  if (ex.has("foxTail")) {
    add(["tube", pts([[3, -14], [10, -10], [15, -16], [14, -24]]), three(xR), 5 * s, 7 * s]);
    add(["tube", pts([[14, -21], [14, -24], [13, -26]]), three(ramp("white", "white")), 6 * s, 2 * s]);
  }

  // --- legs and boots ---------------------------------------------------------------------------
  const legR = ramp(spec.legs, "navy");
  const bootR = ramp(spec.boots?.color, "brown");
  for (const a of [-1, 1]) {
    add(["tube", pts([[a * 3, -15], [a * 3, -3]]), three(legR), 4 * s, 4 * s]);
    const bt = spec.boots?.type ?? "short";
    const topY = bt === "tall" ? -9 : -4;
    const toe = bt === "pointy" ? [[a * 8, -2], [a * 9, -4, 1]] : [[a * 6, -1]];
    add(["form", pts([[a * 1, topY, 1], [a * 5, topY, 1], [a * 5, -2], ...toe, [a * 6, 0, 1], [a * 1, 0, 1]]), three(bootR)]);
    if (bt === "tall") add(["line", ...P(a * 1, topY), ...P(a * 5, topY), bootR[2]]);
  }

  // --- torso garment -----------------------------------------------------------------------------
  const tt = top.type ?? "tunic";
  const hemPts = (w: number) => {
    const h = top.hem ?? (long ? "flared" : "straight");
    if (h === "zigzag") return [[w, hemY, 1], [w * 0.6, hemY - 2], [w * 0.2, hemY, 1], [-w * 0.2, hemY - 2], [-w * 0.6, hemY, 1], [-w, hemY - 2]];
    if (h === "ragged") return [[w, hemY - 1, 1], [w * 0.7, hemY - 3], [w * 0.4, hemY, 1], [0, hemY - 2], [-w * 0.4, hemY, 1], [-w * 0.7, hemY - 3], [-w, hemY - 1, 1]];
    return [[w, hemY, 1], [w * 0.5, hemY + 0.5], [-w * 0.5, hemY + 0.5], [-w, hemY, 1]];
  };
  const hemW = tt === "dress" ? 11 : long ? 10 : tt === "coat" ? 9 : 7;
  add(["form", pts([[-6, -28, 1], [6, -28, 1], [7, -21], [tt === "dress" ? 5 : 7, -18], ...hemPts(hemW), [tt === "dress" ? -5 : -7, -18], [-7, -21]]), mostlyBase(topR)]);
  if (tt === "coat" || tt === "robe") {
    const inR = ramp(top.inner, "black");
    add(["form", pts([[-1, -27, 1], [1, -27, 1], [2, hemY, 1], [-2, hemY, 1]]), three(inR)]);
  }
  if (tt === "armor") {
    add(["form", pts([[-4, -27], [4, -27], [5, -22], [0, -19], [-5, -22]]), three(trimR ?? ramp("steel", "steel"))]);
    for (const a of [-1, 1]) add(["lobe", ...P(a * 7, -26), 3.5 * s, 3 * s, three(trimR ?? ramp("steel", "steel")), { bumps: 3, bumpiness: 0 }]);
  }
  if (long || tt === "coat") {
    // cloth folds: shadow lines falling from the waist, one highlight on the lit side
    add(["curve", pts([[3, -18], [4, (hemY - 18) / 2], [hemW * 0.5, hemY - 1]]), topR[0]]);
    add(["curve", pts([[-2, -17], [-3, (hemY - 17) / 2], [-hemW * 0.35, hemY - 1]]), topR[0]]);
    add(["curve", pts([[-4, -20], [-6, (hemY - 20) / 2], [-hemW * 0.75, hemY - 2]]), topR[2]]);
  }
  if (trimR && tt !== "armor") {
    add(["line", ...P(-hemW, hemY), ...P(hemW, hemY), trimR[1]]);
    add(["curve", pts([[-5, -28], [0, -25], [5, -28]]), trimR[1]]); // collar
    if (tt === "coat" || tt === "robe") add(["line", ...P(-2, -26), ...P(-2, hemY), trimR[1]], ["line", ...P(2, -26), ...P(2, hemY), trimR[1]]);
  }
  if (spec.belt) {
    const bR = ramp(spec.belt, "brown");
    add(["line", ...P(-6, -19), ...P(6, -19), bR[1]], ["line", ...P(-6, -18), ...P(6, -18), bR[0]], ["form", pts([[-1, -20, 1], [1, -20, 1], [1, -17, 1], [-1, -17, 1]]), [RAMPS.gold[1], RAMPS.gold[2]]]);
  }

  // --- arms -------------------------------------------------------------------------------------
  const sl = spec.sleeves?.type ?? "fitted";
  for (const a of [-1, 1]) {
    if (sl === "puffed") add(["lobe", ...P(a * 7, -26), 3.5 * s, 3.5 * s, three(sleeveR), { bumps: 4, bumpiness: 0.05 }]);
    add(["tube", pts([[a * 6, -27], [a * 8.5, -22], [a * 8.5, -17]]), three(sleeveR), (sl === "puffed" ? 3 : 4) * s, (sl === "bell" ? 7 : 3) * s]);
    add(["form", pts([[a * 7, -17], [a * 10, -17], [a * 10, -14], [a * 7, -14]]), [sk[1], sk[1], sk[2]]]);
  }
  if (ex.has("staff")) add(["tube", pts([[10, 0], [10, -24], [11, -32]]), three(ramp("brown", "brown")), 2 * s, 2 * s], ["lobe", ...P(11, -34), 3 * s, 3 * s, three(xR), { bumps: 4 }]);

  // --- head -------------------------------------------------------------------------------------
  add(["form", pts([[-2, -29, 1], [2, -29, 1], [2, -27, 1], [-2, -27, 1]]), [sk[0], sk[0]]]); // neck
  if (ex.has("elfEars")) for (const a of [-1, 1]) add(["tube", pts([[a * 7, -35], [a * 11, -37], [a * 13, -40]]), [sk[0], sk[1], sk[2]], 4 * s, 0]);
  add(["form", pts([[-8, -38], [-5, -43], [0, -44], [5, -43], [8, -38], [8, -33], [5, -29], [0, -28], [-5, -29], [-8, -33]]), mostlyBase(sk), { shrink: 0.08 }]);
  // front hair: fringe of locks, side locks for long styles
  if (hairStyle !== "none") {
    if (hairStyle === "spiky") {
      for (const [a, b] of [[-8, -40], [-5, -46], [0, -48], [5, -46], [8, -40], [-9, -34], [9, -34]])
        add(["tube", [P(0, -39), P(a * 1.3, b - 3)], three(hairR), 6 * s, 0]);
    }
    add(["form", pts([[-9, -37], [-7, -44], [0, -46], [7, -44], [9, -37], [7, -38], [5, -36, 1], [3, -39], [0, -37, 1], [-3, -39], [-5, -36, 1], [-7, -38]]), three(hairR)]);
    if (hairStyle === "long" || hairStyle === "bob")
      for (const a of [-1, 1]) add(["tube", pts([[a * 8, -39], [a * 9, -33], [a * 8, hairStyle === "long" ? -26 : -31]]), three(hairR), 4 * s, 2 * s]);
  }
  if (ex.has("catEars")) for (const a of [-1, 1]) add(["form", pts([[a * 3, -44], [a * 7, -51, 1], [a * 8, -42]]), three(xR)]);
  if (ex.has("horns")) for (const a of [-1, 1]) add(["tube", pts([[a * 5, -43], [a * 8, -48], [a * 7, -52]]), three(xR), 4 * s, 0]);

  // --- hat ----------------------------------------------------------------------------------------
  const hat = spec.hat;
  if (hat) {
    const hR = ramp(hat.color, "purple");
    const bR = hat.band ? ramp(hat.band, "gold") : undefined;
    const bw = 15 * (hat.brim ?? 1);
    const ht = hat.height ?? 1.15, bend = hat.bend ?? 0.4, droop = hat.droop ?? 0.3, tilt = hat.tilt ?? 0.4;
    if (hat.type === "witch" || hat.type === "wizard") {
      const tip = [6 + bend * 10, -62 * ht + 10 + droop * 8];
      add(["tube", pts([[0, -44], [1, -52 * ht + 4], [3 + bend * 5, -58 * ht + 6], tip]), three(hR), 13 * s, 0]);
      add(["curve", pts([[2, -47], [3, -52 * ht + 5], [4 + bend * 4, -56 * ht + 6]]), hR[0]]); // crown fold
      if (hat.type === "witch")
        add(["form", pts([[-bw, -41 - tilt * 2], [-bw * 0.6, -45], [0, -46], [bw * 0.6, -44], [bw, -40 + tilt * 2], [bw + 2, -42 + tilt * 2, 1], [bw * 0.7, -38 + tilt * 2], [0, -38.5], [-bw * 0.7, -39 - tilt]]), mostlyBase(hR)]);
      else add(["form", pts([[-9, -42], [0, -45], [9, -42], [0, -40]]), mostlyBase(hR)]);
      if (bR) add(["line", ...P(-5, -46), ...P(5, -46), bR[1]], ["line", ...P(-5, -47), ...P(5, -47), bR[2]]);
    } else if (hat.type === "top") {
      add(["form", pts([[-6, -58 * ht + 2, 1], [6, -58 * ht + 2, 1], [6, -45, 1], [-6, -45, 1]]), three(hR)]);
      add(["form", pts([[-10, -45], [0, -46], [10, -45], [10, -43, 1], [-10, -43, 1]]), three(hR)]);
      if (bR) add(["line", ...P(-6, -47), ...P(6, -47), bR[1]]);
    } else if (hat.type === "hood") {
      add(["form", pts([[-11, -26, 1], [-11, -38], [-7, -47], [-1, -52, 1], [7, -46], [11, -38], [11, -26, 1], [6, -28], [-6, -28]]), mostlyBase(hR)]);
      add(["form", pts([[-6, -38], [0, -43], [6, -38], [5, -31], [0, -29], [-5, -31]]), ["#08060c", "#0e0a14"]]);
    } else if (hat.type === "beret") {
      add(["lobe", ...P(-1, -44), 10 * s, 4 * s, three(hR), { bumps: 6, bumpiness: 0.05 }]);
    } else if (hat.type === "crown") {
      add(["form", pts([[-7, -42, 1], [-7, -49, 1], [-4, -45], [0, -51, 1], [4, -45], [7, -49, 1], [7, -42, 1]]), three(bR ?? RAMPS.gold)]);
    }
  }

  // --- details (after outline): eyes, mouth, goggles --------------------------------------------
  const pixels: unknown[] = [];
  const dshapes: Shape[] = [];
  const hooded = hat?.type === "hood";
  const eyeC = spec.glowEyes || hooded ? { pupil: spec.eyes ?? "#ff4a3a", glint: "#ffd0a0" } : { pupil: spec.eyes ?? "#2a1a3a", glint: "#ffffff" };
  for (const a of [-1, 1]) dshapes.push(["eye", ...P(a * 3.5, -34), Math.max(1, 2 * s), Math.min(3, Math.round(3 * s)), eyeC, { nose: a < 0 ? "right" : "left" }]);
  if (!hooded) pixels.push([...P(0, -30).map(Math.round), sk[0]]);
  if (ex.has("goggles"))
    for (const a of [-1, 1]) dshapes.push(["form", pts([[a * 1.5, -44], [a * 5.5, -44], [a * 5.5, -41], [a * 1.5, -41]]), three(ramp("steel", "steel"))]);
  return { shapes: out, details: { shapes: dshapes, pixels } };
}

/** The steps that draw one person on its own layer: body, simplify, outline, then details. */
export function personSteps(step: Record<string, unknown>): Record<string, unknown>[] {
  const { x = 0, y = 0, spec = {}, scale = 1, layer, frame } = step as { x: number; y: number; spec: PersonSpec; scale: number; layer?: string; frame?: number };
  const name = layer ?? `person_${Math.round(x)}_${Math.round(y)}`;
  const { shapes, details } = person(x, y, spec, scale);
  const f = frame !== undefined ? { frame } : {};
  return [
    { op: "layer", action: "add", name },
    { op: "draw", layer: name, ...f, shapes },
    { op: "edit", action: "simplify", layer: name, ...f },
    { op: "edit", action: "outline", layer: name, ...f, color: INK },
    { op: "draw", layer: name, ...f, shapes: details.shapes, pixels: details.pixels },
  ];
}
