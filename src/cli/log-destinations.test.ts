// `intent log` on a chain written by the real disclosure core with a wallet destination (ADR-0014): a Shop call reads
// "answered" with its status, never "maybe sent" or "receipt"; an identity block and a logging refusal say why and
// "nothing sent", with no value; wallet entries say linked or unlinked and whether the token was revoked; and the
// "Sent to … only" lines name Intent Cloud and Shop apart (invariant 5). Attack cases: the bearer and refresh tokens
// and the blocked email never print; a redaction marker prints as "redacted"; a hand-edited chain holding a
// credential in clear never prints it, in any view.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDisclosedCloud,
  createDisclosedWallet,
  type DestinationTransport,
  DisclosureBlockedError,
  DisclosureRefusedError,
  type IntentCloud,
} from "../disclosure/index.ts";
import { buildModel, renderPage } from "../panel/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { formatJson, formatLog, formatVerbose, readLog } from "./log.ts";

const TS = Date.parse("2026-10-16T17:26:37.000Z");
const TOKEN = "shop-access-token-SECRET-0123456789";
const REFRESH = "shop-refresh-token-SECRET-9876543210";
const EMAIL = "jane.buyer@example.com";
const sha8 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const SEARCH = { category: "lamps", ship_to: { country: "US", postal_code: "94103" } };
const rpc = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const STYLE = { color: false, utc: true } as const;

/** A Shop transport answering each operation with a status; `path` puts a query on every request. */
function shopTransport(status: (operation: string) => number, path = "/api/mcp"): DestinationTransport {
  return {
    prepare: (operation, payload) => ({
      operation,
      method: "POST",
      path,
      headers: [
        ["host", "shop.example"],
        ["authorization", `Bearer ${TOKEN}`],
        ["content-type", "application/json"],
      ],
      body: Buffer.from(JSON.stringify(payload), "utf8"),
    }),
    send: (request) => Promise.resolve({ status: status(request.operation), headers: [], body: Buffer.from('{"result":{"buyer":"kept out"}}', "utf8") }),
  };
}

const unreachableCloud = new Proxy({} as IntentCloud, { get: () => () => Promise.reject(new Error("the Intent Cloud adapter was called")) });

let store: Store | null = null;
afterEach(async () => {
  await store?.close().catch(() => undefined);
  store = null;
});

