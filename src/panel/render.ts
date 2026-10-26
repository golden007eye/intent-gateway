// The panel page as HTML, from the PanelModel. Every value from the chain goes through esc(), so chain content is
// text, never markup; links come only from model fields that are already http(s)-only.
//
// The page works without JavaScript: every view is a <section> whose id is its address (`/purchases`), so the nav's
// `#/purchases` links scroll to it, and each purchase step's details are an <aside> shown by CSS :target. With
// app.js the views become one-at-a-time tabs with aria-current, and the live regions (data-live, versioned by
// data-v) refresh in place.
import { createHash } from "node:crypto";
import { ICONS, LOGO_SVG, printable } from "../ui/index.ts";
import { type Drawer, type Line, money, type PanelModel, type PurchaseView, type RequestDetail, type Step } from "./model.ts";

export const VIEWS = [
  ["overview", "Overview"],
  ["purchases", "Purchases"],
  ["approvals", "Approvals"],
  ["policy", "Policy"],
  ["log", "Server log"],
  ["verify", "Verify"],
] as const;

/** Render options: `pauseToken`, this panel run's token, shows the Pause button (the panel's only write, ADR-0023). */
export interface RenderOptions {
  readonly pauseToken?: string;
}

export function renderPage(m: PanelModel, options: RenderOptions = {}): string {
  const views: Record<(typeof VIEWS)[number][0], string> = {
    overview: overview(m),
    purchases: purchases(m),
    approvals: approvals(m),
    policy: policy(m),
    log: serverLog(m),
    verify: verify(m),
  };
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark"><title>intent gateway panel${m.mode === "demo" ? " · demo" : ""}</title>` +
    (options.pauseToken === undefined ? "" : `<meta name="intent-panel-token" content="${esc(options.pauseToken)}">`) +
    `<link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head><body>` +
    `<a class="skip" href="#main">Skip to the content</a><div class="app">` +
    header(m) +
    pauseBar(m, options.pauseToken !== undefined) +
    nav(m) +
    `<main id="main" tabindex="-1">` +
    VIEWS.map(
      ([id, name]) =>
        `<section class="view" id="/${id}" data-view="${id}" aria-labelledby="h-${id}"><h1 id="h-${id}" tabindex="-1">${name}</h1>` +
        // The log's filter form sits outside its live region, so a refresh keeps what you typed.
        `${id === "log" ? logFilters(m) : ""}${live(`view-${id}`, views[id])}</section>`,
    ).join("") +
    `</main></div></body></html>`
  );
}

function header(m: PanelModel): string {
  const pill = m.mode === "demo" ? `<span class="pill">DEMO</span>` : `<span class="pill pill-real">REAL</span>`;
  return (
    `<header class="bar"><a class="brand" href="#/overview">${LOGO_SVG}<span class="product">gateway</span></a>${pill}` +
    live("meta", `<p class="meta">read-only · 127.0.0.1 · updated <time>${esc(m.updated)}</time></p>`) +
    `</header>`
  );
}

/**
 * The pause banner while paused ("Paused since <time>. Resume needs your passkey.", Intent Cloud's word on it, the
 * purchases stopped); otherwise, on a panel run with a token, the Pause button. Nothing on a panel without one.
 */
function pauseBar(m: PanelModel, canPause: boolean): string {
  const p = m.pause;
  if (p === null) {
    if (!canPause) return "";
    return live(
      "pause",
      `<div class="pause-bar"><button type="button" class="pause-button" data-pause>Pause purchases</button>` +
        `<p>Stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app.</p></div>`,
    );
  }
  const stopped =
    p.stopped.length === 0 ? `<p>No open purchase was waiting.</p>` : `<p>Purchases stopped:</p><ul>${p.stopped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
  const refused = p.refusals === 0 ? "" : `<p>${String(p.refusals)} step${p.refusals === 1 ? "" : "s"} refused since the pause.</p>`;
  return live(
    "pause",
    `<div class="pause-banner" role="status"><strong>${esc(p.banner)}</strong>` +
      `<p class="tone-${p.cloudTone}">${esc(p.cloud)}</p>${stopped}${refused}` +
      `<p>To resume: run <code>${esc(m.intent)} resume</code>, which opens the confirm page's /account for your passkey.</p></div>`,
  );
}

