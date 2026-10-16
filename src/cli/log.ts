// `intent log`: the local hash chain, one line per entry, field by field: what was sent (field names, never
// values), what was blocked, what Intent Cloud acknowledged receiving, what got no answer or was discarded, and
// the approvals and approver pins. It says what the gateway sent and what came back, nothing more (invariant 5).
// formatLog is pure; the golden test pins its output.
import { INTENT } from "../config/index.ts";
import { readChain, verifyChain } from "../store/index.ts";

type Body = Record<string, unknown>;

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
  for (const [index, raw] of items.entries()) {
    const item = asItem(raw);
    if (item === null) {
      lines.push(`line ${String(index + 1)}: not an entry (a torn or edited line); run ${INTENT} verify`);
      continue;
    }
    const [label, detail] = describe(item);
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

function describe(item: Item): [string, string] {
  const b = item.body;
  const ref = typeof b.disclosure_seq === "number" ? `#${String(b.disclosure_seq)}` : "#?";
  switch (item.kind) {
    case "disclosure":
      return ["sent", `${text(b.endpoint)}: ${list(leafFields(strings(b.fields)), "no body fields")}`];
    case "block":
      return ["blocked", `${text(b.endpoint)}: held back ${list(strings(b.blocked), "(no reason recorded)")}; nothing was sent`];
    case "receipt": {
      const how = b.verified === true ? "signature verified" : `signature checked by ${INTENT} verify`;
      return ["receipt", `${ref}: Intent Cloud acknowledged receiving it (status ${typeof b.status === "number" ? String(b.status) : "?"}, ${how})`];
    }
    case "unacknowledged":
      return ["no receipt", `${ref}: ${text(b.reason)}; it may or may not have arrived`];
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
