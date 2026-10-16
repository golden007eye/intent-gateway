// `intent log` modes and flags through the Io seam: --verbose and --json goldens on a chain with every action,
// demo and real, filters (--since, --action, --last), colour only on a terminal (NO_COLOR, --no-color, TERM=dumb),
// --utc, usage errors, and --follow.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_SESSION } from "../gateway/index.ts";
import { type Entry, NOT_SENT_REASON, openStore } from "../store/index.ts";
import { type Io, main } from "./index.ts";
import { clock } from "./log.ts";

const TS = Date.parse("2026-10-16T17:26:37.000Z");
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const receiptHeader = Buffer.from(JSON.stringify({ kid: "cloud-receipt-202610" })).toString("base64url");
const SEARCH_FIELDS = ["category", "must_haves", "budget_max", "budget_max.amount_minor", "budget_max.currency", "ship_to", "ship_to.country", "ship_to.postal_code"];
const SEARCH = { category: "running shoes", must_haves: ["road"], budget_max: { amount_minor: 12000, currency: "USD" }, ship_to: { country: "US", postal_code: "94103" } };
const CART = { offer_handle: "of_abc", quantity: 1, ship_to: { country: "US", postal_code: "94103" } };

function disclosure(endpoint: string, method: string, path: string, body: unknown, fields: string[] = []) {
  return { endpoint, method, path, fields, body_b64: body === null ? "" : b64(body), content_digest: "sha-256=:x:", keyid: method === "GET" && endpoint !== "getApproval" ? null : "gw-k" };
}

/** Every action `intent log` groups, one minute apart: search, blocked, cart, status, approval, unacknowledged, not sent, maybe sent. */
async function writeFlow(dir: string, demo: boolean): Promise<void> {
  let minute = 0;
  const store = await openStore(dir, { clock: () => TS + minute * 60_000 });
  const append = (kind: Entry["kind"], body: unknown) => store.append(kind, body);
  if (demo) await append("session", DEMO_SESSION);
  const o = demo ? 1 : 0;
  await append("keys", { statement: { kid: "cloud-root-1", expires_at: "2027-01-14T00:00:00Z" } });
  minute = 1;
  await append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH, SEARCH_FIELDS));
  await append("receipt", { disclosure_seq: 1 + o, status: 200, verified: true, receipt_header: receiptHeader });
  minute = 2;
  await append("block", { endpoint: "searchCatalog", fields: ["category", "ship_to", "ship_to.postal_code"], blocked: ["categories.block at category"] });
  minute = 3;
  await append("disclosure", disclosure("createCart", "POST", "/v1/carts", CART, ["offer_handle", "quantity", "ship_to", "ship_to.country", "ship_to.postal_code"]));
  await append("receipt", { disclosure_seq: 4 + o, status: 201, verified: true, receipt_header: receiptHeader });
  await append("disclosure", disclosure("createApproval", "POST", "/v1/carts/ct_1/approvals", null));
  await append("receipt", { disclosure_seq: 6 + o, status: 201, verified: true, receipt_header: receiptHeader });
  await append("approval_pending", { handle: "ap_1", approval_url: "http://127.0.0.1:8788/confirm/c/x", total_minor: 4198 });
  minute = 4;
  await append("disclosure", disclosure("getApproval", "GET", "/v1/approvals/ap_1", null));
  await append("receipt", { disclosure_seq: 9 + o, status: 200, verified: true, receipt_header: receiptHeader });
  await append("approver_pin", { fingerprint: "aaaa 1111", handle: "ap_1" });
  await append("approval", { handle: "ap_1" });
  minute = 5;
  await append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH, SEARCH_FIELDS));
  await append("unacknowledged", { disclosure_seq: 13 + o, reason: "CloudNetworkError: timeout" });
  minute = 6;
  await append("disclosure", disclosure("getApproval", "GET", "/v1/approvals/ap_1", null));
  await append("unacknowledged", { disclosure_seq: 15 + o, reason: `${NOT_SENT_REASON} (DNS: not found)` });
  minute = 7;
  await append("disclosure", disclosure("searchCatalog", "POST", "/v1/catalog/search", SEARCH, SEARCH_FIELDS));
  await store.close();
}

