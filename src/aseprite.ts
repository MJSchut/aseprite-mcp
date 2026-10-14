import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPS_LUA = join(dirname(fileURLToPath(import.meta.url)), "..", "lua", "ops.lua");
const MARKER = "__MCP_RESULT__";
const TIMEOUT_MS = Number(process.env.ASEPRITE_TIMEOUT_MS ?? 60_000);

export class AsepriteError extends Error {}

function candidatePaths(): string[] {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Aseprite.app/Contents/MacOS/aseprite",
        join(home, "Applications/Aseprite.app/Contents/MacOS/aseprite"),
        join(home, "Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite"),
      ];
    case "win32": {
      const pf = process.env.ProgramFiles ?? "C:\\Program Files";
      const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return [
        join(pf, "Aseprite", "Aseprite.exe"),
        join(pf86, "Aseprite", "Aseprite.exe"),
        join(pf86, "Steam", "steamapps", "common", "Aseprite", "Aseprite.exe"),
        join(local, "Programs", "Aseprite", "Aseprite.exe"),
      ];
    }
    default:
      return [
        join(home, ".steam/steam/steamapps/common/Aseprite/aseprite"),
        join(home, ".local/share/Steam/steamapps/common/Aseprite/aseprite"),
        "/usr/bin/aseprite",
        "/usr/local/bin/aseprite",
      ];
  }
}

function findOnPath(): string | undefined {
  const exe = process.platform === "win32" ? "aseprite.exe" : "aseprite";
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
}

let cachedBinary: string | undefined;

export function asepriteBinary(): string {
  if (cachedBinary) return cachedBinary;
  const fromEnv = process.env.ASEPRITE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new AsepriteError(`ASEPRITE_PATH does not exist: ${fromEnv}`);
    return (cachedBinary = fromEnv);
  }
  const found = findOnPath() ?? candidatePaths().find((p) => existsSync(p));
  if (!found) throw new AsepriteError("Aseprite not found. Set ASEPRITE_PATH to the aseprite executable.");
  return (cachedBinary = found);
}

/** Expand ~ and resolve relative paths against ASEPRITE_MCP_DIR (or the server's cwd). */
export function resolvePath(p: string): string {
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
  if (isAbsolute(p)) return p;
  return resolve(process.env.ASEPRITE_MCP_DIR ?? process.cwd(), p);
}

function exec(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(asepriteBinary(), args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout.includes(MARKER)) {
        fail(new AsepriteError(`aseprite failed: ${(stderr || stdout || err.message).trim().slice(0, 2000)}`));
      } else ok(stdout);
    });
  });
}

export type Step = { op: string; [k: string]: unknown };

/** Run steps against one sprite in a single Aseprite process. Returns one result per step. */
export async function runSteps(path: string | undefined, steps: Step[]): Promise<unknown[]> {
  const dir = await mkdtemp(join(tmpdir(), "aseprite-mcp-"));
  try {
    const paramsFile = join(dir, "params.json");
    await writeFile(paramsFile, JSON.stringify({ path, steps }));
    const stdout = await exec(["-b", "--script-param", `params=${paramsFile}`, "--script", OPS_LUA]);
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
    if (!line) throw new AsepriteError(`no result from aseprite: ${stdout.trim().slice(0, 2000)}`);
    const res = JSON.parse(line.slice(MARKER.length));
    if (!res.ok) throw new AsepriteError(res.error);
    return res.results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Like runSteps, but appends a preview step and returns the rendered PNG as base64. */
export async function runWithPreview(
  path: string | undefined,
  steps: Step[],
  preview: Record<string, unknown>,
): Promise<{ results: unknown[]; png: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aseprite-mcp-png-"));
  try {
    const output = join(dir, "preview.png");
    const results = await runSteps(path, [...steps, { ...preview, op: "preview", output }]);
    const png = (await readFile(output)).toString("base64");
    return { results: results.slice(0, -1), png };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type ExportOptions = {
  output: string;
  scale?: number;
  frames?: [number, number];
  tag?: string;
  layer?: string;
  splitLayers?: boolean;
  sheet?: { type?: string; columns?: number; data?: string };
};

/** Export via the Aseprite CLI (PNG/GIF/sequence or spritesheet). Frames are 1-based. */
export async function exportSprite(input: string, o: ExportOptions): Promise<string> {
  const args = ["-b"];
  if (o.layer) args.push("--layer", o.layer);
  if (o.tag) args.push("--tag", o.tag);
  if (o.frames) args.push("--frame-range", `${o.frames[0] - 1},${o.frames[1] - 1}`);
  if (o.splitLayers) args.push("--split-layers");
  args.push(input);
  if (o.scale && o.scale !== 1) args.push("--scale", String(o.scale));
  if (o.sheet) {
    args.push("--sheet", o.output, "--sheet-type", o.sheet.type ?? "horizontal");
    if (o.sheet.columns) args.push("--sheet-columns", String(o.sheet.columns));
    if (o.sheet.data) args.push("--data", o.sheet.data, "--format", "json-array");
  } else {
    args.push("--save-as", o.output);
  }
  await exec(args);
  return o.output;
}
