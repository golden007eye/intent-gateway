// `intent log`: the local hash chain. By default one line per entry, field by field: what was sent (field names),
// what was blocked, what Intent Cloud acknowledged receiving, what got no answer or was discarded, and the approvals
// and approver pins. `--verbose` groups the entries by action (activity's model) with the values each request sent,
// its endpoint, digest and keyid; `--json` prints that model, one action per line. It says what the gateway sent and
// what came back, nothing more (invariant 5); `intent verify` re-checks the chain and every signature.
// The formatters are pure; the golden tests pin their output.
import { type Activity, type ActivityFilter, buildActivity, filterActivity, leafFields } from "../activity/index.ts";
import { INTENT } from "../config/index.ts";
import { neverLeft, readChain, verifyChain } from "../store/index.ts";
import { type Io, line, type Outcome } from "./io.ts";

type Body = Record<string, unknown>;

/** The entry kinds that answer a disclosure, naming it by `disclosure_seq`. */
const FOLLOW_UPS: ReadonlySet<string> = new Set(["receipt", "unacknowledged", "discarded"]);

/** The version of the `--json` line format (docs/log.md). */
export const LOG_JSON_VERSION = 1;

interface Item {
  seq: number;
  ts: string;
  kind: string;
  body: Body;
}

export interface LogStyle {
  /** ANSI colour (a terminal, no NO_COLOR, no --no-color). */
  readonly color: boolean;
  /** --utc: times in UTC; otherwise in `timeZone` (the local zone when absent). */
  readonly utc?: boolean;
  /** For tests: the zone local times are shown in. */
  readonly timeZone?: string;
}

export interface LogOptions extends ActivityFilter {
  readonly style?: LogStyle;
}

const PLAIN: LogStyle = { color: false };

type Tone = "good" | "warn" | "bad" | null;
const TONES: Record<Exclude<Tone, null>, string> = { good: "32", warn: "33", bad: "31" };

function paint(style: LogStyle, tone: Tone, s: string): string {
  return style.color && tone !== null ? `\u001b[${TONES[tone]}m${s}\u001b[0m` : s;
}

/** The filter without --last, which only limits what is printed first. */
function withoutLast(filter: ActivityFilter): ActivityFilter {
  return { ...(filter.since === undefined ? {} : { since: filter.since }), ...(filter.actions === undefined ? {} : { actions: filter.actions }) };
}

function filtering(options: ActivityFilter): boolean {
  return options.since !== undefined || options.actions !== undefined || options.last !== undefined;
}

/** The entries of the chain, one line each; with a filter, only the entries of the actions it keeps. */
export function formatLog(items: readonly unknown[], options: LogOptions = {}): string {
  if (items.length === 0) {
    return `No entries yet: the gateway has sent nothing. Start it with ${INTENT} serve, or try ${INTENT} demo.\n`;
  }
  const style = options.style ?? PLAIN;
  const all = buildActivity(items).activities;
  const kept = filterActivity(all, options);
  const keep = filtering(options) ? new Set(kept.flatMap((a) => a.seqs)) : null;
  const lines: string[] = entryLines(items, style, keep);
  if (keep !== null) lines.push("", shown(kept, all));
  lines.push("", chainLine(items));
  return lines.join("\n") + "\n";
}

/** Each entry from index `from` as one line (`keep` limits them to some seqs; unreadable lines are always listed). */
function entryLines(items: readonly unknown[], style: LogStyle, keep: ReadonlySet<number> | null, from = 0): string[] {
  const lines: string[] = [];
  const demo = demoChain(items);
  // Logged requests that never left (no connection was made): listed as logged, not as sent (invariant 5).
  const notSent = new Set<unknown>();
  // Disclosures some entry answers; one no entry answers is logged and maybe sent, with no answer recorded.
  const answered = new Set<unknown>();
  for (const raw of items) {
    const item = asItem(raw);
    if (item?.kind === "unacknowledged" && neverLeft(item.body)) notSent.add(item.body.disclosure_seq);
    if (item !== null && FOLLOW_UPS.has(item.kind)) answered.add(item.body.disclosure_seq);
  }
  for (const [index, raw] of items.entries()) {
    if (index < from) continue;
    const item = asItem(raw);
    if (item === null) {
      lines.push(`line ${String(index + 1)}: not an entry (a torn or edited line); run ${INTENT} verify`);
      continue;
    }
    if (keep !== null && !keep.has(item.seq)) continue;
    const [label, detail, tone] = entryRow(item, demo, notSent, answered);
    lines.push(`#${String(item.seq).padEnd(4)} ${item.ts}  ${paint(style, tone, label.padEnd(14))} ${detail}`);
  }
  return lines;
}

