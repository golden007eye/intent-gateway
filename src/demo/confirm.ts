// The demo confirm page: http://127.0.0.1:<port>/confirm/c/<link>. It shows the purchase snapshot as a receipt and
// two buttons; a click POSTs back here and the page signs with the demo passkey on the server. It is a local stand-in
// for the passkey step: any program that can reach 127.0.0.1 can press its buttons. Real approvals need the buyer's
// passkey on Intent Cloud's confirm page.
//
// Approve also needs the demo code: six digits the gateway prints on its own stderr (and keeps in a 0600 file), never
// in a tool result, so an agent that reads only tool results cannot approve. The server keeps only the digits of what
// was typed or pasted (codeDigits: "469 226", "469-226", "Demo code: 469226" all count), so no browser pattern has to.
// A wrong code shows the form again with the error under the field and the tries left; after MAX_WRONG_CODES wrong
// codes the page refuses every approval until the demo restarts with a new code. Reject needs no code.
//
// The code field is one real input (autocomplete=one-time-code). CONFIRM_SCRIPT, the page's only script, allowed by
// its hash in the CSP, lays it over six boxes that only show its digits (aria-hidden), keeps the digits as you type or
// paste, and enables Approve at six. Without the script the input shows as a plain field and the server still checks.
//
// Loopback only, no external assets or requests, a strict CSP. A GET never changes anything. A POST needs the
// one-time token of the page it came from (CSRF), and a foreign Host (421), Origin or Sec-Fetch-Site (403) is refused.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApprovalRecordView, FakeCloud, Outcome, SoftPasskey } from "../cloud-fake/index.ts";
import { ICONS, LOGO_SVG, UI_CSS } from "../ui/index.ts";
import { DEMO_BANNER } from "./banner.ts";

export const CONFIRM_HOST = "127.0.0.1";
export const CONFIRM_PATH = "/confirm";

/**
 * The page's only script: it shows the code field's digits in the six boxes, keeps only digits (at most six) as you
 * type or paste, keeps the caret at the end, and enables Approve at six digits.
 */
export const CONFIRM_SCRIPT =
  `(()=>{const f=document.getElementById("code"),b=document.getElementById("approve");if(!f||!b)return;` +
  `const w=f.closest(".code"),x=w.querySelectorAll(".box"),r=document.getElementById("ready"),t=document.getElementById("step-approve");` +
  `w.classList.add("js");if(r)r.hidden=false;const end=()=>{const n=f.value.length;f.setSelectionRange(n,n)};` +
  `const s=()=>{const d=f.value.normalize("NFKC").replace(/\\D/g,"").slice(0,6);if(f.value!==d){f.value=d;end()}` +
  `x.forEach((e,i)=>{e.textContent=d[i]||"";e.classList.toggle("on",i===Math.min(d.length,5))});` +
  `b.disabled=d.length!==6;if(t)t.classList.toggle("now",d.length===6)};` +
  `f.addEventListener("input",s);f.addEventListener("focus",end);f.addEventListener("click",end);s()})();`;
const SCRIPT_HASH = `'sha256-${createHash("sha256").update(CONFIRM_SCRIPT).digest("base64")}'`;

export const CONFIRM_CSP =
  `default-src 'none'; script-src ${SCRIPT_HASH}; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const HEADERS = {
  "content-security-policy": CONFIRM_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Not no-referrer: under it a browser sends `Origin: null` on the page's own form POST, which the Origin check
  // refuses. The page links nowhere else, so same-origin sends nothing to any other site.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
} as const;

const PAGE = /^\/confirm\/c\/([A-Za-z0-9_-]{1,64})$/;
const STYLE_PATH = "/confirm/style.css";
const MAX_FORM_BYTES = 4096;
const TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKENS = 1000;
/** Wrong demo codes before the page refuses every approval until the demo restarts. */
export const MAX_WRONG_CODES = 5;
const NEXT_STEP = "Go back to your agent and ask it to check the approval status.";

// The receipt's own rules on top of UI_CSS. The code field: without the script, a plain monospace input; with it
// (.code.js), six boxes with the input laid transparently over them, so a click anywhere on the boxes focuses it.
const STYLE =
  UI_CSS +
  `.total{display:flex;flex-direction:column;gap:2px;align-items:center;text-align:center}
