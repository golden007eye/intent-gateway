// The disclosure log in front of the real cloud adapter, against a local stub that records every byte it received.
// Invariant 2 (log before send): whenever the log append fails, 0 requests reach the stub; what is logged is byte for
// byte what the stub received. Invariant 3: identity in an outbound body is blocked before the log and the send.
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStubCloud, type StubCloud, type StubHandler, type StubReply } from "../../test/support/stub-cloud.ts";
import { PINNED, S1, signReceipt, STATEMENT_VALID_AT } from "../../test/support/trust-kit.ts";
import type { CartRequest, SearchRequest } from "../contract/index.ts";
import { createHttpCloud } from "../cloud/index.ts";
import { createSession } from "../signing/index.ts";
import { type Entry, neverLeft, openStore, type Store, StoreFencedError, type StoreFs, verifyChain } from "../store/index.ts";
import { type KeySet, verifyStatement } from "../trust/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  connectCloud,
  createDisclosedCloud,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
  type DisclosureOptions,
  DisclosureStoppedError,
  type IntentCloud,
} from "./index.ts";

vi.setConfig({ testTimeout: 20_000 });

type Json = Record<string, unknown>;
const vector = (name: string): Json =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", name), "utf8")) as Json;
const d1 = ((vector("d1-receipt.json")["cases"] as Json[])[0] as Json)["expected"] as Json;
// A genuine receipt, but for another request (vector d1's cart request): it must not verify for ours.
const FOREIGN_RECEIPT = { header: d1["intent_receipt"] as string, signature: d1["intent_receipt_signature"] as string };
const STATEMENT = (vector("s1-key-statement.json")["expected"] as Json)["statement"] as Json;

const NOW_MS = 1790251200_000;
const NOW_S = NOW_MS / 1000;
const USD = (amount_minor: number): Json => ({ amount_minor, currency: "USD" });
const MERCHANT = { name: "Example Shop", domain: "shop.example" };
const ITEM = { title: "Trail shoe", variant: "Size 10" };
const SEARCH: SearchRequest = { ship_to: { postal_code: "94110", country: "US" }, product: "trail shoe" };
const CART_REQUEST: CartRequest = { offer_handle: "of_TEST0001", quantity: 1, ship_to: { country: "US", postal_code: "94110" }, completer_keyid: createSession().keyid };
// A 16-digit, Luhn-valid SKU: findIdentity would call it a card if it scanned inbound bodies.
const SKU_TITLE = "Trail shoe SKU 4111111111111111";
const OFFER = {
  offer_handle: "of_TEST0001",
  merchant: MERCHANT,
  title: SKU_TITLE,
  variant: "Size 10",
  price: USD(8999),
  shipping: USD(0),
  total_kind: "exact",
  availability: "in_stock",
};