function nav(m: PanelModel): string {
  const counts: Record<string, string> = {
    purchases: m.purchases.length === 0 ? "" : count(m.purchases.length, "purchases"),
    approvals: m.kpis.waiting === 0 ? "" : `<span class="badge">${String(m.kpis.waiting)}<span class="sr-only"> waiting for you</span></span>`,
    log: count(m.entries, "entries"),
    verify:
      m.verify === null
        ? ""
        : m.verify.ok
          ? `<span class="dot dot-ok" title="passed"><span class="sr-only">passed</span></span>`
          : `<span class="dot dot-bad" title="failed"><span class="sr-only">failed</span></span>`,
  };
  const items = VIEWS.map(
    ([id, name]) =>
      `<li><a href="#/${id}" data-route="${id}"${id === "overview" ? ' aria-current="page"' : ""}><span>${name}</span>${live(`count-${id}`, counts[id] ?? "")}</a></li>`,
  ).join("");
  return `<nav class="nav" aria-label="Panel views"><ul>${items}</ul><p class="nav-foot">${m.mode === "demo" ? "DEMO log" : "REAL log"} · read-only</p></nav>`;
}

// ---- overview -----------------------------------------------------------------------------------------------------

function overview(m: PanelModel): string {
  const k = m.kpis;
  const limit = k.dailyLimitMinor;
  const pct = limit === null || limit === 0 ? 0 : Math.min(100, Math.round((k.approvedMinor / limit) * 100));
  const approved =
    card(
      "Approved today",
      money(k.approvedMinor),
      (limit === null ? "" : `<div class="bar-track" aria-hidden="true"><div class="bar-fill w${String(Math.round(pct / 5) * 5)}"></div></div>`) +
        `<p class="small">${limit === null ? "no daily limit in your policy" : `of ${esc(money(limit))} daily limit (your policy, last 24 h)`}</p>`,
    );
  const waiting = card(
    "Waiting for you",
    String(k.waiting),
    k.nextWaiting === null
      ? `<p class="small">no approval waiting</p>`
      : (k.nextWaiting.url === null ? `<p class="small">${esc(k.nextWaiting.text)}</p>` : `<a class="small" href="${esc(k.nextWaiting.url)}" target="_blank" rel="noopener noreferrer">${esc(k.nextWaiting.text)}</a>`) +
        `<a class="small" href="#/approvals">See approvals</a>`,
    k.waiting > 0 ? " card-hot" : "",
  );
  const problems = [
    k.unacknowledged === 0 ? "" : `${String(k.unacknowledged)} no receipt`,
    k.maybeSent === 0 ? "" : `${String(k.maybeSent)} logged, maybe sent`,
    k.discarded === 0 ? "" : `${String(k.discarded)} discarded`,
    k.notSent === 0 ? "" : `${String(k.notSent)} not sent (no connection)`,
  ].filter(Boolean);
  const sent = card(
    "Sent to Intent Cloud",
    String(k.sent),
    (k.sent === 0 && problems.length === 0
      ? `<p class="small">nothing sent yet</p>`
      : problems.length === 0
        ? `<p class="small t-ok">all ${String(k.acknowledged)} acknowledged by signed receipt</p>`
        : `<p class="small">${String(k.acknowledged)} acknowledged by receipt</p><p class="small t-warn">${esc(problems.join(" · "))}</p>`) +
      // Each wallet destination apart: it answers, it never acknowledges (no receipt).
      k.elsewhere
        .map((d) => `<p class="small">Also sent to ${esc(d.destination)}: ${String(d.sent)} (${String(d.answered)} answered, no signed receipt${d.maybeSent === 0 ? "" : `; ${String(d.maybeSent)} logged, maybe sent`})</p>`)
        .join(""),
  );
  const refused = card("Refused before sending", String(k.refusedBefore), `<p class="small">${esc(k.refusedNote)}</p>`, "", k.refusedBefore > 0 ? " t-bad" : "");
  const feed = m.feed.slice(0, 10);
  const rules =
    m.policy === null
      ? `<p class="small t-bad">${esc(m.policyError ?? "")}</p>`
      : m.policy.summary.map((s) => `<p>${esc(s)}</p>`).join("");
  return (
    `<p class="lede">What this gateway sent, what came back and what waits for you, read from its local log.</p>` +
    `<div class="kpis">${approved}${waiting}${sent}${refused}</div>` +
    `<div class="split"><section class="panel feed-panel" aria-labelledby="h-activity">` +
    `<div class="panel-head"><h2 id="h-activity">Activity</h2><a class="btn btn-secondary btn-inline" href="#/purchases">View purchase timeline →</a></div>` +
    (feed.length === 0 ? `<p class="muted">No activity yet. Ask your agent to search for something.</p>` : `<ol class="feed">${feed.map(feedItem).join("")}</ol>`) +
    `<a class="more" href="#/purchases">Purchases timeline</a></section>` +
    `<section class="panel rules" aria-labelledby="h-rules"><h2 id="h-rules">Your rules</h2>${rules}` +
    `<p>Approver: ${m.pin === null ? "none pinned yet" : `passkey <code>${esc(fp(m.pin.fingerprint))}</code> (pinned)`}</p>` +
    `<p class="small">A policy can only narrow the rules Intent Cloud enforces.</p><a class="more" href="#/policy">Policy details</a></section></div>` +
    `<section class="panel logstrip" aria-labelledby="h-strip"><h2 id="h-strip">Server log</h2>` +
    (m.log.length === 0 ? `<p class="muted">No entries yet.</p>` : `<ol class="strip">${m.log.slice(-3).map((r) => `<li class="t-${r.tone}"><span>#${String(r.seq)}</span> <span>${esc(r.clock)}</span> ${esc(r.summary)}</li>`).join("")}</ol>`) +
    `<a class="more" href="#/log">Full server log</a></section>`
  );
}

function card(label: string, value: string, body: string, extra = "", valueTone = ""): string {
  return `<div class="card${extra}"><p class="k">${esc(label)}</p><p class="v${valueTone}">${esc(value)}</p>${body}</div>`;
}

function feedItem(l: Line): string {
  return `<li><time datetime="${esc(l.ts)}">${esc(l.clock)}</time><span class="label t-${l.tone}">${esc(l.label)}</span><span>${esc(l.text)}</span></li>`;
}

// ---- purchases ----------------------------------------------------------------------------------------------------

function purchases(m: PanelModel): string {
  const list =
    m.purchases.length === 0
      ? `<p class="muted">No purchases yet. When your agent prepares a cart it shows here as Search → Cart → Your approval → Agent checked.</p>`
      : m.purchases.map(purchase).join("");
  const refused =
    m.refusals.length === 0
      ? ""
      : `<section class="refusals" aria-labelledby="h-refused"><h2 id="h-refused">Refused requests</h2><ul>` +
        m.refusals.map((r) => `<li><span class="t-bad">Refused</span> ${esc(r.text)} <time datetime="${esc(r.ts)}">${esc(r.clock)}</time></li>`).join("") +
        `</ul></section>`;
  return (
    `<p class="lede">Each purchase as its steps. Open a step's details to see exactly what left your machine and what came back.</p>` +
    list +
    refused +
    m.drawers.map((d) => drawer(d, m.verifyCommand)).join("")
  );
}

function purchase(p: PurchaseView): string {
  return (
    `<article class="purchase" aria-labelledby="t-${p.id}"><div class="ph"><h2 id="t-${p.id}">${esc(p.title)}</h2><span class="chip chip-${p.tone}">${esc(p.state)}</span></div>` +
    `<p class="small">${esc(p.subtitle)} · <time datetime="${esc(p.ts)}">${esc(p.clock)}</time></p>` +
    `<ol class="steps-line">${p.steps.map((s) => step(s, p)).join("")}</ol></article>`
  );
}

function step(s: Step, p: PurchaseView): string {
  const state = { done: "done", waiting: "waiting", failed: "failed", todo: "not yet" }[s.state];
  return (
    `<li class="step step-${s.state}"><span class="sn">${String(s.n)} ${esc(s.name)}<span class="sr-only">: ${state}</span></span><span class="small">${esc(s.note)}</span>` +
    (s.link === null ? "" : `<a href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">Open approval page</a>`) +
    (s.drawer === null ? "" : `<a href="#/purchases/${s.drawer}" data-drawer="${s.drawer}">Details<span class="sr-only"> of ${esc(s.name)}, ${esc(p.title)}</span></a>`) +
    `</li>`
  );
}

function drawer(d: Drawer, verifyCommand: string): string {
  return (
    `<aside class="drawer" id="/purchases/${d.id}" aria-labelledby="dh-${d.id}"><div class="paper drawer-in">` +
    `<div class="dtop"><p class="kicker">${esc(d.heading)} · details</p><a class="close" href="#/purchases">Close<span class="sr-only"> details</span></a></div>` +
    `<h2 id="dh-${d.id}" tabindex="-1">${d.requests.length === 0 ? esc(d.heading) : "What left your machine"}</h2>` +
    d.requests.map(request).join("") +
    (d.facts.length === 0 ? "" : kv(d.facts)) +
    `<p class="small">${esc(d.seqs)} · <code class="cmd">${esc(verifyCommand)}</code> re-checks every signature and approval.</p></div></aside>`
  );
}

function request(r: RequestDetail): string {
  return (
    `<div class="req"><p class="ep"><code>${esc(r.endpoint)}</code> <span class="small">${esc(r.method)}</span></p>` +
    (r.sent.length === 0 ? `<p class="small">No body fields.</p>` : kv(r.sent)) +
    `<p class="small">Never sent: your name, postal address and card.</p>` +
    `<h3>What came back</h3>` +
    (r.back.length === 0 ? "" : kv(r.back)) +
    `<p class="small d-${r.tone}">${esc(r.delivery)}</p>` +
    (r.digest === null ? "" : `<p class="small mono">#${String(r.seq)} · digest ${esc(r.digest)}</p>`) +
    `</div>`
  );
}

function kv(rows: readonly (readonly [string, string])[]): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
}