function entryRow(item: Item, demo: boolean, notSent: ReadonlySet<unknown>, answered: ReadonlySet<unknown>): [string, string, Tone] {
  if (item.kind !== "disclosure") return describe(item, demo);
  if (notSent.has(item.seq)) return notSentRow(item);
  if (answered.has(item.seq)) return describe(item, demo);
  return unansweredRow(item);
}

function chainLine(items: readonly unknown[]): string {
  const chain = verifyChain(items);
  const last = asItem(items.at(-1));
  const head = last === null ? "" : `, head seq ${String(last.seq)}`;
  return chain.ok
    ? `${String(items.length)} entries, every hash links${head}. ${INTENT} verify re-checks the receipts and approvals.`
    : `the chain breaks at seq ${String(chain.brokenSeq)} (${chain.reason}); run ${INTENT} verify`;
}

function shown(kept: readonly Activity[], all: readonly Activity[]): string {
  const n = (k: number) => `${String(k)} action${k === 1 ? "" : "s"}`;
  return `showing ${n(kept.length)} of ${String(all.length)} (filtered)`;
}

/** `--verbose`: each action, then every entry it covers, with the values each request sent. */
export function formatVerbose(items: readonly unknown[], options: LogOptions = {}): string {
  if (items.length === 0) return formatLog(items);
  const style = options.style ?? PLAIN;
  const all = buildActivity(items).activities;
  const kept = filterActivity(all, options);
  const lines: string[] = [];
  for (const activity of kept) lines.push(...verboseLines(items, activity, style), "");
  if (filtering(options)) lines.push(shown(kept, all));
  lines.push(chainLine(items));
  return lines.join("\n") + "\n";
}

/** One action of `--verbose`. Exported for `--follow`. */
export function verboseLines(items: readonly unknown[], activity: Activity, style: LogStyle): string[] {
  if (activity.action === "unreadable") {
    return [`line ${String(activity.facts.line ?? "?")}: not an entry (a torn or edited line); run ${INTENT} verify`];
  }
  const seqs = activity.seqs.length === 1 ? `seq ${String(activity.seq)}` : `seq ${String(activity.seqs[0])}-${String(activity.seqs.at(-1))}`;
  const head = `${clock(activity.time, style)}  ${activity.action}  ${seqs}  ${paint(style, outcomeTone(activity.outcome), activity.outcome.replace("_", " "))}`;
  const lines = [head];
  const demo = demoChain(items);
  const notSent = new Set<unknown>();
  const answered = new Set<unknown>();
  for (const r of activity.requests) {
    if (r.delivery === "not_sent") notSent.add(r.seq);
    if (r.response !== null) answered.add(r.seq);
  }
  const bySeq = new Map(items.map((raw) => asItem(raw)).flatMap((i) => (i === null ? [] : [[i.seq, i] as const])));
  for (const seq of activity.seqs) {
    const item = bySeq.get(seq);
    if (item === undefined) continue;
    const [label, detail, tone] = entryRow(item, demo, notSent, answered);
    lines.push(`  #${String(seq).padEnd(4)} ${paint(style, tone, label.padEnd(14))} ${detail}`);
    const request = activity.requests.find((r) => r.seq === seq);
    if (request !== undefined) {
      const pad = " ".repeat(22);
      lines.push(`${pad}${request.method ?? "?"} ${request.path ?? "?"}`);
      if (request.fields === null) {
        lines.push(`${pad}values: not in this entry (no body bytes logged)`);
      } else if (Object.keys(request.fields).length === 0) {
        lines.push(`${pad}values: none (no body)`);
      } else {
        lines.push(`${pad}values in the logged request:`);
        for (const [name, value] of Object.entries(request.fields)) lines.push(`${pad}  ${name} = ${JSON.stringify(value)}`);
      }
      if (request.content_digest !== null) lines.push(`${pad}content-digest ${request.content_digest}`);
      lines.push(`${pad}keyid ${request.keyid ?? "none (unsigned request)"}`);
      const response = request.response;
      if (response?.kind === "receipt") {
        const checked = response.signature_checked ? "signature checked when logged" : `signature not checked when logged; ${INTENT} verify checks it`;
        lines.push(`${pad}receipt seq ${String(response.seq)}: status ${String(response.status ?? "?")}, receipt key ${response.receipt_kid ?? "?"}, ${checked}`);
      }
    }
  }
  return lines;
}