const BODIES: Readonly<Record<string, Json>> = {
  "/v1/meta": { contract_version: "1.5.0", contract_sums_sha256: "c".repeat(64), rule_versions: ["recheck-v1"] },
  "/v1/signature-keys": { keys: [{ kty: "OKP", crv: "Ed25519", kid: "cloud-receipt-202610", x: "JUO5L_EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0" }] },
  "/v1/key-statement": STATEMENT,
  "/v1/catalog/search": { offers: [OFFER] },
  "/v1/carts": {
    cart_handle: "ct_TEST0001",
    merchant: MERCHANT,
    item: ITEM,
    quantity: 1,
    unit_price: USD(8999),
    shipping: USD(0),
    total: USD(8999),
    total_kind: "exact",
    expires_at: "2026-09-24T12:30:00Z",
  },
  "/v1/carts/ct_TEST0001/approvals": {
    approval_handle: "ap_TEST0001",
    approval_link_path: "/c/abcdefghijklmnop",
    snapshot: {
      v: 3,
      approval: "ap_TEST0001",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      merchant: MERCHANT,
      item: ITEM,
      quantity: 1,
      unit_price: USD(8999),
      shipping: USD(0),
      total: USD(8999),
      total_kind: "exact",
      ship_to: { country: "US", postal_code: "94110" },
      continue_url_hash: `sha256:${"a".repeat(64)}`,
      rule_version: "recheck-v1",
      expires_at: "2026-09-24T12:30:00Z",
      merchant_origin: "https://shop.example",
      variant_ref: "gid://shopify/ProductVariant/1",
      checkout_ref_hash: `sha256:${"c".repeat(64)}`,
      completion_mode: "handoff",
      completer_keyid: CART_REQUEST.completer_keyid,
      total_estimated: false,
    },
    snapshot_hash: "b".repeat(64),
    check_code: "0123abcd",
    state: "pending",
    expires_at: "2026-09-24T12:30:00Z",
  },
  "/v1/approvals/ap_TEST0001": { state: "pending", display: { merchant: "Example Shop", title: "Trail shoe", total: USD(8999) } },
};
const STATUS: Readonly<Record<string, number>> = { "/v1/carts": 201, "/v1/carts/ct_TEST0001/approvals": 201 };

const VERSION: [string, string] = ["Intent-Contract-Version", "1.5.0"];
const FOREIGN_HEADERS: [string, string][] = [
  ["Intent-Receipt", FOREIGN_RECEIPT.header],
  ["Intent-Receipt-Signature", FOREIGN_RECEIPT.signature],
];
/** In a reply's header list: a receipt the test edge signs over the request it received and the reply's status. */
const SIGNED = "signed receipt";
type HeaderSpec = [string, string] | typeof SIGNED;

const statement = verifyStatement(S1.expected.statement, PINNED, STATEMENT_VALID_AT);
if (!statement.ok) throw new Error("s1 does not verify");
const KEYS: KeySet = statement.keySet;
const DISCLOSURE_NOW = () => STATEMENT_VALID_AT.getTime();

function edgeReceipt(req: Parameters<StubHandler>[0], status: number): [string, string][] {
  const signatureInput = String(req.headers["signature-input"] ?? "");
  const param = (name: string) => new RegExp(`;${name}=("?)([^";]*)\\1(?:;|$)`).exec(signatureInput)?.[2];
  const keyid = param("keyid");
  const nonce = param("nonce");
  const created = param("created");
  const request = {
    method: req.method,
    path: req.url,
    content_digest: req.headers["content-digest"],
    ...(keyid === undefined ? {} : { keyid }),
    ...(nonce === undefined ? {} : { nonce }),
    ...(created === undefined ? {} : { created: Number(created) }),
  };
  const signed = signReceipt({ v: 1, kid: "cloud-receipt-202610", request, status, received_at: "2026-10-15T12:00:01Z" });
  return [
    ["Intent-Receipt", signed.receipt],
    ["Intent-Receipt-Signature", signed.signature],
  ];
}
const JSON_TYPE: [string, string] = ["Content-Type", "application/json"];

/** The endpoint's success body, with the headers given (by default the version and both receipt headers). */
const reply =
  (headers: HeaderSpec[] = [VERSION, SIGNED, JSON_TYPE], over: Partial<StubReply> = {}): StubHandler =>
  (req) => {
    const status = over.status ?? STATUS[req.url ?? ""] ?? 200;
    return {
      status,
      headers: headers.flatMap((h) => (h === SIGNED ? edgeReceipt(req, status) : [h])),
      body: over.body ?? JSON.stringify(BODIES[req.url ?? ""] ?? {}),
    };
  };

const session = createSession();
let dir: string;
let stub: StubCloud;
let store: Store;

beforeEach(async () => {
  dir = join(await fsp.mkdtemp(join(tmpdir(), "disclosure-")), "data");
});
afterEach(async () => {
  await store.close().catch(() => undefined);
  await stub.close();
});