// ---- approvals ----------------------------------------------------------------------------------------------------

function approvals(m: PanelModel): string {
  const waiting = m.pending.filter((p) => !p.expired);
  const expired = m.pending.filter((p) => p.expired);
  const pending =
    waiting.length === 0
      ? `<p class="muted">Nothing is waiting for your approval.</p>`
      : `<ul class="cards">` +
        waiting
          .map(
            (p) =>
              `<li class="card card-hot"><p class="k">Waiting since <time datetime="${esc(p.ts)}">${esc(p.clock)}</time></p><p class="v">${esc(p.total)}</p>` +
              `<p class="small">approval <code>${esc(p.handle)}</code>${p.expires === "" ? "" : ` · expires ${esc(p.expires)}`}</p>` +
              (p.url === null ? "" : `<a class="btn btn-primary" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open approval page</a>`) +
              `</li>`,
          )
          .join("") +
        `</ul>`;
  const done =
    m.approved.length === 0 && expired.length === 0
      ? `<p class="muted">No approvals yet.</p>`
      : `<ul class="rows">` +
        m.approved.map((a) => `<li><span class="t-ok">approved</span> ${esc(a.total)} · <code>${esc(a.handle)}</code> · passkey <code>${esc(fp(a.fingerprint))}</code>${a.pinned ? " · pinned as your approver" : ""} <time datetime="${esc(a.ts)}">${esc(a.clock)}</time></li>`).join("") +
        expired.map((p) => `<li><span class="muted">expired</span> ${esc(p.total)} · <code>${esc(p.handle)}</code> <time datetime="${esc(p.ts)}">${esc(p.clock)}</time></li>`).join("") +
        `</ul>`;
  const flags =
    m.flags.length === 0
      ? ""
      : `<div class="alert-dark" role="note">${ICONS.alert}<div>${m.flags.map((f) => `<p>${esc(f.text)}.</p>`).join("")}<p>Accept a passkey only with <code class="cmd">${esc(m.intent)} approver accept</code> at a terminal, and only if it is your own.</p></div></div>`;
  return (
    `<p class="lede">Every purchase needs your passkey. The agent cannot approve for you.</p>` +
    `<section class="panel" aria-labelledby="h-waiting"><h2 id="h-waiting">Waiting for you</h2>${pending}</section>` +
    `<section class="panel" aria-labelledby="h-done"><h2 id="h-done">Approved and expired</h2>${done}</section>` +
    `<section class="panel" aria-labelledby="h-pin"><h2 id="h-pin">Approver pin</h2>` +
    (m.pin === null
      ? `<p class="muted">No approver pinned yet. The first verified Approval sets the pin.</p>`
      : `<p class="fpr"><code>${esc(m.pin.fingerprint)}</code></p><p class="small">Pinned at #${String(m.pin.seq)}, ${esc(m.pin.clock)}. Compare it with your passkey manager.</p>`) +
    flags +
    `</section>`
  );
}

