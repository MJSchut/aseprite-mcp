import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPS_LUA = join(dirname(fileURLToPath(import.meta.url)), "..", "lua", "ops.lua");
const MARKER = "__MCP_RESULT__";
const TIMEOUT_MS = Number(process.env.ASEPRITE_TIMEOUT_MS ?? 60_000);
const USE_WORKER = process.env.ASEPRITE_MCP_WORKER !== "0";

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

/** Expand ~ and resolve relative paths against `base`, ASEPRITE_MCP_DIR or the cwd. */
export function resolvePath(p: string, base?: string): string {
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
  if (isAbsolute(p)) return p;
  return resolve(base ?? process.env.ASEPRITE_MCP_DIR ?? process.cwd(), p);
}

export function exec(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(asepriteBinary(), args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout.includes(MARKER)) {
        fail(new AsepriteError(`aseprite failed: ${(stderr || stdout || err.message).trim().slice(0, 2000)}`));
      } else ok(stdout);
    });
  });
}

type Response = { id?: number; ok: boolean; results?: unknown[]; error?: string };

function parseResponse(line: string): Response {
  return JSON.parse(line.slice(MARKER.length));
}

/**
 * A long-lived `aseprite -b` process that reads one JSON request per stdin line.
 * Saves the ~70ms process start per call. Requests are serialized; on crash or
 * timeout the process is killed and a fresh one is started on the next call.
 */
class Worker {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending?: { id: number; ok: (r: Response) => void; fail: (e: Error) => void; timer: NodeJS.Timeout };
  private queue: Promise<unknown> = Promise.resolve();

  private start() {
    const proc = spawn(asepriteBinary(), ["-b", "--script-param", "worker=1", "--script", OPS_LUA]);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.startsWith(MARKER) && this.pending) {
          const p = this.pending;
          this.pending = undefined;
          clearTimeout(p.timer);
          try {
            p.ok(parseResponse(line));
          } catch (e) {
            p.fail(e as Error);
          }
        }
      }
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = undefined;
      if (this.pending) {
        const p = this.pending;
        this.pending = undefined;
        clearTimeout(p.timer);
        p.fail(new AsepriteError(`aseprite exited unexpectedly ${stderr.trim()}`));
      }
    });
    proc.stdin.on("error", () => {});
    this.proc = proc;
    this.buf = "";
  }

  request(req: object): Promise<Response> {
    const run = () =>
      new Promise<Response>((ok, fail) => {
        if (!this.proc) this.start();
        const id = this.nextId++;
        const timer = setTimeout(() => {
          this.pending = undefined;
          this.proc?.kill();
          this.proc = undefined;
          fail(new AsepriteError(`aseprite timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);
        this.pending = { id, ok, fail, timer };
        this.proc!.stdin.write(JSON.stringify({ ...req, id }) + "\n");
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  stop() {
    this.proc?.stdin.end();
    this.proc = undefined;
  }
}

const worker = USE_WORKER ? new Worker() : undefined;
export const stopWorker = () => worker?.stop();

async function oneShot(req: object): Promise<Response> {
  const dir = await mkdtemp(join(tmpdir(), "aseprite-mcp-"));
  try {
    const paramsFile = join(dir, "params.json");
    await writeFile(paramsFile, JSON.stringify(req));
    const stdout = await exec(["-b", "--script-param", `params=${paramsFile}`, "--script", OPS_LUA]);
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
    if (!line) throw new AsepriteError(`no result from aseprite: ${stdout.trim().slice(0, 2000)}`);
    return parseResponse(line);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Step = { op: string; [k: string]: unknown };

/** Run steps against one sprite (one open, one save). Returns one result per step. */
export async function runSteps(path: string | undefined, steps: Step[]): Promise<unknown[]> {
  const req = { path, steps, allowImageWrites: process.env.ASEPRITE_MCP_ALLOW_IMAGE_WRITES === "1" };
  const res = worker ? await worker.request(req) : await oneShot(req);
  if (!res.ok) throw new AsepriteError(res.error);
  return res.results ?? [];
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
