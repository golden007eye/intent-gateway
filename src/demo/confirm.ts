// The demo confirm page: http://127.0.0.1:<port>/confirm/c/<link>. It shows the purchase snapshot and two buttons;
// a click POSTs back here and the page signs with the demo passkey on the server. It is a local stand-in for the
// passkey step: any program that can reach 127.0.0.1 can press its buttons. Real approvals need the buyer's passkey
// on Intent Cloud's confirm page.
//
// Approve also needs the demo code: six digits the gateway prints on its own stderr (and keeps in a 0600 file), never
// in a tool result, so an agent that reads only tool results cannot approve. After MAX_WRONG_CODES wrong codes the
// page refuses every approval until the demo restarts with a new code. Reject needs no code.
//
// Loopback only, no external assets, a strict CSP and no script. A GET never changes anything. A POST needs the
// one-time token of the page it came from (CSRF), and a foreign Host (421), Origin or Sec-Fetch-Site (403) is refused.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeCloud, Outcome, SoftPasskey } from "../cloud-fake/index.ts";
import type { Money } from "../contract/index.ts";
import { DEMO_BANNER } from "./banner.ts";

export const CONFIRM_HOST = "127.0.0.1";
export const CONFIRM_PATH = "/confirm";
export const CONFIRM_CSP =
  "default-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const HEADERS = {
  "content-security-policy": CONFIRM_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