// ---- policy -------------------------------------------------------------------------------------------------------

function policy(m: PanelModel): string {
  if (m.policy === null) return `<p class="lede t-bad">${esc(m.policyError ?? "")}</p>`;
  return (
    `<p class="lede">The active policy decides what leaves this gateway and how much may be spent. A policy can only narrow the rules Intent Cloud enforces.</p>` +
    `<section class="panel"><p class="small">From ${esc(m.policy.source)}</p>${kv(m.policy.rules)}</section>` +
    `<p class="small">See it as YAML with <code class="cmd">${esc(m.intent)} policy show</code>; narrow it with <code class="cmd">${esc(m.intent)} policy add &lt;name&gt;</code>.</p>`
  );
}

// ---- server log ---------------------------------------------------------------------------------------------------

function serverLog(m: PanelModel): string {
  const chain = m.chain.ok
    ? `<p class="t-ok">${String(m.entries)} entries, each linked to the one before${m.head === null ? "" : `; last entry #${String(m.head.seq)}`}.</p>`
    : `<p class="t-bad" role="alert">The log breaks at entry #${String(m.chain.brokenSeq)}: ${esc(m.chain.reason)}. Run <code class="cmd">${esc(m.verifyCommand)}</code>.</p>`;
  const rows = m.log
    .map(
      (r) =>
        `<li data-kind="${esc(r.kind)}" class="t-${r.tone}"><details><summary><span class="seq">#${String(r.seq)}</span> <time datetime="${esc(r.ts)}">${esc(r.clock)}</time> <span class="kind">${esc(r.kind)}</span> <span>${esc(r.summary)}</span></summary>` +
        kv([...r.fields, ["prev", r.prev], ["hash", r.hash]]) +
        `</details></li>`,
    )
    .join("");
  return (
    chain +
    (m.log.length === 0 ? `<p class="muted">No entries yet: the gateway has sent nothing.</p>` : `<ol class="log" id="log-rows">${rows}</ol>`) +
    `<p class="small">The same entries as <code class="cmd">${esc(m.intent)} log -v</code>, which groups it by action.</p>`
  );
}

