// Log before send to a wallet destination (ADR-0014; invariant 2 widened), through the same disclosure core as
// Intent Cloud. Attack cases: a failed append means the wallet transport's send is never called and the next Intent
// Cloud send is refused; a bearer token and a refresh token reach the wallet but never the chain; buyer identity in a
// wallet body is blocked before the log and the send.
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED } from "../../test/support/trust-kit.ts";
import { type Entry, neverLeft, openStore, type Store, type StoreFs } from "../store/index.ts";
import { runVerify } from "../verify/index.ts";
import {
  createDisclosedCloud,
  createDisclosedWallet,
  type DestinationTransport,
  DisclosureBlockedError,
  DisclosureConflictError,
  DisclosureRefusedError,
  DisclosureStoppedError,
  type IntentCloud,
  type OutboundRequest,
} from "./index.ts";

type Json = Record<string, unknown>;
const TOKEN = "shop-access-token-SECRET-0123456789";
const REFRESH = "shop-refresh-token-SECRET-9876543210";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const marker = (text: string) => `[redacted sha256:${sha(text)}]`;

interface Shape {
  headers?: [string, string][];
  path?: string;
  /** The body bytes for a payload; JSON.stringify by default. */
  bytes?: (payload: unknown) => string;
}

/** A JSON-RPC transport that records every request it was asked to send. */
function fakeTransport(
  reply: (request: OutboundRequest) => { status: number; body: string } | Error = () => ({ status: 200, body: '{"result":{}}' }),
  shape: Shape = {},
) {
  const sent: OutboundRequest[] = [];
  const transport: DestinationTransport = {
    prepare: (operation, payload) => ({
      operation,
      method: "POST",
      path: shape.path ?? "/api/mcp",
      headers: shape.headers ?? [
        ["host", "wallet.example"],
        ["authorization", `Bearer ${TOKEN}`],
        ["content-type", "application/json"],
      ],
      body: Buffer.from((shape.bytes ?? JSON.stringify)(payload), "utf8"),
    }),
    send: (request) => {
      sent.push(request);
      const answer = reply(request);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ status: answer.status, headers: [["content-type", "application/json"]], body: Buffer.from(answer.body, "utf8") });
    },
  };
  return { transport, sent };
}

/** An Intent Cloud adapter that must never be reached in these tests. */
const unreachableCloud = new Proxy({} as IntentCloud, {
  get: () => () => Promise.reject(new Error("the Intent Cloud adapter was called")),
});

// An MCP tool call: the identity check exempts `params.name` here (a tool name, never the buyer's).
const rpc = (name: string, args: Json) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

let store: Store;
let dir: string;
afterEach(async () => {
  await store.close().catch(() => undefined);
});

async function setup(fs?: StoreFs) {
  dir = join(await fsp.mkdtemp(join(tmpdir(), "wallet-")), "data");
  store = await openStore(dir, fs === undefined ? {} : { fs });
  return createDisclosedCloud(unreachableCloud, store, { keySet: () => null });
}

const bodyOf = (entry: Entry | undefined) => entry?.body as Json;
const logged = () => store.entries().filter((e) => e.kind !== "session");

