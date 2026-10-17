// `intent log`'s default view, the action timeline: a header (demo or real chain, data dir, entries), a date header
// per day, one line per action (time, verb, the values it sent in readable form, its outcome), what was sent and what
// never was, the counts, and where the details are. It says what the gateway sent and what came back for each request
// (invariant 5): "receipt" only for a receipt entry, "passkey proof checked" only for an approval the gateway chained
// after verifying its proof, and `→ 3 offers`, a product title or an approval state only from an `observed` entry,
// which records what Intent Cloud returned. A chain without observations shows the values sent, as before. A call to
// a wallet destination (Shop) says "answered" with the status its `response` entry recorded, never "receipt": a wallet
// signs none. The "Sent to … only" lines name each destination apart, from what its logged requests carried.
// `intent verify` re-checks every signature. Pure; the golden test pins it.
import { type Activity, type ActivitySummary, type DestinationSummary, destinationLabel, INTENT_CLOUD, summarise } from "../activity/index.ts";
import { INTENT } from "../config/index.ts";
import { printable } from "../ui/index.ts";

export interface TimelineStyle {
  /** ANSI colour (a terminal, no NO_COLOR, no --no-color). */
  readonly color: boolean;
  /** 24-bit colour (COLORTERM=truecolor or 24bit): the brand sage; otherwise the terminal's cyan. */
  readonly truecolor?: boolean;
  /** Symbols (✓ ⚠ ✗ → · …); false for a terminal whose locale is not UTF-8: plain ASCII. */
  readonly unicode?: boolean;
  /** The terminal's width: lines are cut to it with an ellipsis. Absent when the output is not a terminal. */
  readonly columns?: number;
  /** --utc: times in UTC; otherwise in `timeZone` (the local zone when absent). */
  readonly utc?: boolean;
  readonly timeZone?: string;
}

export interface TimelineContext {
  /** The whole chain, for the header, the demo label and the integrity line. */
  readonly items: readonly unknown[];
  /** The actions to show (all, or the ones a filter kept) and how many the chain has. */
  readonly shown: readonly Activity[];
  readonly total: number;
  readonly dataDir: string;
  /** For `~` in the data dir. */
  readonly home?: string;
  /** The invocation printed before each suggested command; config's INTENT when absent. */
  readonly intent?: string;
}

/** The longest invocation still printed before every command of the footer (as in `--help`). */
const INLINE_MAX = 30;

type Tone = "good" | "warn" | "bad" | "sage" | "dim" | "bold" | null;

interface Glyphs {
  ok: string;
  warn: string;
  bad: string;
  arrow: string;
  dot: string;
  more: string;
  times: string;
}

const UNICODE: Glyphs = { ok: "✓", warn: "⚠", bad: "✗", arrow: "→", dot: "·", more: "…", times: "×" };
const ASCII: Glyphs = { ok: "ok", warn: "!", bad: "x", arrow: "->", dot: "-", more: "...", times: "x" };

const VERB_WIDTH = 8;
/** The values column is padded to the widest line, up to this many characters, so outcomes line up. */
const VALUES_MAX = 52;

/** Friendly names for the fields a request carries, in the order they are listed. */
const FIELD_NAMES: readonly [RegExp, string][] = [
  [/^category$/, "category"],
  [/^product$/, "product"],
  [/^must_haves(\[\])?$/, "must-haves"],
  [/^budget_max\./, "budget"],
  [/^offer_handle$/, "offer"],
  [/^quantity$/, "quantity"],
  [/^ship_to\.postal_code$/, "ZIP code"],
  [/^ship_to\.country$/, "country"],
];