const trusted: DisclosureOptions = { keySet: () => KEYS, now: DISCLOSURE_NOW };

async function setup(handler: StubHandler = reply(), fs?: StoreFs, clock?: () => number, options = trusted) {
  stub = await startStubCloud(handler);
  store = await openStore(dir, { ...(fs === undefined ? {} : { fs }), ...(clock === undefined ? {} : { clock }) });
  return connectCloud({ baseUrl: stub.baseUrl, session, now: () => NOW_MS }, store, options);
}

// The chain without its `session` entries: each disclosed cloud starts its gateway session with one, at seq 0 here.
const logged = () => store.entries().filter((e) => e.kind !== "session");
const kinds = () => logged().map((e) => e.kind);
const bodyOf = (entry: Entry | undefined) => entry?.body as Json;
const logPath = () => join(dir, "audit.jsonl");
const errno = (code: string) => Object.assign(new Error(code), { code });

/** An fs whose append handles of the log are changed by `patch`. */
function patchedAppends(patch: (handle: fsp.FileHandle) => void): StoreFs {
  return {
    ...fsp,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      const handle = await fsp.open(...args);
      if (args[0] === logPath() && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) patch(handle);
      return handle;
    }),
  };
}

describe("invariant 2: log before send", () => {
  it("logs the exact body bytes and the full header set before sending, then the receipt", async () => {
    const cloud = await setup();
    const result = await cloud.search(SEARCH);
    expect(result.ok).toBe(true);
    expect(stub.connections).toHaveLength(1);

    const [disclosure, receipt] = logged();
    expect(kinds()).toEqual(["disclosure", "receipt"]);
    const body = bodyOf(disclosure);
    const headers = body["headers"] as [string, string][];
    const sent = Buffer.from(body["body_b64"] as string, "base64");
    const block = `${String(body["method"])} ${String(body["path"])} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
    expect(Buffer.concat([Buffer.from(block, "latin1"), sent]).equals(stub.connections[0] ?? Buffer.alloc(0))).toBe(true);
    expect(sent.equals(stub.bodies[0] ?? Buffer.alloc(0))).toBe(true);
    expect(headers.map(([k]) => k)).toEqual([
      "host", "content-type", "accept", "intent-contract-version", "content-digest", "signature-input", "signature", "content-length", "connection",
    ]);
    expect(headers).toContainEqual(["intent-contract-version", "1.6.1"]);

    const signatureInput = (headers.find(([k]) => k === "signature-input") ?? [])[1] ?? "";
    const nonce = /;nonce="([^"]+)"/.exec(signatureInput)?.[1];
    expect(body).toMatchObject({
      endpoint: "searchCatalog",
      method: "POST",
      path: "/v1/catalog/search",
      fields: ["product", "ship_to", "ship_to.country", "ship_to.postal_code"],
      content_digest: (headers.find(([k]) => k === "content-digest") ?? [])[1],
      keyid: session.keyid,
      nonce,
      created: NOW_S,
    });
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(bodyOf(receipt)).toEqual({
      disclosure_seq: disclosure?.seq,
      receipt_header: result.receipt?.header,
      receipt_signature: result.receipt?.signature,
      status: 200,
      contract_version: "1.5.0",
      verified: true,
    });
    expect(verifyChain(store.entries())).toEqual({ ok: true });
  });

  it("logs every operation, signed or not, before it reaches the stub", async () => {
    const cloud = await setup();
    const seen: number[] = [];
    stub.handler = (req) => {
      seen.push(logged().length);
      return reply()(req);
    };
    const results = [
      await cloud.meta(),
      await cloud.signatureKeys(),
      await cloud.keyStatement(),
      await cloud.search(SEARCH),
      await cloud.createCart(CART_REQUEST),
      await cloud.createApproval("ct_TEST0001"),
      await cloud.getApproval("ap_TEST0001"),
    ];
    expect(results.map((r) => r.ok)).toEqual(Array(7).fill(true));
    // When request n arrives, its disclosure (entry 2n) is already on disk.
    expect(seen).toEqual([1, 3, 5, 7, 9, 11, 13]);
    const disclosures = logged().filter((e) => e.kind === "disclosure").map(bodyOf);
    expect(disclosures.map((b) => b["endpoint"])).toEqual([
      "getMeta", "getSignatureKeys", "getKeyStatement", "searchCatalog", "createCart", "createApproval", "getApproval",
    ]);
    expect(disclosures[5]?.["path"]).toBe("/v1/carts/ct_TEST0001/approvals");
    expect(disclosures[4]?.["fields"]).toEqual(["completer_keyid", "offer_handle", "quantity", "ship_to", "ship_to.country", "ship_to.postal_code"]);
    // Unsigned endpoints still log the digest; they have no keyid, nonce or created.
    expect(disclosures[1]).toMatchObject({ fields: [], body_b64: "", keyid: null, nonce: null, created: null });
    expect(disclosures[1]?.["content_digest"]).toMatch(/^sha-256=:/);
    disclosures.forEach((b, i) => {
      const headers = b["headers"] as [string, string][];
      const block = `${String(b["method"])} ${String(b["path"])} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
      const sent = Buffer.from(b["body_b64"] as string, "base64");
      expect(Buffer.concat([Buffer.from(block, "latin1"), sent]).equals(stub.connections[i] ?? Buffer.alloc(0))).toBe(true);
    });
  });

  it("an append that throws means 0 requests reach the stub", async () => {
    const cloud = await setup();
    await store.close();
    await expect(cloud.search(SEARCH)).rejects.toThrow("store is closed");
    expect(stub.connections).toHaveLength(0);
  });

  it("ENOSPC on the write means 0 requests reach the stub and no disclosure entry", async () => {
    const fs = patchedAppends((h) => Object.assign(h, { write: () => Promise.reject(errno("ENOSPC")) }));
    const cloud = await setup(reply(), fs);
    await expect(cloud.search(SEARCH)).rejects.toThrow("ENOSPC");
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual([]);
  });

  it("a failed fsync means 0 requests reach the stub and no disclosure entry", async () => {
    const fs = patchedAppends((h) => Object.assign(h, { datasync: () => Promise.reject(errno("EIO")) }));
    const cloud = await setup(reply(), fs);
    await expect(cloud.createCart(CART_REQUEST)).rejects.toThrow("EIO");
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual([]);
  });

  it("a fenced lease means 0 requests reach the stub, now and on every later call", async () => {
    // The clock jumps a minute on every read, so the 30 s lease has expired by the fence check after acquiring it.
    let now = NOW_MS;
    const cloud = await setup(reply(), undefined, () => (now += 60_000));
    await expect(cloud.search(SEARCH)).rejects.toThrow(StoreFencedError);
    await expect(cloud.meta()).rejects.toThrow(DisclosureStoppedError);
    expect(stub.connections).toHaveLength(0);
    expect(store.entries()).toEqual([]);
  });

  it("a request refused by the adapter before beforeSend logs nothing and sends nothing", async () => {
    const cloud = await setup();
    await expect(cloud.getApproval("ap_X/../../carts")).rejects.toThrow(CloudRequestError);
    await expect(cloud.search({ ...SEARCH, extra: 1 } as SearchRequest)).rejects.toThrow(CloudRequestError);
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual([]);
  });
});

