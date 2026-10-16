// The read-only panel: a GET-only HTTP server on 127.0.0.1 that serves the page (rendered from the chain on each
// request), its stylesheet and script, and the chain as JSON.
//
// It never writes: there is no route that takes input, every non-GET is 405, and the store is read with readChain,
// which opens no lease. The Host check (421) stops a DNS-rebinding page from reading the log through the browser.
import { lstatSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import { readChain } from "../store/index.ts";
import { APP_CSS, APP_JS } from "./assets.ts";
import { buildModel, type Mode, type PolicyInfo, type VerifyResult } from "./model.ts";
import { renderPage } from "./render.ts";
import { buildView } from "./view.ts";

export const PANEL_HOST = "127.0.0.1";

/** No inline script or style, no image (the logo and icons are inline SVG), no form, no frame, nothing from elsewhere. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
} as const;

const STATIC: Readonly<Record<string, readonly [type: string, body: string]>> = {
  "/app.js": ["text/javascript; charset=utf-8", APP_JS],
  "/app.css": ["text/css; charset=utf-8", APP_CSS],
};
const ROUTES = new Set([...Object.keys(STATIC), "/", "/entries.json"]);

export interface PanelOptions {
  /** 0 picks a free port. */
  port: number;
  /** Must be 127.0.0.1; any other value is refused. Defaults to 127.0.0.1. */
  host?: string;
  /** The command that runs this gateway (config's INTENT), so the page's hints paste as is. Defaults to `intent`. */
  intent?: string;
  /** Which chain this is: `panel --demo` reads the demo chain (DEMO pill), otherwise REAL. Defaults to what the chain says. */
  mode?: Mode;
  /** Reads the active policy for the Policy view and the daily limit; absent, those say no policy was given. */
  policy?: () => Promise<PolicyInfo>;
  /**
   * Runs `intent verify`'s chain checks (read-only, offline) for the Verify view. The panel runs it again only when
   * the chain's head changes.
   */
  verify?: () => Promise<VerifyResult>;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

export interface Panel {
  url: string;
  close(): Promise<void>;
}

export class PanelError extends Error {
  override name = "PanelError";
}

/** Starts the panel over the data directory (or a Config's dataDir). Refuses a non-loopback host or a readable data dir. */
export async function startPanel(source: string | Pick<Config, "dataDir">, opts: PanelOptions): Promise<Panel> {
  const dataDir = typeof source === "string" ? source : source.dataDir;
  const host = opts.host ?? PANEL_HOST;
  if (host !== PANEL_HOST) {
    throw new PanelError(`the panel binds to ${PANEL_HOST} only, refusing host ${JSON.stringify(host)}`);
  }
  assertPrivate(dataDir);
  const intent = opts.intent ?? "intent";
  const context: Context = { dataDir, intent, opts, verified: null };

  let allowedHosts: ReadonlySet<string> = new Set();
  const server = createServer((req, res) => {
    handle(req, res, context, allowedHosts).catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "the panel failed\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, PANEL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = new Set([`${PANEL_HOST}:${String(port)}`, `localhost:${String(port)}`]);
  return {
    url: `http://${PANEL_HOST}:${String(port)}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

/** The data dir must be 0700-or-tighter and every file in it 0600-or-tighter: the log is the developer's own. */
function assertPrivate(dataDir: string): void {
  if (process.platform === "win32") return;
  const stat = lstatSync(dataDir, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new PanelError(`the data directory ${dataDir} does not exist; start the gateway once to create it`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new PanelError(
      `refusing to serve: the data directory ${dataDir} is readable by other users (mode ${mode(stat.mode)}); ` +
        `run chmod 700 ${dataDir}`,
    );
  }
  for (const name of readdirSync(dataDir)) {
    const file = join(dataDir, name);
    const fileStat = lstatSync(file);
    if ((fileStat.mode & 0o077) !== 0) {
      throw new PanelError(
        `refusing to serve: ${file} is readable by other users (mode ${mode(fileStat.mode)}); run chmod 600 ${file}`,
      );
    }
  }
}

function mode(value: number): string {
  return (value & 0o777).toString(8).padStart(4, "0");
}

interface Context {
  readonly dataDir: string;
  readonly intent: string;
  readonly opts: PanelOptions;
  /** The last verify result and the chain head it was run for. */
  verified: { key: string; result: Promise<VerifyResult> } | null;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context, allowedHosts: ReadonlySet<string>): Promise<void> {
  if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
    send(res, 421, "text/plain; charset=utf-8", "misdirected request: use the panel's own address\n");
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    send(res, 405, "text/plain; charset=utf-8", "the panel is read-only\n");
    return;
  }
  const path = (req.url ?? "/").split("?", 1)[0] ?? "/";
  if (!ROUTES.has(path)) {
    send(res, 404, "text/plain; charset=utf-8", "not found\n");
    return;
  }
  const asset = STATIC[path];
  if (asset !== undefined) {
    send(res, 200, asset[0], asset[1]);
    return;
  }
  let items: unknown[];
  try {
    items = readChain(ctx.dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      send(res, 500, "text/plain; charset=utf-8", "could not read the log\n");
      return;
    }
    items = [];
  }
  if (path === "/entries.json") {
    const view = buildView(items);
    send(res, 200, "application/json; charset=utf-8", JSON.stringify({ chain: view.chain, entries: items, view, intent: ctx.intent }));
    return;
  }
  send(res, 200, "text/html; charset=utf-8", renderPage(await model(ctx, items)));
}

async function model(ctx: Context, items: readonly unknown[]): Promise<ReturnType<typeof buildModel>> {
  const { opts } = ctx;
  let policy: PolicyInfo | null = null;
  let policyError: string | undefined;
  if (opts.policy === undefined) policyError = "no policy was given to the panel";
  else {
    try {
      policy = await opts.policy();
    } catch (error) {
      policyError = `the active policy could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let verify: VerifyResult | null = null;
  if (opts.verify !== undefined) {
    const last = items.at(-1) as { hash?: unknown } | undefined;
    const key = `${String(items.length)}:${typeof last?.hash === "string" ? last.hash : ""}`;
    if (ctx.verified?.key !== key) ctx.verified = { key, result: opts.verify() };
    try {
      verify = await ctx.verified.result;
    } catch {
      ctx.verified = null;
    }
  }
  const first = items[0] as { kind?: unknown; body?: { mode?: unknown } } | undefined;
  const mode: Mode = opts.mode ?? (first?.kind === "session" && first.body?.mode === "demo" ? "demo" : "real");
  return buildModel({ items, now: (opts.now ?? Date.now)(), mode, intent: ctx.intent, policy, ...(policyError === undefined ? {} : { policyError }), verify });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
