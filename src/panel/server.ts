// The read-only panel: a GET-only HTTP server on 127.0.0.1 that serves three static assets and the chain.
//
// It never writes: there is no route that takes input, every non-GET is 405, and the store is read with readChain,
// which opens no lease. The Host check (421) stops a DNS-rebinding page from reading the log through the browser.
import { lstatSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import { readChain } from "../store/index.ts";
import { APP_CSS, APP_JS, INDEX_HTML } from "./assets.ts";
import { buildView } from "./view.ts";

export const PANEL_HOST = "127.0.0.1";

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

const STATIC: Readonly<Record<string, readonly [type: string, body: string]>> = {
  "/": ["text/html; charset=utf-8", INDEX_HTML],
  "/app.js": ["text/javascript; charset=utf-8", APP_JS],
  "/app.css": ["text/css; charset=utf-8", APP_CSS],
};
const ROUTES = new Set([...Object.keys(STATIC), "/entries.json"]);

export interface PanelOptions {
  /** 0 picks a free port. */
  port: number;
  /** Must be 127.0.0.1; any other value is refused. Defaults to 127.0.0.1. */
  host?: string;
  /** The command that runs this gateway (config's INTENT), so the page's hints paste as is. Defaults to `intent`. */
  intent?: string;
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

  let allowedHosts: ReadonlySet<string> = new Set();
  const server = createServer((req, res) => {
    handle(req, res, dataDir, allowedHosts, intent);
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

function handle(req: IncomingMessage, res: ServerResponse, dataDir: string, allowedHosts: ReadonlySet<string>, intent: string): void {
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
    items = readChain(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      send(res, 500, "text/plain; charset=utf-8", "could not read the log\n");
      return;
    }
    items = [];
  }
  const view = buildView(items);
  send(res, 200, "application/json; charset=utf-8", JSON.stringify({ chain: view.chain, entries: items, view, intent }));
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
