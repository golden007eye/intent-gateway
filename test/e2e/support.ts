// Shared by the E2E tests (E2, AC-T3): a private build of the package, the built gateway as an MCP stdio server
// (`node dist/main.js serve`) driven by an MCP SDK client, `node dist/main.js verify`, and a man-in-the-middle proxy
// between the gateway and the fake Intent Cloud.
//
// Each test file builds its own copy of the package into a temporary folder, so it never races `pnpm build` in
// test/build.test.ts, which rewrites ./dist. The copy has the same layout as the npm package (dist/, policies/,
// contract/, package.json) and no build-info.json: the build is then not an installed release, so `intent verify`
// reports its npm self-check as not run instead of asking the npm registry for a version that was never published.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FakeCloud } from "../../src/cloud-fake/index.ts";
import { type Entry, readChain } from "../../src/store/index.ts";

const repo = join(import.meta.dirname, "../..");

/** Compiles src/ with tsconfig.build.json into a fresh package folder and returns the path of its dist/main.js. */
export function buildPackage(): string {
  const pkg = mkdtempSync(join(tmpdir(), "e2e-pkg-"));
  const tsc = spawnSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(pkg, "dist")], {
    cwd: repo,
    encoding: "utf8",
  });
  if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.stdout}${tsc.stderr}`);
  cpSync(join(repo, "package.json"), join(pkg, "package.json"));
  for (const dir of ["policies", "contract", "node_modules"]) symlinkSync(join(repo, dir), join(pkg, dir), "dir");
  return join(pkg, "dist/main.js");
}

/** A fresh, empty temporary folder. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A `--trust-keys` file that pins the fake's root key. */
export function trustKeysFile(fake: FakeCloud): string {
  const file = join(tempDir("e2e-keys-"), "keys.json");
  writeFileSync(file, JSON.stringify({ rootKeys: [fake.keys.rootPin] }));
  return file;
}

/** The process environment without any INTENT_* the developer's shell may carry, plus `extra`. */
export function env(extra: Record<string, string>): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("INTENT_")));
  return { ...base, ...extra };
}

export interface Gateway {
  /** Calls a tool and returns its text (the gateway's message, details, then the Sent/Blocked line). */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  stderr(): string;
  close(): Promise<void>;
}

/** `node <main> serve --trust-keys <keys>` over stdio against `cloudUrl`, with its chain in `dataDir`. */
export async function startGateway(main: string, options: { cloudUrl: string; keys: string; dataDir: string }): Promise<Gateway> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [main, "serve", "--trust-keys", options.keys],
    env: env({ INTENT_CLOUD_URL: options.cloudUrl, INTENT_DATA_DIR: options.dataDir }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const client = new Client({ name: "e2e", version: "0" });
  let closing: Promise<void> | undefined;
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`the gateway did not start: ${(error as Error).message}\n${stderr}`, { cause: error });
  }
  return {
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    },
    stderr: () => stderr,
    // Idempotent, so a test can close early and its afterEach can still close whatever is left open.
    close: () => (closing ??= client.close()),
  };
}

/** The value after `label: ` in a tool result, e.g. `offer_handle` or `approval_handle`. */
export function field(text: string, label: string): string {
  const value = new RegExp(`${label}: (\\S+)`).exec(text)?.[1];
  if (value === undefined) throw new Error(`no ${label} in:\n${text}`);
  return value;
}

/** The offer_handle of the offer whose line names `title`. */
export function offerHandle(text: string, title: string): string {
  const offerLine = text.split("\n").find((l) => l.startsWith(`- ${title} `));
  if (offerLine === undefined) throw new Error(`no offer ${title} in:\n${text}`);
  return field(offerLine, "offer_handle");
}

/** `node <main> verify --trust-keys <keys>` on `dataDir`: its exit code and report. */
export function verify(main: string, dataDir: string, keys: string): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, [main, "verify", "--trust-keys", keys], { env: env({ INTENT_DATA_DIR: dataDir }), encoding: "utf8" });
  return { code: run.status, out: run.stdout + run.stderr };
}

/** The local hash chain's entries. */
export function chain(dataDir: string): Entry[] {
  return readChain(dataDir) as Entry[];
}

export const count = (entries: readonly Entry[], kind: string): number => entries.filter((e) => e.kind === kind).length;

export interface Proxy {
  url: string;
  /** From now on, answer `GET /v1/approvals/<handle>` with the body Intent Cloud gave for `from`, keeping the
   * real response's status, receipt and version headers. */
  replay(handle: string, from: string): void;
  close(): Promise<void>;
}

/**
 * A network attacker between the gateway and the fake Intent Cloud. It forwards every request unchanged and records
 * each approval-status body; once armed with `replay`, it swaps one approval's body for another's. A receipt
 * covers the request and the status, not the response body, so the swap reaches the gateway's own proof checks.
 */
export async function startProxy(target: string): Promise<Proxy> {
  const seen = new Map<string, Buffer>();
  const swaps = new Map<string, string>();
  const upstream = new URL(target);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      const headers: IncomingHttpHeaders = { ...req.headers, host: upstream.host };
      const out = request({ host: upstream.hostname, port: upstream.port, path, method: req.method, headers }, (up) => {
        const body: Buffer[] = [];
        up.on("data", (c: Buffer) => body.push(c));
        up.on("end", () => {
          let bytes: Buffer = Buffer.concat(body);
          const approval = /^\/v1\/approvals\/([^/?]+)$/.exec(path)?.[1];
          if (approval !== undefined && req.method === "GET") {
            seen.set(approval, bytes);
            const from = swaps.get(approval);
            const swapped = from === undefined ? undefined : seen.get(from);
            if (swapped !== undefined) bytes = swapped;
          }
          res.writeHead(up.statusCode ?? 502, { ...up.headers, "content-length": String(bytes.length) });
          res.end(bytes);
        });
      });
      out.on("error", () => res.destroy());
      out.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    replay(handle, from) {
      if (!seen.has(from)) throw new Error(`the proxy has not seen approval ${from}`);
      swaps.set(handle, from);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