interface Run {
  code: number;
  out: string;
  err: string;
  stop?: () => Promise<void>;
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function setup(env: Record<string, string> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "log-")), "data");
  const out: string[] = [];
  return {
    dir,
    out,
    async run(argv: string[], options: { tty?: boolean; env?: Record<string, string>; io?: Partial<Io> } = {}): Promise<Run> {
      out.length = 0;
      const err: string[] = [];
      const tty = options.tty ?? false;
      const io: Io = {
        env: { INTENT_DATA_DIR: dir, ...env, ...options.env },
        stdin: new PassThrough(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        isTTY: { stdin: tty, stdout: tty },
        now: () => TS + 10 * 60_000,
        ...options.io,
      };
      const outcome = await main(argv, io);
      if (outcome.stop !== undefined) stops.push(outcome.stop);
      return { code: outcome.code, out: out.join(""), err: err.join(""), ...(outcome.stop === undefined ? {} : { stop: outcome.stop }) };
    },
  };
}

describe("intent log --verbose and --json (golden)", () => {
  it("--verbose groups the entries by action, with the values each request sent, its digest, keyid and receipt key", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    const result = await s.run(["log", "-v", "--utc"]);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out).toMatchSnapshot();
  });

  it("--json prints one action per line, the activity model with v: 1", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    const result = await s.run(["log", "--json"]);
    expect(result).toMatchObject({ code: 0, err: "" });
    const lines = result.out.trimEnd().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => [p.action, p.outcome])).toEqual([
      ["keys", "recorded"],
      ["search", "acknowledged"],
      ["blocked", "blocked"],
      ["cart", "approval_asked"],
      ["status", "acknowledged"],
      ["approval", "approved"],
      ["search", "unacknowledged"],
      ["status", "not_sent"],
      ["search", "maybe_sent"],
    ]);
    for (const p of parsed) expect(Object.keys(p)).toEqual(["v", "time", "seq", "seqs", "action", "outcome", "facts", "blocked", "requests"]);
    expect(result.out).toMatchSnapshot();
  });

  it("on a demo chain the receipt line names the local demo Intent Cloud and its test keys", async () => {
    const s = setup();
    await writeFlow(join(s.dir, "demo"), true);
    const result = await s.run(["log", "--demo", "-v", "--utc", "--action", "search"]);
    expect(result.out).toContain("the local demo Intent Cloud acknowledged receiving it (demo chain, test keys)");
    expect(result.out).not.toMatch(/: Intent Cloud acknowledged/);
    const json = await s.run(["log", "--demo", "--json"]);
    expect(json.out.split("\n")[0]).toContain('"action":"keys"');
  });

  it("an empty chain prints nothing for --json and the empty line for --verbose", async () => {
    const s = setup();
    expect((await s.run(["log", "--json"])).out).toBe("");
    expect((await s.run(["log", "-v"])).out).toMatch(/^No entries yet/);
  });
});

describe("intent log filters", () => {
  it("--action keeps those actions; the default view then lists only their entries and says it is filtered", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    const result = await s.run(["log", "--action", "blocked,approval"]);
    expect(result.out.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      "#3    2026-10-16T17:28:37.000Z  blocked        searchCatalog: held back categories.block at category; nothing was sent",
      "#11   2026-10-16T17:30:37.000Z  approver pin   aaaa 1111",
      "#12   2026-10-16T17:30:37.000Z  approved       ap_1: passkey proof verified",
    ]);
    expect(result.out).toContain("\nshowing 2 actions of 9 (filtered)\n");
    expect(result.out).toMatch(/18 entries, every hash links, head seq 17\./);
  });

  it("--since takes a duration before now or a date; --last N keeps the last N actions", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    // now is 17:36:37; 5m back is 17:31:37, so the actions at minutes 5, 6 and 7.
    const since = await s.run(["log", "--json", "--since", "5m"]);
    expect(since.out.trimEnd().split("\n").map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([13, 15, 17]);
    const date = await s.run(["log", "--json", "--since", "2026-10-16T17:30:00Z"]);
    expect(date.out.trimEnd().split("\n")).toHaveLength(5);
    const day = await s.run(["log", "--json", "--since", "2026-10-17", "--utc"]);
    expect(day.out).toBe("");
    const last = await s.run(["log", "--json", "--last", "2"]);
    expect(last.out.trimEnd().split("\n").map((l) => (JSON.parse(l) as { action: string }).action)).toEqual(["status", "search"]);
  });

  it.each([
    [["--since", "yesterday"], /^intent: --since takes a duration \(30m, 2h, 7d\) or a date .+, not "yesterday"; run intent --help\n$/],
    [["--action", "buy"], /^intent: --action takes one or more of start, keys, search, cart, status, approval, blocked, pin, flagged \(comma-separated\), not "buy"; run intent --help\n$/],
    [["--last", "0"], /^intent: --last takes a whole number of actions \(1 or more\), not "0"; run intent --help\n$/],
    [["--last"], /^intent: option --last for log needs a value; run intent --help\n$/],
  ])("refuses %j with one line and exit 2", async (args, message) => {
    const result = await setup().run(["log", ...args]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
  });
});