export function formatTimeline(context: TimelineContext, style: TimelineStyle): string {
  const { items, shown, total } = context;
  const g = style.unicode === false ? ASCII : UNICODE;
  const paint = painter(style);
  const summary = summarise(items, shown);
  const all = summarise(items, []);
  const lines: string[] = [];
  const dir = context.home !== undefined && context.home !== "" && context.dataDir.startsWith(`${context.home}/`) ? `~${context.dataDir.slice(context.home.length)}` : context.dataDir;
  lines.push(paint("dim", [`intent log`, all.demo ? "DEMO chain (test keys)" : "real chain", dir, plural(items.length, "entry", "entries")].join(` ${g.dot} `)));

  const rows = shown.map((a) => row(a, g));
  const valuesWidth = Math.min(VALUES_MAX, Math.max(0, ...rows.map((r) => r.values.length)));
  let day = "";
  for (const [index, activity] of shown.entries()) {
    const r = rows[index];
    if (r === undefined) continue;
    const date = activity.time === "" ? "" : dayHeader(activity.time, style);
    if (date !== day && date !== "") {
      lines.push("", paint("sage", date));
      day = date;
    }
    lines.push(rowLine(activity, r, valuesWidth, style, g, paint));
  }
  if (shown.length === 0) lines.push("", total === 0 ? `No entries yet: the gateway has sent nothing. Start it with ${INTENT} serve, or try ${INTENT} demo.` : "No action matches the filter.");

  lines.push("");
  lines.push(...disclosed(summary, g, paint));
  lines.push("");
  lines.push(counts(summary, shown.length, total, g, paint));
  if (!all.chain.ok) {
    lines.push(paint("bad", `${g.bad} the chain breaks at seq ${String(all.chain.brokenSeq)} (${all.chain.reason}); run ${INTENT} verify${all.demo ? " --demo" : ""}`));
  }
  const body = lines.map((l) => (style.columns === undefined ? l : fit(l, style.columns, g)));
  // The footer is never cut: a command cut short with an ellipsis cannot be pasted. A long invocation (a tarball or a
  // source path) is named once on its own line, as `--help` does, so the commands stay readable; on a terminal too
  // narrow for one line, each command gets its own.
  const intent = context.intent ?? INTENT;
  const inline = intent.length <= INLINE_MAX;
  const run = (command: string): string => (inline ? `${intent} ${command}` : command);
  const demo = all.demo ? " --demo" : "";
  const footer = [`Details: ${run(`log${demo} -v`)}`, `Machine-readable: ${run(`log${demo} --json`)}`, `Integrity: ${run(`verify${demo}`)}`];
  const one = footer.join(` ${g.dot} `);
  for (const l of style.columns === undefined || one.length <= style.columns ? [one] : footer) body.push(paint("dim", l));
  if (!inline) body.push(paint("dim", `Run each as: ${intent} <command>`));
  return body.join("\n") + "\n";
}

/** `--follow`: each new action as its timeline line, after a date header when the day changes. */
export function timelineFollow(style: TimelineStyle, lastTime: string): (activity: Activity) => string {
  const g = style.unicode === false ? ASCII : UNICODE;
  const paint = painter(style);
  let day = lastTime === "" ? "" : dayHeader(lastTime, style);
  return (activity) => {
    const date = activity.time === "" ? "" : dayHeader(activity.time, style);
    const header = date !== day && date !== "" ? `\n${paint("sage", date)}\n` : "";
    if (date !== "") day = date;
    return header + rowLine(activity, row(activity, g), VALUES_MAX, style, g, paint);
  };
}

function rowLine(activity: Activity, r: Row, valuesWidth: number, style: TimelineStyle, g: Glyphs, paint: (tone: Tone, s: string) => string): string {
  const time = activity.time === "" ? "        " : clockTime(activity.time, style);
  const verb = paint(r.verbTone, r.verb.padEnd(VERB_WIDTH));
  const fixed = 8 + 2 + VERB_WIDTH + 2 + 2;
  // On a terminal the values give way first, so the outcome stays visible.
  const room = style.columns === undefined ? Infinity : Math.max(10, style.columns - fixed - r.outcome.length);
  const values = cut(r.values, room, g).padEnd(Math.min(room, valuesWidth));
  return `${paint("dim", time)}  ${verb}  ${values}  ${paint(r.outcomeTone, r.outcome)}`;
}

interface Row {
  verb: string;
  verbTone: Tone;
  values: string;
  outcome: string;
  outcomeTone: Tone;
}

