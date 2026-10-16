// The disclosure log in front of the real cloud adapter, against a local stub that records every byte it received.
// Invariant 2 (log before send): whenever the log append fails, 0 requests reach the stub; what is logged is byte for
// byte what the stub received. Invariant 3: identity in an outbound body is blocked before the log and the send.
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStubCloud, type StubCloud, type StubHandler, type StubReply } from "../../test/support/stub-cloud.ts";
import type { CartRequest, SearchRequest } from "../contract/index.ts";
import { createSession } from "../signing/index.ts";
import { type Entry, openStore, type Store, StoreFencedError, type StoreFs, verifyChain } from "../store/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  connectCloud,
  createDisclosedCloud,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  type IntentCloud,
} from "./index.ts";

vi.setConfig({ testTimeout: 20_000 });

type Json = Record<string, unknown>;
const vector = (name: string): Json =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", name), "utf8")) as Json;
const d1 = ((vector("d1-receipt.json")["cases"] as Json[])[0] as Json)["expected"] as Json;
const RECEIPT = { header: d1["intent_receipt"] as string, signature: d1["intent_receipt_signature"] as string };
const STATEMENT = (vector("s1-key-statement.json")["expected"] as Json)["statement"] as Json;

const NOW_MS = 1790251200_000;
const NOW_S = NOW_MS / 1000;
const USD = (amount_minor: number): Json => ({ amount_minor, currency: "USD" });
const MERCHANT = { name: "Example Shop", domain: "shop.example" };
const ITEM = { title: "Trail shoe", variant: "Size 10" };
const SEARCH: SearchRequest = { ship_to: { postal_code: "94110", country: "US" }, product: "trail shoe" };
const CART_REQUEST: CartRequest = { offer_handle: "of_TEST0001", quantity: 1, ship_to: { country: "US", postal_code: "94110" } };
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
      v: 1,
      approval: "ap_TEST0001",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      merchant: MERCHANT,
      item: ITEM,
      quantity: 1,
      unit_price: USD(8999),
      shipping: USD(0),
      total: USD(8999),
      total_kind: "exact",
      ship_to: { country: "US", postal_prefix: "941" },
      continue_url_hash: `sha256:${"a".repeat(64)}`,
      rule_version: "recheck-v1",
      expires_at: "2026-09-24T12:30:00Z",
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
const RECEIPT_HEADERS: [string, string][] = [
  ["Intent-Receipt", RECEIPT.header],
  ["Intent-Receipt-Signature", RECEIPT.signature],
];
const JSON_TYPE: [string, string] = ["Content-Type", "application/json"];

/** The endpoint's success body, with the headers given (by default the version and both receipt headers). */
const reply =
  (headers: [string, string][] = [VERSION, ...RECEIPT_HEADERS, JSON_TYPE], over: Partial<StubReply> = {}): StubHandler =>
  (req) => ({
    status: STATUS[req.url ?? ""] ?? 200,
    headers,
    body: JSON.stringify(BODIES[req.url ?? ""] ?? {}),
    ...over,
  });

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

async function setup(handler: StubHandler = reply(), fs?: StoreFs, clock?: () => number) {
  stub = await startStubCloud(handler);
  store = await openStore(dir, { ...(fs === undefined ? {} : { fs }), ...(clock === undefined ? {} : { clock }) });
  return connectCloud({ baseUrl: stub.baseUrl, session, now: () => NOW_MS }, store);
}

