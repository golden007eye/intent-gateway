// `intent log`: the local hash chain, one line per entry, field by field: what was sent (field names, never
// values), what was blocked, what Intent Cloud acknowledged receiving, what got no answer or was discarded, and
// the approvals and approver pins. It says what the gateway sent and what came back, nothing more (invariant 5).
// formatLog is pure; the golden test pins its output.
import { INTENT } from "../config/index.ts";
import { neverLeft, readChain, verifyChain } from "../store/index.ts";

type Body = Record<string, unknown>;

/** The entry kinds that answer a disclosure, naming it by `disclosure_seq`. */
const FOLLOW_UPS: ReadonlySet<string> = new Set(["receipt", "unacknowledged", "discarded"]);

interface Item {
  seq: number;
  ts: string;
  kind: string;
  body: Body;
}

export function formatLog(items: readonly unknown[]): string {
  if (items.length === 0) {
    return `No entries yet: the gateway has sent nothing. Start it with ${INTENT} serve, or try ${INTENT} demo.\n`;
  }
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
    const item = asItem(raw);
    if (item === null) {
      lines.push(`line ${String(index + 1)}: not an entry (a torn or edited line); run ${INTENT} verify`);
      continue;
    }
    const [label, detail] =
      item.kind !== "disclosure"
        ? describe(item, demo)
        : notSent.has(item.seq)
          ? notSentRow(item)
          : answered.has(item.seq)
            ? describe(item, demo)
            : unansweredRow(item);
    lines.push(`#${String(item.seq).padEnd(4)} ${item.ts}  ${label.padEnd(14)} ${detail}`);
  }
  const chain = verifyChain(items);
  const last = asItem(items.at(-1));
  const head = last === null ? "" : `, head seq ${String(last.seq)}`;
  lines.push("");
  lines.push(
    chain.ok
      ? `${String(items.length)} entries, every hash links${head}. ${INTENT} verify re-checks the receipts and approvals.`
      : `the chain breaks at seq ${String(chain.brokenSeq)} (${chain.reason}); run ${INTENT} verify`,
  );
  return lines.join("\n") + "\n";
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
function notSentRow(item: Item): [string, string] {
  return ["logged", `${text(item.body.endpoint)}: ${list(leafFields(strings(item.body.fields)), "no body fields")} (not sent: no connection was made)`];
}

/**
 * A disclosure no entry answers: logged before the send, which may have left, and then the gateway stopped before it
 * recorded an answer (or it is still waiting for one).
 */
function unansweredRow(item: Item): [string, string] {
  const fields = list(leafFields(strings(item.body.fields)), "no body fields");
  return ["logged", `${text(item.body.endpoint)}: ${fields} (maybe sent; no answer recorded: the gateway stopped before it finished, or is still waiting)`];
}

function describe(item: Item, demo: boolean): [string, string] {
  const b = item.body;
  const ref = typeof b.disclosure_seq === "number" ? `#${String(b.disclosure_seq)}` : "#?";
  switch (item.kind) {
    case "disclosure":
      return ["sent", `${text(b.endpoint)}: ${list(leafFields(strings(b.fields)), "no body fields")}`];
    case "block":
      return ["blocked", `${text(b.endpoint)}: held back ${list(strings(b.blocked), "(no reason recorded)")}; nothing was sent`];
    case "receipt": {
      const how = b.verified === true ? "signature verified" : `signature checked by ${INTENT} verify`;
      const who = demo ? "the local demo Intent Cloud acknowledged receiving it (demo chain, test keys)" : "Intent Cloud acknowledged receiving it";
      return ["receipt", `${ref}: ${who} (status ${typeof b.status === "number" ? String(b.status) : "?"}, ${how})`];
    }
    case "unacknowledged":
      return neverLeft(b)
        ? ["not sent", `${ref}: ${text(b.reason)}; it never left this machine`]
        : ["no receipt", `${ref}: ${text(b.reason)}; it may or may not have arrived`];
    case "discarded":
      return ["discarded", `${ref}: ${text(b.reason)}; the response was not used`];
    case "keys": {
      const statement = record(b.statement);
      return ["key statement", `${text(statement.kid)} signed keys valid until ${text(statement.expires_at)}`];
    }
    case "approval_pending": {
      const total = typeof b.total_minor === "number" ? ` for $${(b.total_minor / 100).toFixed(2)}` : "";
      return ["approval asked", `${text(b.handle)}${total}: ${text(b.approval_url)}`];
    }
    case "approval":
      return ["approved", `${text(b.handle)}: passkey proof verified`];
    case "approver_pin":
      return ["approver pin", text(b.fingerprint)];
    case "approver_flag":
      return b.reason === "sign_count"
        ? ["FLAGGED", `${text(b.fingerprint)} signed with a signature counter that did not go up; the passkey may have been copied`]
        : ["FLAGGED", `${text(b.fingerprint)} is not the pinned approver; if it is your passkey, run ${INTENT} approver accept`];
    case "session":
      return ["session", text(b.keyid)];
    default:
      return [item.kind, ""];
  }
}

/** `ship_to` and `ship_to.postal_code` → `ship_to.postal_code`: only the fields that carry a value. */
function leafFields(fields: readonly string[]): string[] {
  return fields.filter((f) => !fields.some((other) => other.startsWith(`${f}.`) || other.startsWith(`${f}[]`)));
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