/** An action's line parts, every chain-derived value in them made printable (terminal.ts). */
function row(a: Activity, g: Glyphs): Row {
  const r = rawRow(a, g);
  return { ...r, values: printable(r.values), outcome: printable(r.outcome) };
}

function rawRow(a: Activity, g: Glyphs): Row {
  const f = a.facts;
  const sep = ` ${g.dot} `;
  const receipts = a.requests.filter((r) => r.delivery === "acknowledged").length;
  const delivered = (): [string, Tone] => delivery(a, receipts, g);
  switch (a.action) {
    case "search": {
      const parts = [
        ...(f.product === undefined ? [] : [`"${f.product}"`]),
        ...(f.category === undefined ? [] : [f.category]),
        ...(f.must_haves === undefined || f.must_haves.length === 0 ? [] : [`must: ${f.must_haves.join(", ")}`]),
        ...(f.budget_minor === undefined ? [] : [`under ${money(f.budget_minor, f.currency)}`]),
        ...(f.zip === undefined ? [] : [`ZIP ${f.zip}`]),
      ];
      const [outcome, tone] = delivered();
      // What came back, then the receipt: the receipt covers the request and its status, not the offers returned.
      const returned = f.offers_count === undefined || a.outcome !== "acknowledged" ? "" : `${g.arrow} ${offersWord(f.offers_count, f.offers_hidden ?? 0)} ${g.dot} `;
      return { verb: "search", verbTone: tone === "warn" ? "warn" : "bold", values: parts.length > 0 ? parts.join(sep) : names(a), outcome: returned + outcome, outcomeTone: tone };
    }
    case "cart": {
      // With an observation: what Intent Cloud returned (title, total, merchant); without one: the values sent.
      const parts =
        f.title === undefined
          ? [
              ...(f.offer_handle === undefined ? [] : [`offer ${short(f.offer_handle, g)} ${g.times}${String(f.quantity ?? 1)}`]),
              ...(f.total_minor === undefined ? [] : [`at most ${money(f.total_minor)}`]),
              ...(f.zip === undefined ? [] : [`ZIP ${f.zip}`]),
            ]
          : [`${f.title} ${g.times}${String(f.quantity ?? 1)}`, ...total(f), ...(f.merchant === undefined ? [] : [f.merchant])];
      const values = parts.length > 0 ? parts.join(sep) : names(a);
      if (a.outcome === "refused") return { verb: "cart", verbTone: "bad", values, outcome: `${g.bad} refused: ${a.blocked.join("; ")}`, outcomeTone: "bad" };
      if (a.outcome === "approval_asked") {
        return { verb: "cart", verbTone: "bold", values, outcome: `${g.arrow} approval link  ${g.ok} ${receiptWord(receipts)}`, outcomeTone: "good" };
      }
      const [outcome, tone] = delivered();
      return { verb: "cart", verbTone: tone === "warn" ? "warn" : "bold", values, outcome, outcomeTone: tone };
    }
    case "status": {
      const handle = f.approval_handle === undefined ? "approval" : `approval ${short(f.approval_handle, g)}`;
      if (a.outcome === "refused") return { verb: "status", verbTone: "bad", values: handle, outcome: `${g.bad} proof refused: ${a.blocked.join("; ")}`, outcomeTone: "bad" };
      if (a.outcome === "rejected" || a.outcome === "expired") {
        const values = [...total(f), ...(f.title === undefined ? [] : [f.title]), handle].join(sep);
        return { verb: a.outcome, verbTone: "bad", values, outcome: `${g.arrow} ${says(a.outcome)} ${g.dot} ${g.ok} ${receiptWord(receipts)}`, outcomeTone: "bad" };
      }
      const [outcome, tone] = delivered();
      const state = f.approval_state === undefined || a.outcome !== "acknowledged" ? "" : `${g.arrow} ${says(f.approval_state.replace("_", " "))} ${g.dot} `;
      return { verb: "status", verbTone: tone === "warn" ? "warn" : "bold", values: handle, outcome: state + outcome, outcomeTone: tone };
    }
    case "approval": {
      const parts = [
        ...(f.total_minor === undefined ? [] : [money(f.total_minor)]),
        ...(f.fingerprint === undefined ? [] : [`passkey ${fingerprint(f.fingerprint, g)}${f.pinned === true ? " (pinned now)" : " (pinned)"}`]),
      ];
      return { verb: "approved", verbTone: "sage", values: parts.join(sep) || (f.approval_handle ?? ""), outcome: `${g.ok} passkey proof checked`, outcomeTone: "good" };
    }
    case "blocked": {
      const what =
        f.destination !== undefined
          ? `${destinationLabel(f.destination)} ${f.endpoint ?? "request"}`
          : (heldWords(f.endpoint ?? "", f.held, g) ?? ENDPOINT_WORDS[f.endpoint ?? ""] ?? f.endpoint ?? "request");
      const why = a.blocked.map((r) => (f.block_kind === "logging" ? `not logged as sent: ${r}` : reason(r))).join("; ") || "no reason recorded";
      const refused = a.outcome === "refused";
      return { verb: "blocked", verbTone: "bad", values: `${what}: ${why}`, outcome: refused ? `${g.bad} refused` : `${g.bad} nothing sent`, outcomeTone: "bad" };
    }
    case "start":
    case "keys": {
      const parts = [
        ...(a.action === "start" ? ["gateway started"] : []),
        ...(f.key_kid === undefined ? (a.requests.length === 0 ? [] : ["key reads"]) : [`keys signed by ${f.key_kid}`, ...(f.keys_expire_at === undefined ? [] : [`valid until ${f.keys_expire_at.slice(0, 10)}`])]),
      ];
      if (a.requests.length === 0) return { verb: a.action, verbTone: "dim", values: parts.join(sep), outcome: `${g.ok} recorded`, outcomeTone: "good" };
      const [outcome, tone] = delivered();
      return { verb: a.action, verbTone: tone === "warn" ? "warn" : "dim", values: parts.join(sep), outcome, outcomeTone: tone };
    }
    case "pin":
      return { verb: "pinned", verbTone: "sage", values: `passkey ${fingerprint(f.fingerprint ?? "", g)} is the approver now`, outcome: `${g.ok} pinned`, outcomeTone: "good" };
    case "flagged":
      return {
        verb: "flagged",
        verbTone: "bad",
        values: `passkey ${fingerprint(f.fingerprint ?? "", g)}`,
        outcome: f.flag_reason === "sign_count" ? `${g.bad} signature counter did not go up: not approved` : `${g.bad} not the pinned approver: not approved (${INTENT} approver accept)`,
        outcomeTone: "bad",
      };
    case "wallet":
      return { verb: "wallet", verbTone: "dim", values: walletWords(f, sep), outcome: `${g.ok} recorded`, outcomeTone: "good" };
    case "call": {
      const request = a.requests[0];
      const values = [`${destinationLabel(f.destination ?? "")} ${f.endpoint ?? ""}`.trim(), argumentNames(a)].filter((v) => v !== "").join(sep);
      if (request?.delivery !== "answered") {
        const [outcome, tone] = delivered();
        return { verb: "call", verbTone: tone === "warn" ? "warn" : "bold", values, outcome, outcomeTone: tone };
      }
      const status = request.response?.status ?? null;
      const ok = status !== null && status < 400;
      return { verb: "call", verbTone: "bold", values, outcome: `${ok ? g.ok : g.warn} answered${status === null ? "" : ` ${String(status)}`} (no receipt: unsigned)`, outcomeTone: ok ? "good" : "warn" };
    }
    case "unreadable":
      return { verb: "broken", verbTone: "bad", values: `line ${String(f.line ?? "?")} is not an entry (torn or edited)`, outcome: `${g.bad} run ${INTENT} verify`, outcomeTone: "bad" };
  }
}