const kinds = () => store.entries().map((e) => e.kind);
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

    const [disclosure, receipt] = store.entries();
    expect(kinds()).toEqual(["disclosure", "receipt"]);
    const body = bodyOf(disclosure);
    const headers = body["headers"] as [string, string][];
    const sent = Buffer.from(body["body_b64"] as string, "base64");
    const block = `${String(body["method"])} ${String(body["path"])} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
    expect(Buffer.concat([Buffer.from(block, "latin1"), sent]).equals(stub.connections[0] ?? Buffer.alloc(0))).toBe(true);
    expect(sent.equals(stub.bodies[0] ?? Buffer.alloc(0))).toBe(true);
    expect(headers.map(([k]) => k)).toEqual([
      "host", "content-type", "accept", "content-digest", "signature-input", "signature", "content-length", "connection",
    ]);

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
      receipt_header: RECEIPT.header,
      receipt_signature: RECEIPT.signature,
      status: 200,
      contract_version: "1.5.0",
    });
    expect(verifyChain(store.entries())).toEqual({ ok: true });
  });

  it("logs every operation, signed or not, before it reaches the stub", async () => {
    const cloud = await setup();
    const seen: number[] = [];
    stub.handler = (req) => {
      seen.push(store.entries().length);
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
    const disclosures = store.entries().filter((e) => e.kind === "disclosure").map(bodyOf);
    expect(disclosures.map((b) => b["endpoint"])).toEqual([
      "getMeta", "getSignatureKeys", "getKeyStatement", "searchCatalog", "createCart", "createApproval", "getApproval",
    ]);
    expect(disclosures[5]?.["path"]).toBe("/v1/carts/ct_TEST0001/approvals");
    expect(disclosures[4]?.["fields"]).toEqual(["offer_handle", "quantity", "ship_to", "ship_to.country", "ship_to.postal_code"]);
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
    await expect(cloud.meta()).rejects.toThrow(StoreFencedError);
    expect(stub.connections).toHaveLength(0);
    expect(kinds()).toEqual([]);
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
    expect(bodyOf(store.entries()[0])).toEqual({
      endpoint: "searchCatalog",
      fields: ["product", "ship_to", "ship_to.country", "ship_to.postal_code"],
      blocked: ["card at $.product", "email at $.product"],
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
    expect(error).toMatchObject({ disclosureSeq: 0, status: 200 });
    expect(JSON.stringify(error)).not.toContain(SKU_TITLE);
    expect(kinds()).toEqual(["disclosure", "discarded"]);
    expect(bodyOf(store.entries()[1])).toEqual({ disclosure_seq: 0, reason: "200 without a receipt" });
  });

  it("a 2xx without a receipt or version header is discarded too", async () => {
    const cloud = await setup(reply([JSON_TYPE]));
    await expect(cloud.createCart(CART_REQUEST)).rejects.toThrow(DisclosureDiscardedError);
    expect(bodyOf(store.entries()[1])).toEqual({ disclosure_seq: 0, reason: "201 without a receipt" });
  });

  it("no HTTP response is unacknowledged", async () => {
    const cloud = await setup(() => "reset");
    await expect(cloud.search(SEARCH)).rejects.toThrow(CloudNetworkError);
    expect(stub.connections).toHaveLength(1);
    expect(kinds()).toEqual(["disclosure", "unacknowledged"]);
    expect(bodyOf(store.entries()[1])).toEqual({ disclosure_seq: 0, reason: "CloudNetworkError: network" });
  });

  it("a 503 without the version header is unacknowledged, and returned", async () => {
    const cloud = await setup(reply([], { status: 503, body: "<html>unavailable</html>" }));
    const result = await cloud.search(SEARCH);
    expect(result).toMatchObject({ ok: false, status: 503, body: null });
    expect(kinds()).toEqual(["disclosure", "unacknowledged"]);
    expect(bodyOf(store.entries()[1])).toEqual({ disclosure_seq: 0, reason: "503 without Intent-Contract-Version" });
  });

  it("a 4xx with the version header and no receipt is discarded (verify fails), and the error is returned", async () => {
    const cloud = await setup(reply([VERSION, JSON_TYPE], { status: 400, body: JSON.stringify({ error: "bad_request", message: "no" }) }));
    const result = await cloud.search(SEARCH);
    expect(result).toMatchObject({ ok: false, status: 400, body: { error: "bad_request" } });
    expect(kinds()).toEqual(["disclosure", "discarded"]);
    expect(bodyOf(store.entries()[1])).toEqual({
      disclosure_seq: 0,
      reason: "400 with Intent-Contract-Version but without a receipt",
    });
  });

  it("a 4xx with a receipt is a receipt entry", async () => {
    const cloud = await setup(reply([VERSION, ...RECEIPT_HEADERS], { status: 401, body: JSON.stringify({ error: "unauthorized", message: "no" }) }));
    const result = await cloud.meta();
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(kinds()).toEqual(["disclosure", "receipt"]);
    expect(bodyOf(store.entries()[1])).toMatchObject({ disclosure_seq: 0, status: 401, contract_version: "1.5.0" });
  });

  it("an unusable response follows the same rules and rethrows the adapter's error", async () => {
    const cloud = await setup(reply([VERSION, ...RECEIPT_HEADERS], { body: "not json" }));
    await expect(cloud.meta()).rejects.toThrow(CloudResponseError);
    stub.handler = reply([JSON_TYPE], { body: "not json" });
    await expect(cloud.meta()).rejects.toThrow(CloudResponseError);
    expect(kinds()).toEqual(["disclosure", "receipt", "disclosure", "discarded"]);
    expect(bodyOf(store.entries()[3])).toEqual({ disclosure_seq: 2, reason: "200 without a receipt" });
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
    };
  };

  it("a failure after the log append that is not a response is unacknowledged, named by its error", async () => {
    stub = await startStubCloud(reply());
    store = await openStore(dir);
    await expect(createDisclosedCloud(throwingCloud(new CloudRequestError("keep-alive agent")), store).meta()).rejects.toThrow(
      CloudRequestError,
    );
    await expect(createDisclosedCloud(throwingCloud("not an error"), store).meta()).rejects.toBe("not an error");
    expect(store.entries().map((e) => [e.kind, (e.body as Json)["reason"]])).toEqual([
      ["disclosure", undefined],
      ["unacknowledged", "CloudRequestError"],
      ["disclosure", undefined],
      ["unacknowledged", "unknown failure"],
    ]);
  });

  it("a result without the beforeSend call is refused", async () => {
    stub = await startStubCloud(reply());
    store = await openStore(dir);
    await expect(createDisclosedCloud(throwingCloud(null, false), store).meta()).rejects.toThrow("without calling beforeSend");
  });
});
