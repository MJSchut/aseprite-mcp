import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

// Minimal Replicate HTTP client: schema lookup, predictions (wait + poll), output download.
// Auth: REPLICATE_API_TOKEN. REPLICATE_API_BASE overrides the endpoint (tests).

const base = () => process.env.REPLICATE_API_BASE ?? "https://api.replicate.com/v1";
const POLL_MS = 2000;

function token(): string {
  const t = process.env.REPLICATE_API_TOKEN;
  if (!t) {
    throw new Error(
      "REPLICATE_API_TOKEN is not set. Create a token at https://replicate.com/account/api-tokens and add it to the " +
        "aseprite MCP server's env (then restart the session).",
    );
  }
  return t;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : base() + path;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Replicate ${res.status} ${path}: ${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

type SchemaProp = {
  type?: string;
  format?: string;
  enum?: unknown[];
  allOf?: { $ref?: string }[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
};
type Schema = {
  version: string;
  input: Record<string, SchemaProp>;
  required: string[];
  enums: Record<string, unknown[]>;
};

const schemaCache = new Map<string, Schema>();

/** Input schema of a model ("owner/name" or "owner/name:version"). */
export async function modelSchema(model: string): Promise<Schema> {
  const cached = schemaCache.get(model);
  if (cached) return cached;
  const [name, version] = model.split(":");
  type Version = { id: string; openapi_schema: { components: { schemas: Record<string, Record<string, unknown>> } } };
  const v = version
    ? await api<Version>(`/models/${name}/versions/${version}`)
    : (await api<{ latest_version: Version }>(`/models/${name}`)).latest_version;
  const schemas = v.openapi_schema.components.schemas;
  const input = schemas.Input as { properties: Record<string, SchemaProp>; required?: string[] };
  // enums are often separate schemas referenced through allOf
  const enums: Record<string, unknown[]> = {};
  for (const [k, p] of Object.entries(input.properties)) {
    const ref = p.allOf?.[0]?.$ref?.split("/").pop();
    const e = p.enum ?? (ref ? (schemas[ref] as { enum?: unknown[] })?.enum : undefined);
    if (e) enums[k] = e;
  }
  const schema = { version: v.id, input: input.properties, required: input.required ?? [], enums };
  schemaCache.set(model, schema);
  return schema;
}

/** Compact one-line-per-field description for the model to read. */
export function describeSchema(s: Schema): string {
  return Object.entries(s.input)
    .map(([k, p]) => {
      const type = s.enums[k] ? s.enums[k].map((e) => JSON.stringify(e)).join("|") : (p.format === "uri" ? "file" : p.type ?? "?");
      const range = p.minimum !== undefined || p.maximum !== undefined ? ` [${p.minimum ?? ""}..${p.maximum ?? ""}]` : "";
      const def = p.default !== undefined ? ` =${JSON.stringify(p.default)}` : "";
      const req = s.required.includes(k) ? " (required)" : "";
      const desc = p.description ? ` — ${p.description.replace(/\s+/g, " ").slice(0, 90)}` : "";
      return `${k}: ${type}${range}${def}${req}${desc}`;
    })
    .join("\n");
}

/** First file-typed input: where a reference image goes. */
export function imageField(s: Schema): string | undefined {
  const files = Object.entries(s.input).filter(([, p]) => p.format === "uri").map(([k]) => k);
  return files.find((k) => /image|frame|start|input/i.test(k)) ?? files[0];
}

type Prediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string;
  logs?: string;
  metrics?: { predict_time?: number };
  urls: { get: string };
};

/** Run a prediction to completion. Official models by name; others via their latest version. */
export async function predict(
  model: string,
  input: Record<string, unknown>,
  timeoutMs = Number(process.env.REPLICATE_TIMEOUT_MS ?? 600_000),
): Promise<Prediction> {
  const [name, version] = model.split(":");
  const create = (path: string, body: object) =>
    api<Prediction>(path, { method: "POST", headers: { Prefer: "wait=60" }, body: JSON.stringify(body) });
  let p: Prediction;
  if (version) p = await create("/predictions", { version, input });
  else {
    try {
      p = await create(`/models/${name}/predictions`, { input });
    } catch (e) {
      // community models need an explicit version
      if (!/404|version/i.test(String(e))) throw e;
      p = await create("/predictions", { version: (await modelSchema(name)).version, input });
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (p.status === "starting" || p.status === "processing") {
    if (Date.now() > deadline) throw new Error(`Replicate prediction ${p.id} timed out`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    p = await api<Prediction>(p.urls.get);
  }
  if (p.status !== "succeeded") {
    throw new Error(`Replicate prediction ${p.id} ${p.status}: ${p.error ?? ""} ${(p.logs ?? "").slice(-400)}`);
  }
  return p;
}

function outputUrls(out: unknown): string[] {
  if (typeof out === "string") return /^(https?:|data:)/.test(out) ? [out] : [];
  if (Array.isArray(out)) return out.flatMap(outputUrls);
  if (out && typeof out === "object") return Object.values(out).flatMap(outputUrls);
  return [];
}

/** Download every file URL in a prediction's output. Returns local paths in output order. */
export async function downloadOutputs(out: unknown, dir: string, prefix: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  let i = 0;
  for (const url of outputUrls(out)) {
    i++;
    let data: Buffer;
    let ext: string;
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
      data = Buffer.from(m?.[3] ?? "", m?.[2] ? "base64" : "utf8");
      ext = "." + (m?.[1].split("/")[1] ?? "bin");
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
      data = Buffer.from(await res.arrayBuffer());
      ext = extname(new URL(url).pathname) || "." + (res.headers.get("content-type")?.split("/")[1] ?? "bin");
    }
    const file = join(dir, `${prefix}_${String(i).padStart(2, "0")}${ext.toLowerCase()}`);
    await writeFile(file, data);
    files.push(file);
  }
  return files;
}