/** A state an observation recorded, worded as what Intent Cloud returned: the receipt does not cover the body. */
function says(state: string): string {
  return `Intent Cloud says ${state}`;
}

/** The total an observation returned, `withheld` when it withheld it as possible buyer identity, or nothing. */
function total(f: Activity["facts"]): string[] {
  if (f.total_minor !== undefined) return [money(f.total_minor)];
  return f.withheld?.includes("total_minor") === true ? ["total withheld"] : [];
}

/** The outcome of an action's requests, in verify's categories. */
function delivery(a: Activity, receipts: number, g: Glyphs): [string, Tone] {
  switch (a.outcome) {
    case "acknowledged":
      return [`${g.ok} ${receiptWord(receipts)}`, "good"];
    case "unacknowledged":
      return [`${g.warn} sent, no receipt`, "warn"];
    case "not_sent":
      return [`${g.warn} not sent: no connection was made`, "warn"];
    case "maybe_sent":
      return [`${g.warn} maybe sent, no answer recorded`, "warn"];
    case "answered":
      return [`${g.ok} answered (no receipt: unsigned)`, "good"];
    case "discarded":
      return [`${g.bad} answer discarded: no valid receipt`, "bad"];
    default:
      return [`${g.ok} ${receiptWord(receipts)}`, "good"];
  }
}