/** An Intent Cloud search with its receipt, the Shop wallet linked, two Shop calls, an identity block, a logging refusal, two unlinks. */
async function writeWalletFlow(): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), "log-dest-")), "data");
  let second = 0;
  store = await openStore(dir, { clock: () => TS + (second += 1000) });
  const search = await store.append("disclosure", {
    endpoint: "searchCatalog",
    method: "POST",
    path: "/v1/catalog/search",
    fields: ["category", "ship_to", "ship_to.country", "ship_to.postal_code"],
    body_b64: b64(SEARCH),
    content_digest: "sha-256=:x:",
    keyid: "gw-k",
  });
  await store.append("receipt", { disclosure_seq: search.seq, status: 200, verified: true });
  await store.append("wallet", { rail: "shop", action: "linked", revoked: false });
  const cloud = createDisclosedCloud(unreachableCloud, store, { keySet: () => null });
  const shop = createDisclosedWallet(
    shopTransport((op) => (op === "refresh" ? 401 : 200)),
    cloud,
    { destination: "shop" },
  );
  await shop.call("get_checkout", rpc("get_checkout", { checkout_id: "co_123" }));
  await shop.call("refresh", rpc("refresh", { refresh_token: REFRESH }));
  await expect(shop.call("search", rpc("search", { note: EMAIL }))).rejects.toBeInstanceOf(DisclosureBlockedError);
  const leaky = createDisclosedWallet(shopTransport(() => 200, "/api/mcp?access_token=abc"), cloud, { destination: "shop" });
  await expect(leaky.call("search", rpc("search", { q: "lamp" }))).rejects.toBeInstanceOf(DisclosureRefusedError);
  await store.append("wallet", { rail: "shop", action: "unlinked", revoked: true });
  await store.append("wallet", { rail: "shop", action: "unlinked", revoked: false });
  await store.close();
  store = null;
  return dir;
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describe("intent log: repeated calls", () => {
  it("shows the same call answered the same way back to back as one line with its count; -v and --json keep each", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "log-repeat-")), "data");
    let second = 0;
    store = await openStore(dir, { clock: () => TS + (second += 5000) });
    const cloud = createDisclosedCloud(unreachableCloud, store, { keySet: () => null });
    // A Shop sign-in waits: the token request is polled, answered 400 until the person approves, then 200.
    let polls = 0;
    const shop = createDisclosedWallet(shopTransport((op) => (op === "token" && ++polls <= 3 ? 400 : 200)), cloud, { destination: "shop" });
    for (let i = 0; i < 4; i++) await shop.call("token", rpc("token", { device_code: "d" }));
    await shop.call("get_checkout", rpc("get_checkout", { checkout_id: "co_1" }));
    await store.close();
    store = null;
    const items = readLog(dir);
    const out = formatLog(items, { style: STYLE, intent: "intent", dataDir: "/data" });
    const calls = out.split("\n").filter((l) => l.includes("  call  "));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/Shop token · device_code +⚠ answered 400 \(no signed receipt\) ×3, until \d\d:\d\d:\d\d$/);
    // The 200 that ended the wait is its own line, and so is a different call.
    expect(calls[1]).toMatch(/Shop token · device_code +✓ answered 200 \(no signed receipt\)$/);
    expect(calls[2]).toMatch(/Shop get_checkout · checkout_id +✓ answered 200 \(no signed receipt\)$/);
    // The counts still count each call.
    expect(out).toContain("5 wallet calls");
    expect(formatJson(items).trim().split("\n").filter((l) => l.includes('"action":"call"'))).toHaveLength(5);
  });

  /** Two identical token calls (answered 400), with `between` appended after the first. */
  async function twoCalls(between: (s: Store) => Promise<unknown>, destinations: readonly [string, string] = ["shop", "shop"]): Promise<unknown[]> {
    const dir = join(mkdtempSync(join(tmpdir(), "log-repeat-")), "data");
    let second = 0;
    store = await openStore(dir, { clock: () => TS + (second += 5000) });
    const cloud = createDisclosedCloud(unreachableCloud, store, { keySet: () => null });
    const [first, other] = destinations;
    await createDisclosedWallet(shopTransport(() => 400), cloud, { destination: first }).call("token", rpc("token", { device_code: "d" }));
    await between(store);
    await createDisclosedWallet(shopTransport(() => 400), cloud, { destination: other }).call("token", rpc("token", { device_code: "d" }));
    await store.close();
    store = null;
    return readLog(dir);
  }
  const callRows = (out: string) => out.split("\n").filter((l) => l.includes("  call  "));

  it("attack: two identical calls with another entry between them stay two rows, also when that entry shows no row", async () => {
    // A demo session entry opens no row of its own: on screen the calls are back to back, in the log they are not.
    const items = await twoCalls((s) => s.append("session", { mode: "demo", id: "x" }));
    const rows = callRows(formatLog(items, { style: STYLE, intent: "intent", dataDir: "/data" }));
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).not.toContain("×");
  });

  it("attack: two identical calls that a filter puts side by side stay two rows", async () => {
    const items = await twoCalls((s) => s.append("wallet", { rail: "shop", action: "linked", revoked: false }));
    // Unfiltered, the wallet row sits between them; --action call hides it.
    const out = formatLog(items, { style: STYLE, intent: "intent", dataDir: "/data", actions: new Set(["call"]) });
    expect(out).not.toContain("wallet linked");
    expect(callRows(out)).toHaveLength(2);
    expect(out).not.toContain("×");
  });

  it("attack: identical calls to two destinations that read alike in words stay two rows", async () => {
    // `shop_accounts` and `Shop accounts` are both written "Shop accounts"; they are still two destinations. The gateway
    // writes only lower-case names, so the second comes from a chain edited by hand, which `intent log` still reads.
    const items = (await twoCalls(() => Promise.resolve(), ["shop_accounts", "shop_accounts"])) as { kind: string; body: Record<string, unknown> }[];
    const disclosures = items.filter((i) => i.kind === "disclosure");
    expect(disclosures).toHaveLength(2);
    const edited = disclosures[1];
    if (edited !== undefined) edited.body.destination = "Shop accounts";
    const rows = callRows(formatLog(items, { style: STYLE, intent: "intent", dataDir: "/data" }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.includes("Shop accounts token"))).toBe(true);
    expect(rows.join("\n")).not.toContain("×");
  });
});