describe("invariant 3: identity in an outbound body", () => {
  it("writes a block entry naming kinds and paths, never the values; no disclosure, no send", async () => {
    const cloud = await setup();
    const error: unknown = await cloud.search({ ...SEARCH, product: "ship to jane@example.com, 4111 1111 1111 1111" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DisclosureBlockedError);
    expect((error as DisclosureBlockedError).findings).toEqual([
      { path: "$.product", kind: "card" },
      { path: "$.product", kind: "email" },
    ]);
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual(["block"]);
    expect(bodyOf(logged()[0])).toEqual({
      endpoint: "searchCatalog",
      fields: ["product", "ship_to", "ship_to.country", "ship_to.postal_code"],
      blocked: ["card at $.product", "email at $.product"],
      rule: "identity",
    });
    const log = readFileSync(logPath(), "utf8");
    expect(log).not.toContain("jane@example.com");
    expect(log).not.toContain("4111");
  });

  it("does not scan inbound bodies: an offer title with a 16-digit SKU is returned unmodified", async () => {
    const cloud = await setup();
    const result = await cloud.search(SEARCH);
    expect(result.ok && result.body.offers[0]?.title).toBe(SKU_TITLE);
    expect(result.body).toEqual(BODIES["/v1/catalog/search"]);
    expect(kinds()).toEqual(["disclosure", "receipt"]);
  });
});

describe("what came back (ADR-0006)", () => {
  it("a 2xx without a receipt is discarded: a discarded entry, and its content is not returned", async () => {
    const cloud = await setup(reply([VERSION, JSON_TYPE]));
    const error: unknown = await cloud.search(SEARCH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DisclosureDiscardedError);
    expect(error).toMatchObject({ disclosureSeq: 1, status: 200 });
    expect(JSON.stringify(error)).not.toContain(SKU_TITLE);
    expect(kinds()).toEqual(["disclosure", "discarded"]);
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "200 without a receipt" });
  });

  it("a 2xx without a receipt or version header is discarded too", async () => {
    const cloud = await setup(reply([JSON_TYPE]));
    await expect(cloud.createCart(CART_REQUEST)).rejects.toThrow(DisclosureDiscardedError);
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "201 without a receipt" });
  });

  it("no HTTP response is unacknowledged", async () => {
    const cloud = await setup(() => "reset");
    await expect(cloud.search(SEARCH)).rejects.toThrow(CloudNetworkError);
    expect(stub.connections).toHaveLength(1);
    expect(kinds()).toEqual(["disclosure", "unacknowledged"]);
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "CloudNetworkError: network" });
  });

  it("a refused connection: still logged before the send (invariant 2), then recorded as never sent", async () => {
    store = await openStore(dir);
    const cloud = connectCloud({ baseUrl: "http://127.0.0.1:9", session, now: () => NOW_MS }, store, trusted);
    await expect(cloud.search(SEARCH)).rejects.toMatchObject({ name: "CloudNetworkError", neverLeft: true });
    expect(kinds()).toEqual(["disclosure", "unacknowledged"]);
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "CloudNetworkError: not sent (connection refused)" });
    expect(neverLeft(logged()[1]?.body)).toBe(true);
  });

  it("a 503 without the version header is unacknowledged, and returned", async () => {
    const cloud = await setup(reply([], { status: 503, body: "<html>unavailable</html>" }));
    const result = await cloud.search(SEARCH);
    expect(result).toMatchObject({ ok: false, status: 503, body: null });
    expect(kinds()).toEqual(["disclosure", "unacknowledged"]);
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "503 without Intent-Contract-Version" });
  });

  it("a 4xx with the version header and no receipt is discarded (verify fails), and the error is returned", async () => {
    const cloud = await setup(reply([VERSION, JSON_TYPE], { status: 400, body: JSON.stringify({ error: "bad_request", message: "no" }) }));
    const result = await cloud.search(SEARCH);
    expect(result).toMatchObject({ ok: false, status: 400, body: { error: "bad_request" } });
    expect(kinds()).toEqual(["disclosure", "discarded"]);
    expect(bodyOf(logged()[1])).toEqual({
      disclosure_seq: 1,
      reason: "400 with Intent-Contract-Version but without a receipt",
    });
  });

  it("a 4xx with a receipt is a receipt entry", async () => {
    const cloud = await setup(reply([VERSION, SIGNED], { status: 401, body: JSON.stringify({ error: "unauthorized", message: "no" }) }));
    const result = await cloud.meta();
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(kinds()).toEqual(["disclosure", "receipt"]);
    expect(bodyOf(logged()[1])).toMatchObject({ disclosure_seq: 1, status: 401, contract_version: "1.5.0" });
  });

  it("an unusable response follows the same rules and rethrows the adapter's error", async () => {
    const cloud = await setup(reply([VERSION, SIGNED], { body: "not json" }));
    await expect(cloud.meta()).rejects.toThrow(CloudResponseError);
    stub.handler = reply([JSON_TYPE], { body: "not json" });
    await expect(cloud.meta()).rejects.toThrow(CloudResponseError);
    expect(kinds()).toEqual(["disclosure", "receipt", "disclosure", "discarded"]);
    expect(bodyOf(logged()[3])).toEqual({ disclosure_seq: 3, reason: "200 without a receipt" });
  });

  it("a failed append after the response fails the call: the content is not returned", async () => {
    const cloud = await setup();
    stub.handler = (req) => {
      void store.close();
      return reply()(req);
    };
    await expect(cloud.search(SEARCH)).rejects.toThrow("store is closed");
    expect(kinds()).toEqual(["disclosure"]);
  });
});