.total .k{font-size:13px;color:var(--on-paper-muted);text-transform:uppercase;letter-spacing:.08em}
.total .v{font:600 44px/1.15 var(--mono);letter-spacing:-.02em}
.total .to{font-size:14px;color:var(--on-paper-muted)}
.check span+span{margin-left:.5ch}
.lines .amt{white-space:nowrap;overflow-wrap:normal}
.code{display:flex;flex-direction:column;gap:10px}
.code label{font-size:14px;font-weight:500}
.slots{position:relative}
.code input{display:block;width:100%;max-width:16rem;height:52px;padding:0 14px;border:1.5px solid var(--rule-strong);border-radius:10px;
background:var(--paper);color:var(--on-paper);font:600 24px/1 var(--mono);letter-spacing:.3em}
.code input:focus-visible{outline:3px solid var(--sage);outline-offset:1px;border-color:var(--deep-sage)}
.boxes{display:none;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
.box{height:52px;border:1.5px solid var(--rule);border-radius:10px;display:flex;align-items:center;justify-content:center;
font:600 24px/1 var(--mono);color:var(--on-paper);background:var(--paper)}
.box:not(:empty){border-color:var(--rule-strong)}
.code.js .boxes{display:grid}
.code.js input{position:absolute;inset:0;max-width:none;height:100%;border:0;background:transparent;color:transparent;
caret-color:transparent;font-size:16px;letter-spacing:0;outline:0}
.code.js input::selection{background:transparent}
.code.js .slots:focus-within .box.on{border:2px solid var(--deep-sage);box-shadow:0 0 0 3px var(--sage)}
.code.invalid input,.code.invalid .box{border-color:var(--danger)}
.code .hint{font-size:13px;color:var(--on-paper-muted)}
.code .more summary{cursor:pointer;width:max-content;text-decoration:underline;text-underline-offset:2px}
.code .more summary:focus-visible{outline:2px solid var(--deep-sage);outline-offset:2px}
.code .more p{margin-top:6px}
.error{display:flex;gap:6px;align-items:flex-start;color:var(--danger);font-size:14px;font-weight:600}
.error .icon{flex:none;width:16px;height:16px;margin-top:2px}
.shell-main{display:flex;flex-direction:column;gap:18px}
.actions{display:flex;flex-direction:column;gap:12px}
.result{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.result h1{font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
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

/** The digits of a typed or pasted demo code: full-width digits count as digits, every other character is dropped. */
export function codeDigits(input: string): string {
  return input.normalize("NFKC").replace(/[^0-9]/g, "");
}

/** Why the form is shown again after an Approve: a wrong code (the tries left, how many digits came), or the lockout. */
type Problem = { kind: "wrong"; left: number; digits: number } | { kind: "locked" };

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

  function page(link: string, handle: string, problem?: Problem): string {
    const view = fake.inspect(handle);
    if (view === undefined) return notFound();
    if (view.state !== "pending") return settled(view);
    const s = view.snapshot;
    const locked = problem?.kind === "locked" || wrongCodes >= MAX_WRONG_CODES;
    const wrong = problem?.kind === "wrong" ? problem : undefined;
    const total = money(s.total.amount_minor);
    const check = view.snapshot_hash.slice(0, 8);
    const short = handle.length > 12 ? `${handle.slice(0, 7)}…${handle.slice(-3)}` : handle;
    // A v2 snapshot (contract 1.6.0) binds the 5-digit ZIP; a v1 snapshot its 3-digit prefix.
    const zip = s.v === 2 ? s.ship_to.postal_code : `${s.ship_to.postal_prefix}xx`;

    const receipt =
      `<div class="total"><span class="k">${s.total_kind === "max" ? "Total, at most" : "Total"}</span>` +
      `<span class="v">${total}</span>` +
      `<span class="to">to ${esc(s.merchant.name)} · ships to ZIP ${esc(zip)}</span></div>` +
      `<dl class="lines dash">` +
      `<div class="item"><dt>${String(s.quantity)} × ${esc(s.item.title)} (${esc(s.item.variant)})</dt><dd class="amt">${amount(s.unit_price.amount_minor * s.quantity)}</dd></div>` +
      `<div><dt>${s.total_kind === "max" ? "Shipping, up to" : "Shipping"}</dt><dd class="amt">${amount(s.shipping.amount_minor)}</dd></div>` +
      `<div><dt>Merchant</dt><dd>${esc(s.merchant.domain)}</dd></div>` +
      `<div><dt>Ship to</dt><dd>US, ZIP ${esc(zip)}</dd></div>` +
      `<div><dt>Check code</dt><dd class="strong check" title="Matches the check code your agent showed">` +
      `<span>${esc(check.slice(0, 4))}</span><span>${esc(check.slice(4))}</span></dd></div>` +
      `<div><dt>Approval</dt><dd title="${esc(handle)}">${esc(short)}</dd></div></dl>`;

    const hint =
      `<p class="hint" id="code-hint">Paste works; spaces and dashes are ignored.</p>` +
      `<details class="hint more"><summary>Can't see the code?</summary><p>If your agent started the gateway, ` +
      `read the code with <code class="cmd">${esc(options.codeHint)}</code></p></details>`;
    const field = locked
      ? `<div class="dash"><div class="alert alert-error" role="alert">${ICONS.lock}<p>Too many wrong demo codes. Restart the demo ` +
        `to get a new code; until then nothing can be approved here. You can still reject.</p></div></div>`
      : `<div class="code dash${wrong === undefined ? "" : " invalid"}">` +
        `<label for="code">Enter the 6-digit demo code from the gateway's terminal</label>` +
        `<div class="slots"><div class="boxes" aria-hidden="true">${'<span class="box"></span>'.repeat(6)}</div>` +
        `<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
        `autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" ` +
        `aria-describedby="${wrong === undefined ? "" : "code-error "}code-hint"${wrong === undefined ? "" : ' aria-invalid="true" autofocus'}></div>` +
        (wrong === undefined
          ? ""
          : `<p class="error" id="code-error" role="alert">${ICONS.alert}<span>That is not the demo code` +
            `${wrong.digits === 6 ? "" : ` (it has 6 digits; this had ${String(wrong.digits)})`}. ` +
            `${String(wrong.left)} ${wrong.left === 1 ? "try" : "tries"} left.</span></p>`) +
        `${hint}</div>`;

    const approve = locked
      ? ""
      : `<button class="btn btn-primary" type="submit" id="approve" name="action" value="approve">Approve ${total} with demo passkey</button>`;
    const body =
      `<h1 class="sr-only">Approve this purchase?</h1>` +
      steps(locked ? 1 : 2) +
      `<form class="actions" method="post" action="${esc(`${CONFIRM_PATH}/c/${link}`)}"><input type="hidden" name="csrf" value="${issue(link)}">` +
      `<div class="paper">${receipt}${field}</div>${approve}` +
      `<button class="btn btn-secondary" type="submit" name="action" value="reject">Reject</button>` +
      (locked ? "" : `<p class="note" id="ready" hidden>Approve turns on once all 6 digits are in.</p>`) +
      `</form>`;
    return layout("Approve this purchase?", body, !locked);
  }

  function decided(outcome: Outcome, action: "approve" | "reject"): string {
    if (outcome.status === 200) {
      // The heading names the outcome once; the paragraph says how, and the box what to do next.
      return action === "approve"
        ? result("Approved", "ok", ICONS.check, "Approved with the demo passkey. Nothing is bought in demo mode.")
        : result("Rejected", "no", ICONS.cross, "You rejected this purchase. Nothing was approved.");
    }
    return result("Not done", "err", ICONS.alert, esc(outcome.reason ?? `state ${outcome.state ?? "unknown"}`));
  }

  /** The status and HTML page for one request (the stylesheet is served before this). */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<[number, string]> {
    const link = PAGE.exec(path)?.[1];
    const approval = link === undefined ? undefined : fake.approvalForLink(`/c/${link}`);
    if (link === undefined || approval === undefined) return [404, notFound()];
    if (req.method === "GET") return [200, page(link, approval)];
    if (req.method !== "POST") {
      res.setHeader("allow", "GET, POST");
      return [405, message("Method not allowed", "Use the buttons on the page.")];
    }

    const site = req.headers["sec-fetch-site"];
    const from = req.headers.origin;
    if ((from !== undefined && from !== origin) || (site !== undefined && site !== "same-origin" && site !== "none")) {
      return [403, message("Refused", "The request did not come from this page.")];
    }
    const form = await readForm(req);
    const token = form?.get("csrf") ?? "";
    const held = tokens.get(token);
    if (form === null || held?.link !== link || held.expiresAt <= now()) {
      return [403, message("Refused", "The page has expired or the form token is wrong. Reload the page and try again.")];
    }
    tokens.delete(token);
    const action = form.get("action");
    if (action !== "approve" && action !== "reject") return [400, message("Bad request", "Unknown action.")];
    if (action === "approve") {
      if (wrongCodes >= MAX_WRONG_CODES) return [403, page(link, approval, { kind: "locked" })];
      const digits = codeDigits(form.get("code") ?? "");
      const given = Buffer.from(digits);
      if (given.length !== code.length || !timingSafeEqual(given, code)) {
        wrongCodes += 1;
        const left = MAX_WRONG_CODES - wrongCodes;
        // The form again, with a fresh token, the error under the field and the tries left; at none left, the lockout.
        return [403, page(link, approval, left === 0 ? { kind: "locked" } : { kind: "wrong", left, digits: digits.length })];
      }
    }
    const outcome = action === "approve" ? fake.approveWithPasskey(approval, passkey) : fake.reject(approval, passkey);
    return [outcome.status, decided(outcome, action)];
  }

  const server = createServer((req, res) => {
    // A foreign Host is a DNS-rebinding page trying to reach this one through the browser.
    if (req.headers.host !== origin.slice("http://".length)) {
      send(res, 421, message("Misdirected request", "Unknown Host."));
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
        send(res, 500, message("Error", "The demo confirm page failed."));
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

/** A whole page on the ink ground: the brand row with the DEMO pill, `body`, and the footer. */
function layout(title: string, body: string, script = false): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark"><title>${esc(title)} · intent demo</title>` +
    `<link rel="stylesheet" href="${STYLE_PATH}"></head><body><div class="shell">` +
    `<header class="top"><span class="brand">${LOGO_SVG}</span><span class="pill">DEMO · nothing can be bought</span></header>` +
    `<main class="shell-main">${body}</main>` +
    `<p class="foot">${esc(DEMO_BANNER)} Served by your gateway on 127.0.0.1; real purchases are approved on intent's confirm page with your own passkey.</p>` +
    `</div>${script ? `<script>${CONFIRM_SCRIPT}</script>` : ""}</body></html>`
  );
}

/** The three steps; `at` is the current one (1 Review, 2 Enter code; 3 Approve lights up at six digits). */
function steps(at: number): string {
  const names = ["Review", "Enter code", "Approve"];
  return (
    `<ol class="steps" aria-label="Steps">` +
    names
      .map((name, i) => `<li${i === 2 ? ' id="step-approve"' : ""}${i < at ? ' class="now"' : ""}>${String(i + 1)} ${name}</li>`)
      .join("") +
    `</ol>`
  );
}

/** A result card: a status icon, the heading, what happened (`html`, already escaped) and the next step. */
function result(title: string, tone: "ok" | "no" | "warn" | "err", icon: string, html: string): string {
  return layout(
    title,
    `<div class="paper result"><div class="status status-${tone}">${icon}</div><h1>${esc(title)}</h1><p>${html}</p>` +
      `<div class="next"><strong>Next step</strong>${NEXT_STEP}</div></div>`,
  );
}

/** A plain card for a request the page did not expect; `text` is escaped. */
function message(title: string, text: string): string {
  return layout(title, `<div class="paper result"><div class="status status-err">${ICONS.alert}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`);
}

/** The card for an approval that is no longer pending. */
function settled(view: ApprovalRecordView): string {
  const state = view.state;
  if (state === "approved") return result("Already approved", "ok", ICONS.check, "This purchase was approved.");
  if (state === "rejected") return result("Rejected", "no", ICONS.cross, "This purchase was rejected.");
  if (state === "expired") return result("Expired", "warn", ICONS.clock, "This approval expired. Your agent can prepare a new cart.");
  return result("Approval closed", "no", ICONS.check, `This approval is ${esc(state)}.`);
}

function notFound(): string {
  return message("Unknown approval link", "This demo approval link is unknown. Demo approvals last only while the demo runs.");
}

/** `$1,234.56`. */
function money(minor: number): string {
  return `$${amount(minor)}`;
}

/** `1,234.56`, for a receipt line. */
function amount(minor: number): string {
  return `${Math.floor(minor / 100).toLocaleString("en-US")}.${String(minor % 100).padStart(2, "0")}`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}