describe("intent log: wallet destinations, refusals and wallet entries", () => {
  it("the timeline: a Shop call is answered with its status, blocks say nothing sent, each destination has its own Sent line", async () => {
    const items = readLog(await writeWalletFlow());
    const out = formatLog(items, { style: STYLE, intent: "intent", dataDir: "/data" });
    expect(out).toContain("call      Shop get_checkout · checkout_id");
    expect(out).toContain("✓ answered 200 (no signed receipt)");
    expect(out).toContain("⚠ answered 401 (no signed receipt)");
    expect(out).toContain("Shop search: an email address (in note)");
    expect(out).toContain("Shop search: not logged as sent: a credential in the query (access_token), which the log cannot digest");
    expect(out).toContain("Shop wallet linked");
    expect(out).toContain("Shop wallet unlinked · token revoked at Shop");
    expect(out).toContain("Shop wallet unlinked · token not revoked (deleted here only)");
    expect(out).toContain("Sent to Intent Cloud only: category, ZIP code, country.");
    expect(out).toContain("Sent to Shop only: checkout_id, refresh_token, tool name, MCP envelope (jsonrpc, id, method), 2 credentials (in the log as digests).");
    // A Shop call has an answer recorded: never "maybe sent", and never a receipt it does not have.
    expect(out).not.toMatch(/maybe sent/);
    expect(out.match(/✓ receipt/g)?.length).toBe(1);
    expect(out).toMatchSnapshot();
  });

  it("-v lists the response entry and shows credentials as redacted digests, never as values", async () => {
    const items = readLog(await writeWalletFlow());
    const out = formatVerbose(items, { style: STYLE });
    expect(out).toContain("sent           to Shop: get_checkout:");
    expect(out).toMatch(/response\s+#\d+: answered \(status 401, 31 bytes; no receipt: the destination signs none\)/);
    expect(out).toContain(`params.arguments.refresh_token = redacted (sha256 ${sha8(REFRESH)}…)`);
    expect(out).toContain(`header authorization: redacted (sha256 ${sha8(`Bearer ${TOKEN}`)}…)`);
    expect(out).toMatch(/response seq \d+: status 200, 31 bytes, body sha256 [0-9a-f]{8}…; Shop signs no receipt/);
    expect(out).toContain("blocked        to Shop: search: held back email at $.params.arguments.note; nothing was sent");
    expect(out.replace(uuid, "<session>")).toMatchSnapshot();
  });

  it("--json: the call's destination, delivery answered, the response size and digest, the redactions; no secret", async () => {
    const items = readLog(await writeWalletFlow());
    const lines = formatJson(items).trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const calls = lines.filter((l) => l.action === "call") as { outcome: string; facts: Record<string, unknown>; requests: Record<string, unknown>[] }[];
    expect(calls.map((c) => [c.facts.destination, c.facts.endpoint, c.outcome])).toEqual([
      ["shop", "get_checkout", "answered"],
      ["shop", "refresh", "answered"],
    ]);
    const request = calls[1]?.requests[0] as { destination: string; delivery: string; response: Record<string, unknown>; redacted: { at: string }[] };
    expect(request.destination).toBe("shop");
    expect(request.delivery).toBe("answered");
    expect(request.response).toMatchObject({ kind: "response", status: 401, bytes: 31, acknowledged: false, receipt_kid: null });
    expect(request.redacted.map((r) => r.at)).toEqual(["headers.authorization", "body.params.arguments.refresh_token"]);
    const blocks = lines.filter((l) => l.action === "blocked").map((l) => l.facts);
    expect(blocks).toEqual([
      { endpoint: "search", destination: "shop", block_kind: "identity", field_names: ["id", "jsonrpc", "method", "params.arguments.note", "params.name"] },
      { endpoint: "search", destination: "shop", block_kind: "logging", field_names: ["id", "jsonrpc", "method", "params.arguments.q", "params.name"] },
    ]);
  });

  it("attack: no view prints the bearer token, the refresh token or the blocked email", async () => {
    const items = readLog(await writeWalletFlow());
    for (const out of [formatLog(items, { style: STYLE }), formatVerbose(items, { style: STYLE }), formatJson(items)]) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(REFRESH);
      expect(out).not.toContain(EMAIL);
    }
  });

  it("attack: a hand-edited chain with a credential in clear, and an identity block given a value, never prints them", () => {
    const leak = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refresh", arguments: { refresh_token: REFRESH } } };
    const items = [
      { seq: 0, prev: "", ts: "2026-10-16T17:26:37.000Z", kind: "disclosure", hash: "", body: { endpoint: "refresh", destination: "shop", method: "POST", path: "/api/mcp", fields: ["params.arguments.refresh_token"], body_b64: b64(leak), headers: [["authorization", `Bearer ${TOKEN}`]], content_digest: "sha-256=:x:" } },
      { seq: 1, prev: "", ts: "2026-10-16T17:26:38.000Z", kind: "response", hash: "", body: { disclosure_seq: 0, status: 200, body_sha256: "0".repeat(64), bytes: 2 } },
      { seq: 2, prev: "", ts: "2026-10-16T17:26:39.000Z", kind: "block", hash: "", body: { endpoint: "search", destination: "shop", fields: ["params.arguments.note"], blocked: ["email at $.params.arguments.note"], held: { note: EMAIL } } },
    ];
    for (const out of [formatLog(items, { style: STYLE }), formatVerbose(items, { style: STYLE }), formatJson(items)]) {
      expect(out).not.toContain(REFRESH);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(EMAIL);
    }
    expect(formatVerbose(items, { style: STYLE })).toContain('params.arguments.refresh_token = "[a credential in clear, not shown: intent verify fails this entry]"');
  });

  it("attack: a token inside a JSON-text value under a plain key is in the chain as sent (ADR-0014) but no view prints it", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "log-nested-")), "data");
    store = await openStore(dir, { clock: () => TS });
    const cloud = createDisclosedCloud(unreachableCloud, store, { keySet: () => null });
    const shop = createDisclosedWallet(shopTransport(() => 200), cloud, { destination: "shop" });
    const state = JSON.stringify({ step: 2, auth: { sessionToken: REFRESH } });
    await shop.call("x", rpc("x", { state, list: [JSON.stringify([{ access_token: TOKEN }])], plain: '{"note":"kept"}' }));
    await store.close();
    store = null;
    // The limit, pinned: the core redacts by key, not inside string values, so the chain holds the token as sent.
    const items = readLog(dir);
    const sentB64 = (items as { kind: string; body: { body_b64?: string } }[]).find((i) => i.kind === "disclosure")?.body.body_b64 ?? "";
    expect(Buffer.from(sentB64, "base64").toString("utf8")).toContain(REFRESH);
    const verbose = formatVerbose(items, { style: STYLE });
    for (const out of [formatLog(items, { style: STYLE }), verbose, formatJson(items), renderPage(buildModel({ items, now: TS, mode: "real", intent: "intent", policy: null, verify: null, timeZone: "UTC" }))]) {
      expect(out).not.toContain(REFRESH);
      expect(out).not.toContain(TOKEN);
    }
    expect(verbose).toContain('params.arguments.state = "[JSON text holding a credential, not shown]"');
    expect(verbose).toContain('params.arguments.list = "[JSON text holding a credential, not shown]"');
    // JSON text with no secret key prints as sent.
    expect(verbose).toContain('params.arguments.plain = "{\\"note\\":\\"kept\\"}"');
  });

  it("attack: a value nested 20 000 levels deep (a hand-edited chain) does not crash any view; it shows as too deep", () => {
    const depth = 20_000;
    const deepBody = `{"params":{"arguments":{"q":"lamp","deep":${"[".repeat(depth)}${"]".repeat(depth)},"text":${JSON.stringify(`${"[".repeat(depth)}${"]".repeat(depth)}`)}}}}`;
    const items = [
      { seq: 0, prev: "", ts: "2026-10-16T17:26:37.000Z", kind: "disclosure", hash: "", body: { endpoint: "x", destination: "shop", method: "POST", path: "/api/mcp", fields: ["params.arguments.q"], body_b64: Buffer.from(deepBody).toString("base64"), headers: [], content_digest: "sha-256=:x:" } },
      { seq: 1, prev: "", ts: "2026-10-16T17:26:38.000Z", kind: "response", hash: "", body: { disclosure_seq: 0, status: 200, body_sha256: "0".repeat(64), bytes: 2 } },
    ];
    const page = () => renderPage(buildModel({ items, now: TS, mode: "real", intent: "intent", policy: null, verify: null, timeZone: "UTC" }));
    for (const view of [() => formatLog(items, { style: STYLE }), () => formatVerbose(items, { style: STYLE }), () => formatJson(items), page]) {
      expect(view).not.toThrow();
    }
    const verbose = formatVerbose(items, { style: STYLE });
    expect(verbose).toContain('params.arguments.q = "lamp"');
    expect(verbose).toContain("[nested too deep, not shown]");
  });
});