describe("receipt verification (trust)", () => {
  it("a 2xx whose receipt is for another request is discarded and not returned", async () => {
    const cloud = await setup(reply([VERSION, ...FOREIGN_HEADERS, JSON_TYPE]));
    await expect(cloud.search(SEARCH)).rejects.toThrow(DisclosureDiscardedError);
    expect(kinds()).toEqual(["disclosure", "discarded"]);
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "200 with an invalid receipt (step 4: path_mismatch)" });
  });

  it("a receipt for another status, or under an expired key set, is discarded", async () => {
    const cloud = await setup((req) => ({ ...(reply()(req) as StubReply), headers: [VERSION, ...edgeReceipt(req, 201)] }));
    await expect(cloud.meta()).rejects.toThrow(DisclosureDiscardedError);
    expect(bodyOf(logged()[1])).toMatchObject({ reason: "200 with an invalid receipt (step 5: status_mismatch)" });

    const late = createDisclosedCloud(createLateCloud(), store, { keySet: () => KEYS, now: () => Date.UTC(2099, 0, 1) });
    await expect(late.meta()).rejects.toThrow(DisclosureDiscardedError);
    expect(bodyOf(logged()[3])).toMatchObject({ reason: "200 with an invalid receipt (step 3: statement_expired)" });
  });

  it("a non-2xx with an invalid receipt is discarded even without the version header, and returned", async () => {
    const cloud = await setup(reply(FOREIGN_HEADERS, { status: 503, body: "" }));
    const result = await cloud.search(SEARCH);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(bodyOf(logged()[1])).toEqual({ disclosure_seq: 1, reason: "503 with an invalid receipt (step 4: path_mismatch)" });
  });

  it("before a verified key statement only the bootstrap reads are sent; their receipts are logged unverified", async () => {
    const cloud = await setup(reply(), undefined, undefined, { keySet: () => null });
    for (const call of [
      () => cloud.search(SEARCH),
      () => cloud.createCart(CART_REQUEST),
      () => cloud.createApproval("ct_TEST0001"),
      () => cloud.getApproval("ap_TEST0001"),
    ]) {
      await expect(call()).rejects.toThrow(DisclosureNoKeysError);
    }
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual([]);

    expect((await cloud.keyStatement()).ok).toBe(true);
    expect(kinds()).toEqual(["disclosure", "receipt"]);
    expect(bodyOf(logged()[1])).toMatchObject({ disclosure_seq: 1, verified: false });
  });
});