describe("invariant 2 widened: log before send to a wallet destination", () => {
  it("logs the request with credentials digested before sending, then a response entry; the chain never holds the tokens", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport(() => ({ status: 200, body: '{"result":{"buyer":"kept out"}}' }));
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop_accounts", secretPaths: ["params.arguments.grant"] });
    const result = await shop.call("refresh", rpc("refresh", { refresh_token: REFRESH, grant: "g-123", note: null }), { purchase: "ap_TEST0001" });

    // What was sent is exactly what the transport prepared, secrets included.
    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0]?.body ?? []).toString("utf8")).toContain(REFRESH);
    expect(result).toMatchObject({ status: 200, disclosureSeq: 1 });

    expect(logged().map((e) => e.kind)).toEqual(["disclosure", "response"]);
    const [disclosure, response] = logged();
    const body = bodyOf(disclosure);
    expect(body).toMatchObject({
      endpoint: "refresh",
      destination: "shop_accounts",
      method: "POST",
      path: "/api/mcp",
      purchase: "ap_TEST0001",
      fields: ["id", "jsonrpc", "method", "params", "params.arguments", "params.arguments.grant", "params.arguments.note", "params.arguments.refresh_token", "params.name"],
    });
    expect(body["headers"]).toEqual([
      ["host", "wallet.example"],
      ["authorization", marker(`Bearer ${TOKEN}`)],
      ["content-type", "application/json"],
    ]);
    const loggedBody = JSON.parse(Buffer.from(body["body_b64"] as string, "base64").toString("utf8")) as Json;
    expect(loggedBody).toEqual(rpc("refresh", { refresh_token: marker(REFRESH), grant: marker("g-123"), note: null }));
    expect(body["redacted"]).toEqual([
      { at: "headers.authorization", sha256: sha(`Bearer ${TOKEN}`) },
      { at: "body.params.arguments.refresh_token", sha256: sha(REFRESH) },
      { at: "body.params.arguments.grant", sha256: sha("g-123") },
    ]);
    expect(bodyOf(response)).toEqual({
      disclosure_seq: disclosure?.seq,
      status: 200,
      body_sha256: sha('{"result":{"buyer":"kept out"}}'),
      bytes: 31,
    });

    // The bytes on disk: no token, no refresh token, no answer content; the purchase handle was never sent.
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    for (const secret of [TOKEN, REFRESH, "g-123", "kept out"]) expect(audit).not.toContain(secret);
    expect(Buffer.from(sent[0]?.body ?? []).toString("utf8")).not.toContain("ap_TEST0001");

    await store.close();
    const report = await runVerify({ dataDir: dir, pinnedRootKeys: PINNED, now: new Date(), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.counts).toMatchObject({ disclosures: 1, responses: 1, redactions: 3, unanswered: 0 });
  });

  it("attack: a failed disclosure append means the wallet send is never called, and the next Intent Cloud send is refused", async () => {
    let fail = false;
    const fs: StoreFs = {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args);
        if (String(args[0]).endsWith("audit.jsonl") && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) {
          const write = handle.write.bind(handle);
          return Object.assign(handle, {
            write: (...w: Parameters<typeof write>) => (fail ? Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })) : write(...w)),
          });
        }
        return handle;
      }),
    };
    const cloud = await setup(fs);
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await shop.call("search", rpc("search", { q: "lamp" })); // writes the session entry
    expect(sent).toHaveLength(1);
    fail = true;
    await expect(shop.call("get_checkout", rpc("get_checkout", { checkout_id: "co_1" }))).rejects.toThrow("ENOSPC");
    expect(sent).toHaveLength(1);
    fail = false;
    await expect(cloud.meta()).rejects.toBeInstanceOf(DisclosureStoppedError);
    await expect(shop.call("search", rpc("search", { q: "lamp" }))).rejects.toBeInstanceOf(DisclosureStoppedError);
    expect(sent).toHaveLength(1);
  });

  it("attack: a failed response append stops every destination; the disclosure stays the last of its session", async () => {
    let fail = false;
    const fs: StoreFs = {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args);
        if (String(args[0]).endsWith("audit.jsonl") && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) {
          const write = handle.write.bind(handle);
          return Object.assign(handle, {
            write: (...w: Parameters<typeof write>) => (fail ? Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })) : write(...w)),
          });
        }
        return handle;
      }),
    };
    const cloud = await setup(fs);
    const { transport, sent } = fakeTransport((request) => {
      fail = request.operation === "complete";
      return { status: 200, body: "{}" };
    });
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await expect(shop.call("complete", rpc("complete", { checkout_id: "co_1" }))).rejects.toBeInstanceOf(DisclosureStoppedError);
    expect(sent).toHaveLength(1);
    fail = false;
    await expect(cloud.meta()).rejects.toBeInstanceOf(DisclosureStoppedError);
    expect(logged().map((e) => e.kind)).toEqual(["disclosure"]);
  });

  it("attack: an email in a wallet body is a block entry naming the destination, and nothing is sent or logged as sent", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await expect(shop.call("search", rpc("search", { q: "gift for ada@example.com" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    expect(sent).toHaveLength(0);
    expect(store.entries().map((e) => e.kind)).toEqual(["block"]);
    expect(bodyOf(store.entries()[0])).toMatchObject({ endpoint: "search", destination: "shop", blocked: ["email at $.params.arguments.q"] });
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("ada@example.com");
  });

  it("logs no answer as unacknowledged, and a connection never made as not sent", async () => {
    const cloud = await setup();
    const failures = [Object.assign(new Error("refused"), { neverLeft: true, failure: "connection refused" }), Object.assign(new Error("reset"), { neverLeft: true }), new Error("reset")];
    const { transport } = fakeTransport(() => failures.shift() ?? new Error("none"));
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    for (let i = 0; i < 3; i += 1) await expect(shop.call("search", rpc("search", { q: "lamp" }))).rejects.toThrow();
    const follow = logged().filter((e) => e.kind === "unacknowledged");
    expect(follow.map((e) => bodyOf(e)["reason"])).toEqual([
      "CloudNetworkError: not sent (connection refused)",
      "CloudNetworkError: not sent (no connection)",
      "Error",
    ]);
    expect(follow.map((e) => neverLeft(e.body))).toEqual([true, true, false]);
  });

  it("shares the disclosed cloud's gateway session: one session entry, n counted across destinations", async () => {
    const cloud = await setup();
    const shop = createDisclosedWallet(fakeTransport().transport, cloud, { destination: "shop" });
    const accounts = createDisclosedWallet(fakeTransport().transport, cloud, { destination: "shop_accounts" });
    await shop.call("search", rpc("search", { q: "lamp" }));
    await accounts.call("token", { code: 1234, code_verifier: "v", items: [{ access_token: "a" }, { access_token: marker("b") }] });
    const sessions = store.entries().filter((e) => e.kind === "session");
    expect(sessions).toHaveLength(1);
    const marks = logged()
      .filter((e) => e.kind === "disclosure")
      .map((e) => (bodyOf(e)["session"] as Json)["n"]);
    expect(marks).toEqual([0, 1]);
    const token = logged().filter((e) => e.kind === "disclosure")[1];
    // A number is digested as its JSON text; a value that already is a marker is left as it is.
    expect(bodyOf(token)["redacted"]).toEqual([
      { at: "headers.authorization", sha256: sha(`Bearer ${TOKEN}`) },
      { at: "body.code", sha256: sha("1234") },
      { at: "body.code_verifier", sha256: sha("v") },
      { at: "body.items[0].access_token", sha256: sha("a") },
    ]);
  });

  it("refuses a bad destination, secret path or purchase handle, and a cloud the disclosure module did not build", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    expect(() => createDisclosedWallet(transport, cloud, { destination: "intent_cloud" })).toThrow(TypeError);
    expect(() => createDisclosedWallet(transport, cloud, { destination: "Shop Pay" })).toThrow(TypeError);
    expect(() => createDisclosedWallet(transport, cloud, { destination: "shop", secretPaths: ["a..b"] })).toThrow(TypeError);
    expect(() => createDisclosedWallet(transport, cloud, { destination: "shop", secretPaths: [""] })).toThrow(TypeError);
    expect(() => createDisclosedWallet(transport, { ...cloud }, { destination: "shop" })).toThrow("not a disclosed cloud");
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop", secretPaths: ['items[0]["a.b"]'] });
    await expect(shop.call("x", {}, { purchase: "free text with spaces" })).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
    await shop.call("x", { items: [{ "a.b": "s" }] });
    expect(bodyOf(logged()[0])["redacted"]).toContainEqual({ at: 'body.items[0]["a.b"]', sha256: sha("s") });
  });
});