/** `search for "alcohol"`, `cart for "Budget Running Shoe" ×1`: the structured values a policy block held back, when the chain has them (never free text). */
function heldWords(endpoint: string, held: Readonly<Record<string, unknown>> | undefined, g: Glyphs): string | null {
  if (held === undefined) return null;
  const what = typeof held.category === "string" ? held.category : typeof held.title === "string" ? held.title : null;
  if (what === null) return null;
  const word = ENDPOINT_WORDS[endpoint] ?? endpoint;
  return `${word} for "${what}"${typeof held.quantity === "number" ? ` ${g.times}${String(held.quantity)}` : ""}`;
}

function offersWord(count: number, hidden: number): string {
  return `${plural(count, "offer", "offers")}${hidden === 0 ? "" : `, ${String(hidden)} hidden by your policy`}`;
}

const ENDPOINT_WORDS: Readonly<Record<string, string>> = { searchCatalog: "search", createCart: "cart", createApproval: "approval request", getApproval: "status check" };

const IDENTITY_WORDS: Readonly<Record<string, string>> = {
  card: "a card number",
  email: "an email address",
  phone: "a phone number",
  street_address: "a street address",
  banned_key: "an identity field",
};

/** `categories.block at category` → `category excluded by your gateway policy`; `email at $.note` → `an email address in note`. */
function reason(text: string): string {
  const match = /^(.+?) at (.+)$/.exec(text);
  if (match === null) return text;
  const [, rule = "", path = ""] = match;
  const where = path.replace(/^\$\.?/, "") || "the request";
  const identity = IDENTITY_WORDS[rule];
  if (identity !== undefined) return `${identity} in ${where}`;
  if (rule === "categories.block") return "category excluded by your gateway policy";
  if (rule === "merchants.block" || rule === "merchants.allow") return "merchant not allowed by your gateway policy";
  return `${rule} (${where}) by your gateway policy`;
}

/**
 * "Sent to Intent Cloud only: …" (one such line per destination, each listing what its logged requests carried) and
 * "Never sent: …", from the values the shown requests logged. A destination with no request shown has no line.
 */
function disclosed(summary: ActivitySummary, g: Glyphs, paint: (tone: Tone, s: string) => string): string[] {
  const out: string[] = [];
  const destinations = summary.destinations.length === 0 ? [{ destination: INTENT_CLOUD, logged: 0, maybe_sent: 0, not_sent: 0, fields: [], redacted: [] }] : summary.destinations;
  for (const d of destinations) out.push(paint("dim", sentLine(d)));
  const { checked, unchecked, findings } = summary.identity;
  if (findings.length > 0) {
    out.push(paint("bad", `${g.bad} Buyer identity in what was sent: ${findings.map((f) => `seq ${String(f.seq)} (${f.kinds.join(", ")})`).join(", ")}; run ${INTENT} verify`));
  } else if (checked > 0 || unchecked === 0) {
    const caveat = unchecked === 0 ? "" : ` (${plural(unchecked, "request", "requests")} with no logged bytes not checked)`;
    out.push(paint("dim", `Never sent: your name, postal address, card${caveat}.`));
  } else {
    out.push(paint("dim", `Not checked: ${plural(unchecked, "request has", "requests have")} no logged bytes.`));
  }
  return out;
}