describe("fail closed once the key statement has expired (attack: keep disclosing under stale keys)", () => {
  it("search, cart and approval calls are refused before anything is logged or sent; bootstrap reads still go", async () => {
    const after = KEYS.expiresAt.getTime();
    const cloud = await setup(reply(), undefined, undefined, { keySet: () => KEYS, now: () => after });
    for (const call of [
      () => cloud.search(SEARCH),
      () => cloud.createCart(CART_REQUEST),
      () => cloud.createApproval("ct_TEST0001"),
      () => cloud.getApproval("ap_TEST0001"),
    ]) {
      const failure = call();
      await expect(failure).rejects.toThrow(DisclosureKeysExpiredError);
      await expect(failure).rejects.toThrow(`the key statement expired on ${KEYS.expiresAt.toISOString()}`);
    }
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual([]);
    // The statement can still be fetched again, through the logged bootstrap path.
    await cloud.keyStatement().catch(() => undefined);
    expect(kinds()[0]).toBe("disclosure");
  });

  it("one millisecond before expiry a search is still sent", async () => {
    const before = KEYS.expiresAt.getTime() - 1;
    const cloud = await setup(reply(), undefined, undefined, { keySet: () => KEYS, now: () => before });
    await cloud.search(SEARCH).catch(() => undefined);
    expect(kinds()[0]).toBe("disclosure");
  });
});

