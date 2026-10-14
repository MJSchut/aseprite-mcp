/** Well-known pixel art palettes. */
export const PALETTES: Record<string, string[]> = {
  pico8: [
    "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
    "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
  ],
  db16: [
    "#140c1c", "#442434", "#30346d", "#4e4a4e", "#854c30", "#346524", "#d04648", "#757161",
    "#597dce", "#d27d2c", "#8595a1", "#6daa2c", "#d2aa99", "#6dc2ca", "#dad45e", "#deeed6",
  ],
  sweetie16: [
    "#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179",
    "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57",
  ],
  gameboy: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
};

export function resolvePalette(p: unknown): string[] | undefined {
  if (p === undefined) return undefined;
  if (Array.isArray(p)) return p as string[];
  const preset = PALETTES[String(p).toLowerCase()];
  if (!preset) throw new Error(`unknown palette preset '${p}' (available: ${Object.keys(PALETTES).join(", ")})`);
  return preset;
}