/** `Sent to Shop only (1 request maybe sent): tool name, checkout_id, MCP envelope, 1 credential (in the log as a digest).` */
function sentLine(d: DestinationSummary): string {
  const label = destinationLabel(d.destination);
  const friendly = d.destination === INTENT_CLOUD ? cloudFields(d.fields) : walletFields(d.fields);
  const credentials = new Set(d.redacted).size;
  if (credentials > 0) friendly.push(credentials === 1 ? "1 credential (in the log as a digest)" : `${String(credentials)} credentials (in the log as digests)`);
  if (friendly.length === 0) return d.logged > d.not_sent ? `Sent to ${label}: no request fields.` : `Sent to ${label}: nothing (${plural(d.not_sent, "request", "requests")} never left).`;
  const maybe = d.maybe_sent === 0 ? "" : ` (${plural(d.maybe_sent, "request", "requests")} maybe sent)`;
  return `Sent to ${label} only${maybe}: ${friendly.join(", ")}.`;
}

function cloudFields(fields: readonly string[]): string[] {
  const friendly: string[] = [];
  for (const field of fields) {
    const name = FIELD_NAMES.find(([re]) => re.test(field))?.[1] ?? field;
    if (!friendly.includes(name)) friendly.push(name);
  }
  const order = FIELD_NAMES.map(([, n]) => n);
  return friendly.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
}

/** A wallet's MCP request fields: its tool arguments by name, then the tool name and the JSON-RPC envelope, every logged field named. */
function walletFields(fields: readonly string[]): string[] {
  const args: string[] = [];
  const rest: string[] = [];
  let envelope = false;
  for (const field of fields) {
    if (field.startsWith("params.arguments.")) args.push(field.slice("params.arguments.".length));
    else if (field === "params.name") rest.unshift("tool name");
    else if (field === "jsonrpc" || field === "id" || field === "method") envelope = true;
    else rest.push(field);
  }
  return [...args, ...rest, ...(envelope ? ["MCP envelope (jsonrpc, id, method)"] : [])];
}

/** A call's argument names (`checkout_id`), or its other field names; values are in `-v`. */
function argumentNames(a: Activity): string {
  const fields = walletFields([...new Set(a.requests.flatMap((r) => r.field_names))]).filter((f) => !f.startsWith("MCP envelope") && f !== "tool name");
  return fields.join(", ");
}

/** `Shop wallet linked`, `Shop wallet unlinked · token revoked at Shop`, `… · token not revoked (deleted here only)`. */
export function walletWords(f: Activity["facts"], sep: string): string {
  const rail = destinationLabel(f.wallet_rail ?? "");
  const revoked = f.wallet_action !== "unlinked" ? "" : f.revoked === true ? `token revoked at ${rail}` : f.revoked === false ? "token not revoked (deleted here only)" : "";
  return [`${rail} wallet ${f.wallet_action ?? ""}`.trim(), revoked].filter((v) => v !== "").join(sep);
}

function counts(summary: ActivitySummary, shown: number, total: number, g: Glyphs, paint: (tone: Tone, s: string) => string): string {
  const a = summary.actions;
  const r = summary.requests;
  const parts: string[] = [];
  const add = (n: number, one: string, many: string, tone: Tone = null): void => {
    if (n > 0) parts.push(paint(tone, plural(n, one, many)));
  };
  add(a.search, "search", "searches");
  add(a.cart, "cart", "carts");
  add(a.status, "status check", "status checks");
  add(a.approval, "approval", "approvals");
  add(a.call, "wallet call", "wallet calls");
  add(a.wallet, "wallet change", "wallet changes");
  add(a.blocked, "blocked", "blocked", "bad");
  add(summary.refused, "refused", "refused", "bad");
  add(a.flagged, "flagged", "flagged", "bad");
  add(r.acknowledged, "receipt", "receipts", "good");
  add(r.answered, "answered unsigned", "answered unsigned");
  add(r.unacknowledged, "sent without receipt", "sent without receipt", "warn");
  add(r.not_sent, "not sent", "not sent", "warn");
  add(r.maybe_sent, "maybe sent", "maybe sent", "warn");
  add(r.discarded, "discarded", "discarded", "bad");
  const head = paint("bold", shown === total ? plural(shown, "action", "actions") : `${String(shown)} of ${plural(total, "action", "actions")} (filtered)`);
  return [head, ...parts].join(` ${g.dot} `);
}