/** The real adapter on the current stub, for a second disclosed cloud over the same store. */
function createLateCloud(): IntentCloud {
  return createHttpCloud({ baseUrl: stub.baseUrl, session, now: () => NOW_MS });
}

describe("an adapter that misbehaves", () => {
  const throwingCloud = (failure: unknown, callHook = true): IntentCloud => {
    const call = async (options?: { beforeSend?: (r: never) => void | Promise<void> }) => {
      if (callHook) {
        await options?.beforeSend?.({
          operation: "getMeta",
          method: "GET",
          path: "/v1/meta",
          headers: [["content-digest", "sha-256=:x:"]],
          body: new Uint8Array(0),
        } as never);
        throw failure;
      }
      return {} as never;
    };
    return {
      meta: call,
      signatureKeys: call,
      keyStatement: call,
      search: (_r, o) => call(o),
      createCart: (_r, o) => call(o),
      createApproval: (_h, o) => call(o),
      getApproval: (_h, o) => call(o),
      reportOutcome: (_h, _r, o) => call(o),
    };
  };

  it("a failure after the log append that is not a response is unacknowledged, named by its error", async () => {
    stub = await startStubCloud(reply());
    store = await openStore(dir);
    await expect(createDisclosedCloud(throwingCloud(new CloudRequestError("keep-alive agent")), store, trusted).meta()).rejects.toThrow(
      CloudRequestError,
    );
    await expect(createDisclosedCloud(throwingCloud("not an error"), store, trusted).meta()).rejects.toBe("not an error");
    expect(logged().map((e) => [e.kind, (e.body as Json)["reason"]])).toEqual([
      ["disclosure", undefined],
      ["unacknowledged", "CloudRequestError"],
      ["disclosure", undefined],
      ["unacknowledged", "unknown failure"],
    ]);
  });

  it("a result without the beforeSend call is refused", async () => {
    stub = await startStubCloud(reply());
    store = await openStore(dir);
    await expect(createDisclosedCloud(throwingCloud(null, false), store, { keySet: () => KEYS }).meta()).rejects.toThrow("without calling beforeSend");
  });
});