describe("intent log colour and time", () => {
  const ESC = "\u001b[";

  it("colours the labels on a terminal only, and never with NO_COLOR, --no-color or TERM=dumb", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    const tty = await s.run(["log"], { tty: true });
    expect(tty.out).toContain(`${ESC}32mreceipt       ${ESC}0m`);
    expect(tty.out).toContain(`${ESC}31mblocked       ${ESC}0m`);
    expect(tty.out).toContain(`${ESC}33mno receipt    ${ESC}0m`);
    expect((await s.run(["log", "-v"], { tty: true })).out).toContain(`${ESC}33mapproval asked${ESC}0m`);
    expect((await s.run(["log"])).out).not.toContain(ESC);
    expect((await s.run(["log"], { tty: true, env: { NO_COLOR: "1" } })).out).not.toContain(ESC);
    expect((await s.run(["log", "--no-color"], { tty: true })).out).not.toContain(ESC);
    expect((await s.run(["log", "-v"], { tty: true, env: { TERM: "dumb" } })).out).not.toContain(ESC);
    // --json is for scripts: never coloured.
    expect((await s.run(["log", "--json"], { tty: true })).out).not.toContain(ESC);
  });

  it("--verbose shows local time, or UTC with --utc", () => {
    expect(clock("2026-10-16T17:26:37.000Z", { color: false, timeZone: "America/Los_Angeles" })).toBe("2026-10-16 10:26:37");
    expect(clock("2026-10-16T17:26:37.000Z", { color: false, utc: true })).toBe("2026-10-16 17:26:37 UTC");
    expect(clock("not a time", { color: false })).toBe("not a time");
  });
});

describe("intent log --follow", () => {
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  it("default view: prints each entry appended after the first print, once", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    const result = await s.run(["log", "--follow"], { io: { followMs: 10 } });
    expect(result.err).toBe(`following ${s.dir}; Ctrl-C stops\n`);
    const store = await openStore(s.dir, { clock: () => TS });
    await store.append("receipt", { disclosure_seq: 17, status: 200, verified: true });
    await store.close();
    await until(() => s.out.join("").includes("#18 "));
    await new Promise((r) => setTimeout(r, 50));
    const tail = s.out.join("").split("head seq 17. intent verify re-checks the receipts and approvals.\n")[1];
    expect(tail).toBe("#18   2026-10-16T17:26:37.000Z  receipt        #17: Intent Cloud acknowledged receiving it (status 200, signature verified)\n");
  });

  it("--json: prints a new action once it is answered and settled, and an action that grew again with its seq", async () => {
    const s = setup();
    await writeFlow(s.dir, false);
    const result = await s.run(["log", "--json", "--follow", "--action", "search,cart"], { io: { followMs: 10 } });
    const before = result.out;
    const store = await openStore(s.dir, { clock: () => TS });
    await store.append("receipt", { disclosure_seq: 17, status: 200, verified: true });
    await store.append("disclosure", disclosure("createCart", "POST", "/v1/carts", CART, ["offer_handle"]));
    await store.append("receipt", { disclosure_seq: 19, status: 201, verified: true });
    await store.append("block", { endpoint: "getApproval", fields: [], blocked: ["email at $.approval_handle"] });
    await store.close();
    await until(() => s.out.join("").includes('"seq":19'));
    await new Promise((r) => setTimeout(r, 50));
    const tail = s.out.join("").slice(before.length).trimEnd().split("\n").map((l) => JSON.parse(l) as { seq: number; outcome: string; action: string });
    // The maybe-sent search (seq 17) got its answer: printed again, now acknowledged; the new cart once; the block is filtered out.
    expect(tail.map((t) => [t.seq, t.action, t.outcome])).toEqual([
      [17, "search", "acknowledged"],
      [19, "cart", "acknowledged"],
    ]);
  });
});