/** The log's lede and filter form; the form is shown by app.js (without it every entry is listed anyway). The kind
 * list is fixed at page load, so a kind first logged later shows under "all" until a reload. */
function logFilters(m: PanelModel): string {
  return (
    `<p class="lede">The full local log, entry by entry and field by field: what the gateway logged before each send and what came back.</p>` +
    `<form class="filters" id="log-filters" hidden role="search" aria-label="Filter the server log">` +
    `<label>Kind <select id="log-kind"><option value="">all</option>${m.logKinds.map((k) => `<option>${esc(k)}</option>`).join("")}</select></label>` +
    `<label>Find <input id="log-q" type="search" autocomplete="off" spellcheck="false" placeholder="field, value or seq"></label>` +
    `<p class="small" id="log-shown" aria-live="polite"></p></form>`
  );
}

// ---- verify -------------------------------------------------------------------------------------------------------

function verify(m: PanelModel): string {
  const command = `<code class="cmd">${esc(m.verifyCommand)}</code>`;
  if (m.verify === null) return `<p class="lede">Not run here. Run ${command} in a terminal.</p>`;
  const v = m.verify;
  const status = v.ok ? `<div class="status status-ok">${ICONS.check}</div>` : `<div class="status status-err">${ICONS.alert}</div>`;
  return (
    `<p class="lede">The same checks as ${command}, run by the panel over this log whenever it changes: the links between entries, the key statements, every receipt and every approval proof.</p>` +
    `<section class="paper vres">${status}<h2>${v.ok ? "Every check passed" : "A check failed"}</h2>` +
    `<ul class="checks">${v.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? ICONS.check : ICONS.cross}<div><p class="cn">${esc(c.name)}<span class="sr-only">: ${c.ok ? "passed" : "failed"}</span></p>${c.details.map((d) => `<p class="small">${esc(d)}</p>`).join("")}</div></li>`).join("")}</ul>` +
    `<p class="small mono">last entry #${String(v.head.seq)} · ${esc(v.head.hash)}</p></section>` +
    `<p class="small">The panel skips the install self-check; ${command} runs it too.</p>`
  );
}

// ---- helpers ------------------------------------------------------------------------------------------------------

/** A region app.js refreshes in place: its data-v changes only when its HTML does. */
function live(id: string, html: string): string {
  const v = createHash("sha256").update(html).digest("base64url").slice(0, 12);
  return `<div class="live" data-live="${id}" data-v="${v}">${html}</div>`;
}

function count(n: number, what: string): string {
  return `<span class="count">${String(n)}<span class="sr-only"> ${what}</span></span>`;
}

function fp(fingerprint: string): string {
  const compact = fingerprint.replace(/\s+/g, "");
  return compact.length > 12 ? `${compact.slice(0, 4)}…${compact.slice(-4)}` : fingerprint;
}

/** A chain value as HTML text: made printable first (controls, bidi and line breaks shown as escapes), then escaped. */
export function esc(text: string): string {
  return printable(text).replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}