describe("a failed follow-up append stops every later send (attack: no answer lost mid-session)", () => {
  /** The real fs, except that once `arm()` is called the next append-mode open of the log fails with EMFILE. */
  function emfileOnce(): StoreFs & { arm: () => void } {
    let armed = false;
    return {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        if (armed && args[0] === logPath() && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) {
          armed = false;
          throw errno("EMFILE");
        }
        return fsp.open(...args);
      }),
      arm: () => {
        armed = true;
      },
    };
  }

  it("a 2xx with an invalid receipt whose discarded entry cannot be appended: stopped, and nothing more reaches the cloud", async () => {
    const fs = emfileOnce();
    const invalid = reply([VERSION, ...FOREIGN_HEADERS, JSON_TYPE]);
    const cloud = await setup(invalid, fs);
    stub.handler = (req) => {
      fs.arm();
      return invalid(req);
    };
    const error: unknown = await cloud.search(SEARCH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DisclosureStoppedError);
    expect((error as Error).message).toMatch(/the answer to disclosure #1 could not be logged: EMFILE/);
    expect(stub.connections).toHaveLength(1);

    // The open() failure was transient, but the gateway stays stopped: no later call is logged or sent.
    stub.handler = reply();
    for (const next of [() => cloud.search(SEARCH), () => cloud.meta(), () => cloud.getApproval("ap_TEST0001")]) {
      await expect(next()).rejects.toThrow(DisclosureStoppedError);
    }
    expect(stub.connections).toHaveLength(1);
    expect(store.entries().map((e) => e.kind)).toEqual(["session", "disclosure"]);
  });

  it("an unacknowledged entry that cannot be appended stops the gateway the same way", async () => {
    const fs = emfileOnce();
    const cloud = await setup(reply(), fs);
    stub.handler = () => {
      fs.arm();
      return "reset";
    };
    await expect(cloud.search(SEARCH)).rejects.toThrow(DisclosureStoppedError);
    stub.handler = reply();
    await expect(cloud.search(SEARCH)).rejects.toThrow(DisclosureStoppedError);
    expect(stub.connections).toHaveLength(1);
    expect(kinds()).toEqual(["disclosure"]);
  });
});

describe("gateway session marks (local only)", () => {
  it("starts with one session entry and numbers its disclosures, listing the ones still open", async () => {
    stub = await startStubCloud(reply());
    store = await openStore(dir);
    const http = createHttpCloud({ baseUrl: stub.baseUrl, session, now: () => NOW_MS });
    // The search is held after it is logged, so another call is logged while it is still open.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let logged: () => void = () => undefined;
    const searchLogged = new Promise<void>((resolve) => {
      logged = resolve;
    });
    const holding: IntentCloud = {
      ...http,
      search: (request, options) =>
        http.search(request, {
          beforeSend: async (prepared) => {
            await options?.beforeSend?.(prepared);
            logged();
            await held;
          },
        }),
    };
    const cloud = createDisclosedCloud(holding, store, trusted);
    await cloud.meta();
    const slow = cloud.search(SEARCH);
    await searchLogged;
    await cloud.signatureKeys();
    release();
    await slow;
    await cloud.getApproval("ap_TEST0001");

    const [first, ...rest] = store.entries();
    expect(first?.kind).toBe("session");
    const id = bodyOf(first)["id"] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rest.some((e) => e.kind === "session")).toBe(false);
    const marks = rest.filter((e) => e.kind === "disclosure").map((e) => [bodyOf(e)["endpoint"], bodyOf(e)["session"]]);
    expect(marks).toEqual([
      ["getMeta", { id, n: 0, open: [] }],
      ["searchCatalog", { id, n: 1, open: [] }],
      ["getSignatureKeys", { id, n: 2, open: [1] }],
      ["getApproval", { id, n: 3, open: [] }],
    ]);
    // The id is local: it is in no byte the stub received.
    for (const bytes of stub.connections) expect(bytes.toString("latin1")).not.toContain(id);
  });

  it("each disclosed cloud has its own session id", async () => {
    const cloud = await setup();
    await cloud.meta();
    const other = connectCloud({ baseUrl: stub.baseUrl, session, now: () => NOW_MS }, store, trusted);
    await other.meta();
    const ids = store.entries().filter((e) => e.kind === "session").map((e) => bodyOf(e)["id"]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