/** `--json`: one action per line (docs/log.md). */
export function formatJson(items: readonly unknown[], options: ActivityFilter = {}): string {
  return filterActivity(buildActivity(items).activities, options)
    .map((a) => jsonLine(a) + "\n")
    .join("");
}

export function jsonLine(activity: Activity): string {
  const { time, seq, seqs, action, outcome, facts, blocked, requests } = activity;
  return JSON.stringify({ v: LOG_JSON_VERSION, time, seq, seqs, action, outcome, facts, blocked, requests });
}

function outcomeTone(outcome: Activity["outcome"]): Tone {
  switch (outcome) {
    case "acknowledged":
    case "approved":
    case "pinned":
      return "good";
    case "unacknowledged":
    case "maybe_sent":
    case "not_sent":
    case "approval_asked":
      return "warn";
    case "discarded":
    case "blocked":
    case "refused":
    case "flagged":
    case "unreadable":
      return "bad";
    default:
      return null;
  }
}

/** `2026-10-16 12:20:25` in the local zone (or `timeZone`), or `2026-10-16 19:20:25 UTC` with --utc. */
export function clock(ts: string, style: LogStyle): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const zone = style.utc === true ? "UTC" : style.timeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      ...(zone === undefined ? {} : { timeZone: zone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${String(parts.year)}-${String(parts.month)}-${String(parts.day)} ${String(parts.hour)}:${String(parts.minute)}:${String(parts.second)}${style.utc === true ? " UTC" : ""}`;
}

/** Reads the chain in `dataDir`; a missing chain is an empty one. */
export function readLog(dataDir: string): unknown[] {
  try {
    return readChain(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Whether the chain was written in demo mode: its first entry is the demo `session` entry `{mode: "demo"}`. */
function demoChain(items: readonly unknown[]): boolean {
  const first = asItem(items[0]);
  return first?.kind === "session" && first.body.mode === "demo";
}

/** A disclosure whose request never left: logged before the send, which then failed to connect. */
function notSentRow(item: Item): [string, string, Tone] {
  return ["logged", `${text(item.body.endpoint)}: ${list(leafFields(strings(item.body.fields)), "no body fields")} (not sent: no connection was made)`, "warn"];
}

/**
 * A disclosure no entry answers: logged before the send, which may have left, and then the gateway stopped before it
 * recorded an answer (or it is still waiting for one).
 */
function unansweredRow(item: Item): [string, string, Tone] {
  const fields = list(leafFields(strings(item.body.fields)), "no body fields");
  return ["logged", `${text(item.body.endpoint)}: ${fields} (maybe sent; no answer recorded: the gateway stopped before it finished, or is still waiting)`, "warn"];
}

function describe(item: Item, demo: boolean): [string, string, Tone] {
  const b = item.body;
  const ref = typeof b.disclosure_seq === "number" ? `#${String(b.disclosure_seq)}` : "#?";
  switch (item.kind) {
    case "disclosure":
      return ["sent", `${text(b.endpoint)}: ${list(leafFields(strings(b.fields)), "no body fields")}`, null];
    case "block":
      return ["blocked", `${text(b.endpoint)}: held back ${list(strings(b.blocked), "(no reason recorded)")}; nothing was sent`, "bad"];
    case "receipt": {
      const how = b.verified === true ? "signature verified" : `signature checked by ${INTENT} verify`;
      const who = demo ? "the local demo Intent Cloud acknowledged receiving it (demo chain, test keys)" : "Intent Cloud acknowledged receiving it";
      return ["receipt", `${ref}: ${who} (status ${typeof b.status === "number" ? String(b.status) : "?"}, ${how})`, "good"];
    }
    case "unacknowledged":
      return neverLeft(b)
        ? ["not sent", `${ref}: ${text(b.reason)}; it never left this machine`, "warn"]
        : ["no receipt", `${ref}: ${text(b.reason)}; it may or may not have arrived`, "warn"];
    case "discarded":
      return ["discarded", `${ref}: ${text(b.reason)}; the response was not used`, "bad"];
    case "keys": {
      const statement = record(b.statement);
      return ["key statement", `${text(statement.kid)} signed keys valid until ${text(statement.expires_at)}`, null];
    }
    case "approval_pending": {
      const total = typeof b.total_minor === "number" ? ` for $${(b.total_minor / 100).toFixed(2)}` : "";
      return ["approval asked", `${text(b.handle)}${total}: ${text(b.approval_url)}`, null];
    }
    case "approval":
      return ["approved", `${text(b.handle)}: passkey proof verified`, "good"];
    case "approver_pin":
      return ["approver pin", text(b.fingerprint), null];
    case "approver_flag":
      return b.reason === "sign_count"
        ? ["FLAGGED", `${text(b.fingerprint)} signed with a signature counter that did not go up; the passkey may have been copied`, "bad"]
        : ["FLAGGED", `${text(b.fingerprint)} is not the pinned approver; if it is your passkey, run ${INTENT} approver accept`, "bad"];
    case "session":
      return ["session", b.mode === "demo" ? "demo chain (test keys, sample catalog)" : `gateway session ${text(b.id)} started (a local id, never sent)`, null];
    default:
      return [item.kind, "", null];
  }
}

function asItem(raw: unknown): Item | null {
  const r = record(raw);
  if (typeof r.seq !== "number" || typeof r.ts !== "string" || typeof r.kind !== "string") return null;
  return { seq: r.seq, ts: r.ts, kind: r.kind, body: record(r.body) };
}

function record(value: unknown): Body {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Body) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function list(values: readonly string[], none: string): string {
  return values.length === 0 ? none : values.join(", ");
}

// ---- the command ------------------------------------------------------------------------------------------------

export interface LogFlags {
  readonly verbose: boolean;
  readonly json: boolean;
  readonly follow: boolean;
  readonly filter: ActivityFilter;
  readonly style: LogStyle;
}

/** `intent log [...]`: prints the chain once; with --follow, then prints what is appended until stopped. */
export function logCommand(io: Io, dataDir: string, flags: LogFlags): Outcome {
  const items = readLog(dataDir);
  const options: LogOptions = { ...flags.filter, style: flags.style };
  io.stdout.write(flags.json ? formatJson(items, flags.filter) : flags.verbose ? formatVerbose(items, options) : formatLog(items, options));
  if (!flags.follow) return { code: 0 };
  line(io.stderr, `following ${dataDir}; Ctrl-C stops`);
  const tail = flags.json || flags.verbose ? actionTail(items, flags) : entryTail(items, flags);
  const timer = setInterval(() => {
    try {
      const now = readLog(dataDir);
      // A last line still being written is torn: wait for the next poll.
      if (typeof now.at(-1) === "string") now.pop();
      const text = tail(now);
      if (text !== "") io.stdout.write(text);
    } catch (error) {
      line(io.stderr, `intent: cannot read the chain in ${dataDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, io.followMs ?? 500);
  return {
    code: 0,
    stop: () => {
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}

/** Default view: each new entry once, as one line, labelled by what the chain holds at the time it is printed. */
function entryTail(start: readonly unknown[], flags: LogFlags): (items: readonly unknown[]) => string {
  let printed = start.length;
  return (items) => {
    if (items.length <= printed) return "";
    const fresh = new Set(items.slice(printed).flatMap((raw) => asItem(raw)?.seq ?? []));
    let keep = fresh;
    if (filtering(flags.filter)) {
      const kept = filterActivity(buildActivity(items).activities, withoutLast(flags.filter)).flatMap((a) => a.seqs);
      keep = new Set(kept.filter((s) => fresh.has(s)));
    }
    const lines = entryLines(items, flags.style, keep, printed);
    printed = items.length;
    return lines.map((l) => l + "\n").join("");
  };
}

/**
 * --json and --verbose: an action is printed once it is not the last one, or once it has stayed the same for one
 * poll with every request answered. An action that grows after it was printed (a late answer) is printed again,
 * with the same seq.
 */
function actionTail(start: readonly unknown[], flags: LogFlags): (items: readonly unknown[]) => string {
  const printed = new Map<number, number>(buildActivity(start).activities.map((a) => [a.seq, a.seqs.length]));
  let previousLast: string | null = null;
  return (items) => {
    const activities = filterActivity(buildActivity(items).activities, withoutLast(flags.filter)).filter((a) => a.action !== "unreadable");
    const out: string[] = [];
    for (const [index, activity] of activities.entries()) {
      if (printed.get(activity.seq) === activity.seqs.length) continue;
      const isLast = index === activities.length - 1;
      const key = activity.seqs.join(",");
      const settled = !isLast || (key === previousLast && activity.requests.every((r) => r.response !== null));
      if (isLast) previousLast = key;
      if (!settled) continue;
      printed.set(activity.seq, activity.seqs.length);
      out.push(flags.json ? jsonLine(activity) : [...verboseLines(items, activity, flags.style), ""].join("\n"));
    }
    return out.map((l) => l + "\n").join("");
  };
}