function receiptWord(n: number): string {
  return n <= 1 ? "receipt" : `${String(n)} receipts`;
}

function names(a: Activity): string {
  const fields = [...new Set(a.requests.flatMap((r) => r.field_names))];
  return fields.length === 0 ? "no body fields" : fields.join(", ");
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** 12000 → `$120`; 4198 → `$41.98`. */
function money(minor: number, currency = "USD"): string {
  const amount = minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

/** `of_5mOmLPf8SX-9t4wK` → `of_5mOm…9t4wK`-style: enough to tell handles apart. */
function short(handle: string, g: Glyphs): string {
  return handle.length <= 14 ? handle : `${handle.slice(0, 7)}${g.more}${handle.slice(-4)}`;
}

/** `63e7 074d … 2240` → `63e7…2240`. */
function fingerprint(fp: string, g: Glyphs): string {
  const groups = fp.split(" ").filter((x) => x !== "");
  return groups.length <= 2 ? fp : `${groups[0] ?? ""}${g.more}${groups.at(-1) ?? ""}`;
}

function cut(text: string, width: number, g: Glyphs): string {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - g.more.length)) + g.more;
}

/** Cuts a painted line to `columns` visible characters (escape codes do not count). */
function fit(line: string, columns: number, g: Glyphs): string {
  // eslint-disable-next-line no-control-regex
  const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
  if (visible.length <= columns) return line;
  let out = "";
  let seen = 0;
  // eslint-disable-next-line no-control-regex
  for (const part of line.split(/(\u001b\[[0-9;]*m)/)) {
    if (part.startsWith("\u001b[")) {
      out += part;
      continue;
    }
    const room = columns - g.more.length - seen;
    if (room <= 0) continue;
    out += part.slice(0, room);
    seen += Math.min(part.length, room);
  }
  return `${out}${g.more}${line.includes("\u001b[") ? "\u001b[0m" : ""}`;
}

function painter(style: TimelineStyle): (tone: Tone, s: string) => string {
  const codes: Record<Exclude<Tone, null>, string> = {
    good: "32",
    warn: "33",
    bad: "31",
    sage: style.truecolor === true ? "1;38;2;175;201;181" : "1;36",
    dim: "2",
    bold: "1",
  };
  // Painted text is made printable first, so the only escape codes in a line are the ones added here.
  return (tone, raw) => {
    const s = printable(raw);
    return style.color && tone !== null && s !== "" ? `\u001b[${codes[tone]}m${s}\u001b[0m` : s;
  };
}

function parts(ts: string, style: TimelineStyle, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const zone = style.utc === true ? "UTC" : style.timeZone;
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { ...(zone === undefined ? {} : { timeZone: zone }), ...options }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
}

/** `Friday 16 October 2026`, in the local zone (or UTC with --utc). */
export function dayHeader(ts: string, style: TimelineStyle): string {
  if (Number.isNaN(Date.parse(ts))) return "";
  const p = parts(ts, style, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return `${String(p.weekday)} ${String(p.day)} ${String(p.month)} ${String(p.year)}${style.utc === true ? " (UTC)" : ""}`;
}

/** `10:26:37`. */
function clockTime(ts: string, style: TimelineStyle): string {
  if (Number.isNaN(Date.parse(ts))) return ts.slice(0, 8).padEnd(8);
  const p = parts(ts, style, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return `${String(p.hour)}:${String(p.minute)}:${String(p.second)}`;
}