describe("review fixes: wider redaction, refusals, the MCP tool name", () => {
  const audit = () => readFileSync(join(dir, "audit.jsonl"), "utf8");

  it("digests every credential header and every secret key spelling; none reaches audit.jsonl, and verify passes", async () => {
    const cloud = await setup();
    const secrets = {
      cookie: "session=COOKIE-SECRET-1",
      proxy: "Basic PROXY-SECRET-2",
      apiKeyHeader: "XKEY-SECRET-3",
      accessToken: "ACCESS-SECRET-4",
      refresh: "REFRESH-SECRET-5",
      password: "PASSWORD-SECRET-6",
      apiKey: "APIKEY-SECRET-7",
    };
    const { transport, sent } = fakeTransport(undefined, {
      headers: [
        ["host", "wallet.example"],
        ["Cookie", secrets.cookie],
        ["proxy-authorization", secrets.proxy],
        ["X-Api-Key", secrets.apiKeyHeader],
      ],
    });
    const accounts = createDisclosedWallet(transport, cloud, { destination: "shop_accounts" });
    await accounts.call("login", {
      accessToken: secrets.accessToken,
      Refresh_Token: secrets.refresh,
      password: secrets.password,
      api_key: secrets.apiKey,
      promo: { code: "SPRING10" },
    });
    expect(sent).toHaveLength(1);
    for (const value of Object.values(secrets)) {
      expect(Buffer.from(sent[0]?.body ?? []).toString("utf8") + JSON.stringify(sent[0]?.headers)).toContain(value);
      expect(audit()).not.toContain(value);
    }
    const body = bodyOf(logged()[0]);
    expect((body["redacted"] as { at: string }[]).map((r) => r.at)).toEqual([
      "headers.Cookie",
      "headers.proxy-authorization",
      "headers.X-Api-Key",
      "body.accessToken",
      "body.Refresh_Token",
      "body.password",
      "body.api_key",
    ]);
    // A promo `code` with no OAuth sibling is not a credential: it is logged as sent.
    const loggedBody = JSON.parse(Buffer.from(body["body_b64"] as string, "base64").toString("utf8")) as Json;
    expect(loggedBody["promo"]).toEqual({ code: "SPRING10" });
    // content_digest covers the logged body bytes (the sent bytes differ only at the redacted values).
    expect(body["content_digest"]).toBe(`sha-256=:${createHash("sha256").update(Buffer.from(body["body_b64"] as string, "base64")).digest("base64")}:`);
    await store.close();
    const report = await runVerify({ dataDir: dir, pinnedRootKeys: PINNED, now: new Date(), skipSupplyChain: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.counts.redactions).toBe(7);
  });

  it("attack: a secret in the query (?access_token=) is refused, never sent and never logged", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport(undefined, { path: "/api/mcp?client=gw&access_token=QUERY-SECRET" });
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await expect(shop.call("search", rpc("search", { q: "lamp" }))).rejects.toBeInstanceOf(DisclosureRefusedError);
    expect(sent).toHaveLength(0);
    expect(store.entries().map((e) => e.kind)).toEqual(["block"]);
    expect(bodyOf(store.entries()[0])).toMatchObject({ destination: "shop", blocked: ["a credential in the query (access_token), which the log cannot digest"] });
    expect(audit()).not.toContain("QUERY-SECRET");
  });

  it("attack: a duplicate key carrying an email (unseen by the parsed scan) is refused before the log and the send", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport(undefined, { bytes: () => '{"q":"ada@example.com","q":"lamp"}' });
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await expect(shop.call("search", {})).rejects.toBeInstanceOf(DisclosureRefusedError);
    expect(sent).toHaveLength(0);
    expect(store.entries().map((e) => e.kind)).toEqual(["block"]);
    expect(audit()).not.toContain("ada@example.com");
    // Spacing alone is refused too: the log must hold what is sent.
    const spaced = createDisclosedWallet(fakeTransport(undefined, { bytes: () => '{ "q": "lamp" }' }).transport, cloud, { destination: "shop" });
    await expect(spaced.call("search", {})).rejects.toBeInstanceOf(DisclosureRefusedError);
  });

  it("refuses a credential on an Intent Cloud request: Intent Cloud requests are never redacted", async () => {
    dir = join(await fsp.mkdtemp(join(tmpdir(), "wallet-")), "data");
    store = await openStore(dir);
    let reached = 0;
    const withCookie = {
      meta: async (options?: { beforeSend?: (r: OutboundRequest) => void | Promise<void> }) => {
        await options?.beforeSend?.({ operation: "getMeta", method: "GET", path: "/v1/meta", headers: [["cookie", "c=CLOUD-SECRET"]], body: new Uint8Array(0) });
        reached += 1;
        throw new Error("sent");
      },
    } as unknown as IntentCloud;
    const cloud = createDisclosedCloud(withCookie, store, { keySet: () => null });
    await expect(cloud.meta()).rejects.toBeInstanceOf(DisclosureRefusedError);
    expect(reached).toBe(0);
    expect(store.entries().map((e) => e.kind)).toEqual(["block"]);
    expect(audit()).not.toContain("CLOUD-SECRET");
  });

  it("lets an MCP tool name through under params.name only; every other name-like key still blocks", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await shop.call("search_catalog", rpc("search_catalog", { q: "lamp" }));
    expect(sent).toHaveLength(1);
    await expect(shop.call("x", rpc("search_catalog", { name: "Ada Lovelace" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    await expect(shop.call("x", rpc("Ada Lovelace", {}))).rejects.toBeInstanceOf(DisclosureBlockedError);
    await expect(shop.call("x", { ...rpc("search_catalog", {}), method: "tools/list" })).rejects.toBeInstanceOf(DisclosureBlockedError);
    // The value is still scanned: a card number shaped like a tool name blocks.
    await expect(shop.call("x", rpc("cc4111111111111111", {}))).rejects.toBeInstanceOf(DisclosureBlockedError);
    expect(sent).toHaveLength(1);
    expect(logged().filter((e) => e.kind === "block").map((e) => bodyOf(e)["blocked"])).toEqual([
      ["banned_key at $.params.arguments.name"],
      ["banned_key at $.params.name"],
      ["banned_key at $.params.name"],
      ["card at $.params.name"],
    ]);
  });
});

describe("compare-and-append on a wallet send (plan G7b step 6b)", () => {
  it("a send whose condition holds in the chain is neither logged nor sent; the core keeps sending, numbered without a gap", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await shop.call("get_checkout", rpc("get_checkout", { shop: "s" }), { purchase: "ap_TEST0001" });
    const blocked = shop.call("complete_checkout", rpc("complete_checkout", { shop: "s" }), { purchase: "ap_TEST0001", unless: () => true });
    await expect(blocked).rejects.toBeInstanceOf(DisclosureConflictError);
    expect(sent).toHaveLength(1);
    expect(logged().filter((e) => e.kind === "disclosure").map((e) => bodyOf(e).endpoint)).toEqual(["get_checkout"]);
    await shop.call("complete_checkout", rpc("complete_checkout", { shop: "s" }), { purchase: "ap_TEST0001", unless: () => false });
    expect(sent).toHaveLength(2);
    const numbers = logged().filter((e) => e.kind === "disclosure").map((e) => (bodyOf(e).session as { n: number }).n);
    expect(numbers).toEqual([0, 1]);
    expect(logged().filter((e) => e.kind === "disclosure").every((e) => bodyOf(e).purchase === "ap_TEST0001")).toBe(true);
  });
});

describe("L1: a lost send condition never stops the shared core", () => {
  it("two sends at once, the first losing its condition: the second is sent, numbered without a gap, and the core keeps sending", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    const [lost, won] = await Promise.allSettled([
      shop.call("complete_checkout", rpc("complete_checkout", { shop: "s" }), { purchase: "ap_TEST0001", unless: () => true }),
      shop.call("get_checkout", rpc("get_checkout", { shop: "s" }), { purchase: "ap_TEST0001" }),
    ]);
    expect(lost.status === "rejected" && lost.reason instanceof DisclosureConflictError).toBe(true);
    expect(won.status).toBe("fulfilled");
    await shop.call("get_checkout", rpc("get_checkout", { shop: "s" }), { purchase: "ap_TEST0001" });
    expect(sent).toHaveLength(2);
    const numbers = logged().filter((e) => e.kind === "disclosure").map((e) => (bodyOf(e).session as { n: number }).n);
    expect(numbers).toEqual([0, 1]);
  });

  it("a complete_checkout without its purchase or its condition is refused before anything is logged", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop" });
    await expect(shop.call("complete_checkout", rpc("complete_checkout", {}), { purchase: "ap_TEST0001" })).rejects.toBeInstanceOf(TypeError);
    await expect(shop.call("complete_checkout", rpc("complete_checkout", {}), { unless: () => false })).rejects.toBeInstanceOf(TypeError);
    expect(sent).toHaveLength(0);
    expect(logged()).toEqual([]);
  });
});

describe("opaque wallet ids (ADR-0019)", () => {
  const ID = /^gid:\/\/shopify\/Checkout\/[A-Za-z0-9]{1,128}(?:\?key=[A-Za-z0-9]{1,256})?$/;
  it("an id of the declared shape at its path passes the identity scan even when it reads as a card; elsewhere, or off-shape, it is blocked", async () => {
    const cloud = await setup();
    const { transport, sent } = fakeTransport();
    const shop = createDisclosedWallet(transport, cloud, { destination: "shop", opaqueIds: [{ path: "params.arguments.id", pattern: ID }] });
    await shop.call("get_checkout", rpc("get_checkout", { id: "gid://shopify/Checkout/4111111111111111?key=ab12" }));
    expect(sent).toHaveLength(1);
    await expect(shop.call("get_checkout", rpc("get_checkout", { other: "gid://shopify/Checkout/4111111111111111" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    await expect(shop.call("get_checkout", rpc("get_checkout", { id: "card 4111 1111 1111 1111" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    await expect(shop.call("get_checkout", rpc("get_checkout", { id: "gid://shopify/Checkout/x?key=a b jane@example.com" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    expect(sent).toHaveLength(1);
  });
});