const PAGE = /^\/confirm\/c\/([A-Za-z0-9_-]{1,64})$/;
const STYLE_PATH = "/confirm/style.css";
const MAX_FORM_BYTES = 4096;
const TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKENS = 1000;
/** Wrong demo codes before the page refuses every approval until the demo restarts. */
export const MAX_WRONG_CODES = 5;

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
.demo{background:#fde68a;border:2px solid #b45309;padding:.5rem .75rem;font-weight:700}
.hint{color:#555}input{font:inherit;padding:.3rem .5rem;letter-spacing:.2em}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#555}dd{margin:0}
button{font:inherit;padding:.6rem 1rem;margin:.5rem .5rem 0 0;border-radius:.4rem;border:1px solid #333;cursor:pointer}
button[value=approve]{background:#166534;color:#fff}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}dt,.hint{color:#aaa}.demo{color:#111}}
`;

export interface ConfirmPageOptions {
  fake: FakeCloud;
  passkey: SoftPasskey;
  /** 0 picks a free port. */
  port: number;
  /**
   * The address to listen on; defaults to CONFIRM_HOST. Only the Docker image passes 0.0.0.0, so that the host's
   * `-p 127.0.0.1:<port>:<port>` mapping reaches the page. The page still answers only to `Host: 127.0.0.1:<port>`
   * and its links still say 127.0.0.1, so the port must be mapped to the same number on the host.
   */
  bind?: string;
  /** Milliseconds since the epoch, for token expiry. Defaults to Date.now. */
  now?: () => number;
  /** The six-digit demo code Approve needs. */
  code: string;
  /** Where a person finds the code when no terminal shows it, e.g. `cat <file>`; shown on the page. */
  codeHint: string;
}

export interface ConfirmPage {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  close(): Promise<void>;
}

export async function startConfirmPage(options: ConfirmPageOptions): Promise<ConfirmPage> {
  const { fake, passkey } = options;
  const now = options.now ?? Date.now;
  /** One-time form tokens: token → the link of the page that holds it. */
  const tokens = new Map<string, { link: string; expiresAt: number }>();
  const code = Buffer.from(options.code);
  if (!/^[0-9]{6}$/.test(options.code)) throw new Error("the demo code must be six digits");
  let wrongCodes = 0;
  let origin = "";

  function issue(link: string): string {
    const at = now();
    for (const [t, v] of tokens) if (v.expiresAt <= at) tokens.delete(t);
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value as string);
    const token = randomBytes(32).toString("base64url");
    tokens.set(token, { link, expiresAt: at + TOKEN_TTL_MS });
    return token;
  }

  function page(link: string, handle: string): string {
    const view = fake.inspect(handle);
    if (view === undefined) return notFound();
    const s = view.snapshot;
    const rows: [string, string][] = [
      ["Item", `${s.item.title} (${s.item.variant})`],
      ["Merchant", `${s.merchant.name} (${s.merchant.domain})`],
      ["Quantity", String(s.quantity)],
      ["Total", `${s.total_kind === "max" ? "at most " : ""}${money(s.total)} (shipping ${money(s.shipping)})`],
      ["Ship to", `US, ZIP ${s.ship_to.postal_prefix}xx`],
      ["Check code", view.snapshot_hash.slice(0, 8)],
      ["State", view.state],
    ];
    const list = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    const form =
      view.state === "pending"
        ? `<form method="post" action="${esc(`${CONFIRM_PATH}/c/${link}`)}"><input type="hidden" name="csrf" value="${issue(link)}">` +
          `<p><label for="code">Demo code</label> <input id="code" name="code" inputmode="numeric" autocomplete="off" ` +
          `pattern="[0-9]{6}" maxlength="6" size="8"></p>` +
          `<p class="hint">Enter the 6-digit code shown in the gateway's terminal. If your agent started the gateway, ` +
          `read it with: <code>${esc(options.codeHint)}</code></p>` +
          `<button type="submit" name="action" value="approve">Approve with demo passkey</button>` +
          `<button type="submit" name="action" value="reject">Reject</button></form>`
        : `<p>This approval is ${esc(view.state)}. Ask your agent to check the approval status.</p>`;
    return layout("Approve this purchase?", `<dl>${list}</dl>${form}`);
  }

  function decided(outcome: Outcome, action: "approve" | "reject"): string {
    if (outcome.status === 200) {
      // The heading names the outcome once; the paragraph says how and what to do next, without repeating it.
      const [title, how] = action === "approve" ? ["Approved", "Approved with the demo passkey."] : ["Rejected", "You rejected this purchase."];
      return layout(title, `<p>${how} Go back to your agent and ask it to check the approval status.</p>`);
    }
    return layout("Not done", `<p>${esc(outcome.reason ?? `state ${outcome.state ?? "unknown"}`)}</p>`);
  }

  /** The status and HTML page for one request (the stylesheet is served before this). */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<[number, string]> {
    const link = PAGE.exec(path)?.[1];
    const approval = link === undefined ? undefined : fake.approvalForLink(`/c/${link}`);
    if (link === undefined || approval === undefined) return [404, notFound()];
    if (req.method === "GET") return [200, page(link, approval)];
    if (req.method !== "POST") {
      res.setHeader("allow", "GET, POST");
      return [405, layout("Method not allowed", "<p>Use the buttons on the page.</p>")];
    }

    const site = req.headers["sec-fetch-site"];
    const from = req.headers.origin;
    if ((from !== undefined && from !== origin) || (site !== undefined && site !== "same-origin" && site !== "none")) {
      return [403, layout("Refused", "<p>The request did not come from this page.</p>")];
    }
    const form = await readForm(req);
    const token = form?.get("csrf") ?? "";
    const held = tokens.get(token);
    if (form === null || held?.link !== link || held.expiresAt <= now()) {
      return [403, layout("Refused", "<p>The page has expired or the form token is wrong. Reload the page and try again.</p>")];
    }
    tokens.delete(token);
    const action = form.get("action");
    if (action !== "approve" && action !== "reject") return [400, layout("Bad request", "<p>Unknown action.</p>")];
    if (action === "approve") {
      if (wrongCodes >= MAX_WRONG_CODES) {
        return [403, layout("Locked", "<p>Too many wrong demo codes. Restart the demo to get a new code; until then nothing can be approved here.</p>")];
      }
      const given = Buffer.from(form.get("code")?.trim() ?? "");
      if (given.length !== code.length || !timingSafeEqual(given, code)) {
        wrongCodes += 1;
        const left = MAX_WRONG_CODES - wrongCodes;
        return [403, layout("Wrong demo code", `<p>That is not the demo code. Go back, reload the page and enter the code shown in the gateway's terminal (${String(left)} tries left).</p>`)];
      }
    }
    const outcome = action === "approve" ? fake.approveWithPasskey(approval, passkey) : fake.reject(approval, passkey);
    return [outcome.status, decided(outcome, action)];
  }

  const server = createServer((req, res) => {
    // A foreign Host is a DNS-rebinding page trying to reach this one through the browser.
    if (req.headers.host !== origin.slice("http://".length)) {
      send(res, 421, layout("Misdirected request", "<p>Unknown Host.</p>"));
      return;
    }
    const path = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
    if (path === STYLE_PATH && req.method === "GET") {
      res.writeHead(200, { ...HEADERS, "content-type": "text/css; charset=utf-8" });
      res.end(STYLE);
      return;
    }
    handle(req, res, path).then(
      ([status, html]) => {
        send(res, status, html);
      },
      () => {
        send(res, 500, layout("Error", "<p>The demo confirm page failed.</p>"));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bind ?? CONFIRM_HOST, () => {
      resolve();
    });
  });
  origin = `http://${CONFIRM_HOST}:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The urlencoded form body, or null when it is not one or is over the cap. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const type = req.headers["content-type"] ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...HEADERS, "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(html)) });
  res.end(html);
}

function layout(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="stylesheet" href="${STYLE_PATH}"></head><body>` +
    `<p class="demo">${esc(DEMO_BANNER)}</p><h1>${esc(title)}</h1>${body}</body></html>`
  );
}

function notFound(): string {
  return layout("Unknown approval link", "<p>This demo approval link is unknown. Demo approvals last only while the demo runs.</p>");
}

function money(value: Money): string {
  return `$${String(Math.floor(value.amount_minor / 100))}.${String(value.amount_minor % 100).padStart(2, "0")}`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}