describe("intent log: form bodies and the block's rule", () => {
  /** A Shop OAuth-style transport: form-encoded bodies, written by `write` (URLSearchParams by default). */
  function formTransport(write: (payload: Record<string, string>) => string = (p) => new URLSearchParams(p).toString()): DestinationTransport {
    return {
      prepare: (operation, payload) => ({
        operation,
        method: "POST",
        path: "/oauth/token",
        headers: [
          ["host", "shop.example"],
          ["content-type", "application/x-www-form-urlencoded"],
        ],
        body: Buffer.from(write(payload as Record<string, string>), "utf8"),
      }),
      send: () => Promise.resolve({ status: 200, headers: [], body: Buffer.from("{}", "utf8") }),
    };
  }

  async function writeFormFlow(): Promise<unknown[]> {
    const dir = join(mkdtempSync(join(tmpdir(), "log-form-")), "data");
    let second = 0;
    store = await openStore(dir, { clock: () => TS + (second += 1000) });
    const cloud = createDisclosedCloud(unreachableCloud, store, { keySet: () => null });
    const accounts = createDisclosedWallet(formTransport(), cloud, { destination: "shop_accounts" });
    await accounts.call("refresh", { grant_type: "refresh_token", refresh_token: REFRESH, client_id: "intent-gateway" });
    // A repeated name: what the core parses (the last value) is not what is sent, so it is refused.
    const repeated = createDisclosedWallet(
      formTransport(() => "grant_type=refresh_token&client_id=a&client_id=b"),
      cloud,
      { destination: "shop_accounts" },
    );
    await expect(repeated.call("refresh", {})).rejects.toBeInstanceOf(DisclosureRefusedError);
    await store.close();
    store = null;
    return readLog(dir);
  }

  it("a form body shows its non-secret values; its secret only as redacted", async () => {
    const items = await writeFormFlow();
    const out = formatVerbose(items, { style: STYLE });
    expect(out).toContain('client_id = "intent-gateway"');
    expect(out).toContain('grant_type = "refresh_token"');
    expect(out).toContain(`refresh_token = redacted (sha256 ${sha8(REFRESH)}…)`);
    expect(out).not.toContain("(value not logged)");
    for (const view of [out, formatLog(items, { style: STYLE }), formatJson(items)]) expect(view).not.toContain(REFRESH);
  });

  it("the core writes rule: logging on a refusal, so the form-body reason shows as not logged as sent", async () => {
    const items = await writeFormFlow();
    const block = (items as { kind: string; body: Record<string, unknown> }[]).find((i) => i.kind === "block");
    expect(block?.body.rule).toBe("logging");
    expect(formatLog(items, { style: STYLE })).toContain("Shop accounts refresh: not logged as sent: the form body is not written as the gateway writes it");
  });

  it("attack: a forged rule: policy on an identity block shows no held value in the timeline, -v, --json or the panel", () => {
    const items = [
      {
        seq: 0,
        prev: "",
        ts: "2026-10-16T17:26:30.000Z",
        kind: "block",
        hash: "",
        body: { endpoint: "search", destination: "shop", fields: ["x"], blocked: ["email at $.x"], held: { x: EMAIL }, rule: "policy" },
      },
    ];
    const json = formatJson(items);
    expect((JSON.parse(json) as { facts: { block_kind: string } }).facts.block_kind).toBe("identity");
    const page = renderPage(buildModel({ items, now: TS, mode: "real", intent: "intent", policy: null, verify: null, timeZone: "UTC" }));
    for (const view of [formatLog(items, { style: STYLE }), formatVerbose(items, { style: STYLE }), json, page]) expect(view).not.toContain(EMAIL);
  });

  it("an old-format chain: the golden fixture's identity block without rule still reads as identity, with no value", () => {
    const golden = readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "disclosure-golden.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; body: Record<string, unknown> });
    const old = golden.map((e) => (e.kind === "block" ? { ...e, body: Object.fromEntries(Object.entries(e.body).filter(([k]) => k !== "rule")) } : e));
    const blocks = formatJson(old)
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { action: string; facts: Record<string, unknown> })
      .filter((a) => a.action === "blocked");
    expect(blocks.map((b) => [b.facts.block_kind, b.facts.held])).toEqual([["identity", undefined]]);
    expect(formatLog(old, { style: STYLE })).toContain("search: an email address (in product)");
  });

  it("a block's rule wins over its wording; an unknown rule shows no value; a block without rule is read from its reasons", () => {
    const at = (seq: number, body: Record<string, unknown>) => ({ seq, prev: "", ts: `2026-10-16T17:26:3${String(seq)}.000Z`, kind: "block", hash: "", body });
    const items = [
      at(0, { endpoint: "search", destination: "shop", fields: [], blocked: ["some future wording"], rule: "logging" }),
      at(1, { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"], held: { category: EMAIL }, rule: "something-new" }),
      at(2, { endpoint: "search", destination: "shop", fields: [], blocked: ["a credential in the query (access_token), which the log cannot digest"] }),
      at(3, { endpoint: "searchCatalog", fields: ["category"], blocked: ["categories.block at category"], held: { category: "alcohol" } }),
    ];
    const kinds = formatJson(items).trimEnd().split("\n").map((l) => (JSON.parse(l) as { facts: { block_kind: string } }).facts.block_kind);
    expect(kinds).toEqual(["logging", "identity", "logging", "policy"]);
    const out = formatLog(items, { style: STYLE });
    expect(out).toContain("Shop search: not logged as sent: some future wording");
    expect(out).not.toContain(EMAIL);
    expect(out).toContain('search for "alcohol"');
  });
});
