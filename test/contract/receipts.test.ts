// Contract suite, edge statuses (G23, AC-A1; pre-mortem 1): a receipt that verifies with src/trust on every error
// status the suite can provoke: 401 (unsigned), 404 (unknown handle, unknown path), 405 (wrong method), 400 (digest
// mismatch) and, on the fake whose quota can be set low, 429. The error bodies are the platform's exact ones, so the
// fake and staging answer alike (G30). Runs against TARGET (see target.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION, ErrorBody, RateLimited } from "../../src/contract/index.ts";
import { canonicalize } from "../../src/jcs/index.ts";
import { contentDigest } from "../../src/signing/index.ts";
import { type KeySet, verifyReceipt } from "../../src/trust/index.ts";
import {
  closeTargets,
  IS_FAKE,
  TARGET,
  openTarget,
  prepared,
  rawReceiptProblem,
  receiptProblem,
  sendRaw,
  sentOf,
  type Target,
  trustedKeySet,
} from "./target.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SHIP = { country: "US", postal_code: "94110" } as const;
const SIGNATURE_HEADERS = new Set(["signature", "signature-input"]);
const UNKNOWN_HANDLE = { error: "not_found", message: "unknown handle" };

let target: Target;
let keySet: KeySet;

beforeAll(async () => {
  target = await openTarget();
  keySet = await trustedKeySet(target);
});
afterAll(closeTargets);

describe(`receipts on edge statuses (${TARGET})`, () => {
  it("401: an unsigned request to a signed endpoint", async () => {
    // The adapter's own GET /v1/meta, with the two signature headers removed.
    const signed = await prepared((beforeSend) => target.connect().meta({ beforeSend }));
    const request = { ...signed, headers: signed.headers.filter(([name]) => !SIGNATURE_HEADERS.has(name) && name !== "host") };
    const reply = await sendRaw(target, request);
    expect(reply.status).toBe(401);
    expect(ErrorBody.parse(reply.json)).toEqual({ error: "unauthorized", message: "authentication failed" });
    const sent = sentOf(request);
    expect(sent.keyid).toBeUndefined();
    expect(rawReceiptProblem(reply, sent, keySet, target.now())).toBeNull();
  });

  it("404: an approval handle nobody created", async () => {
    const result = await target.connect().getApproval(`ap_${Buffer.alloc(12, 0).toString("base64url")}`);
    expect(result.status).toBe(404);
    expect(ErrorBody.parse(result.body)).toEqual(UNKNOWN_HANDLE);
    expect(receiptProblem(result, keySet, target.now())).toBeNull();
  });

  it("404: approvals for a cart handle nobody created", async () => {
    const result = await target.connect().createApproval(`ct_${Buffer.alloc(12, 0).toString("base64url")}`);
    expect(result.status).toBe(404);
    expect(ErrorBody.parse(result.body)).toEqual(UNKNOWN_HANDLE);
    expect(receiptProblem(result, keySet, target.now())).toBeNull();
  });

  it("404 off the six endpoints and 405 for another method, both not_found", async () => {
    const headers = [["content-digest", contentDigest(new Uint8Array())]] as const;
    for (const [method, path, status] of [
      ["GET", "/v1/nowhere", 404],
      ["GET", "/v1/carts", 405],
      ["POST", "/v1/meta", 405],
    ] as const) {
      const request = { method, path, headers, body: new Uint8Array() };
      const reply = await sendRaw(target, request);
      expect(reply.status, `${method} ${path}`).toBe(status);
      expect(ErrorBody.parse(reply.json).error).toBe("not_found");
      expect(rawReceiptProblem(reply, sentOf(request), keySet, target.now())).toBeNull();
    }
  });

  it("400: a body that is not the one content-digest names; the receipt names the digest of what arrived", async () => {
    const signed = await prepared((beforeSend) => target.connect().search({ ship_to: SHIP }, { beforeSend }));
    const body = Buffer.from(canonicalize({ category: "home", ship_to: SHIP }), "utf8");
    const request = { ...signed, headers: signed.headers.filter(([name]) => name !== "host"), body };
    const reply = await sendRaw(target, request);
    expect(reply.status).toBe(400);
    expect(ErrorBody.parse(reply.json)).toEqual({ error: "digest_mismatch", message: "content digest mismatch" });
    const sent = sentOf(request, contentDigest(body));
    expect(rawReceiptProblem(reply, sent, keySet, target.now())).toBeNull();
    // Attack: checked against the digest the header claimed instead, the same receipt does not verify.
    const claimed = sentOf(request);
    const verified = verifyReceipt(
      { status: reply.status, receipt: reply.headers["intent-receipt"], signature: reply.headers["intent-receipt-signature"] },
      claimed,
      keySet,
      target.now(),
    );
    expect(verified).toMatchObject({ ok: false, step: 4, reason: "digest_mismatch" });
  });

  it("attack: a valid receipt does not verify for another request or another status", async () => {
    const cloud = target.connect();
    const meta = await cloud.meta();
    const other = await cloud.meta();
    const response = { status: meta.status, receipt: meta.receipt?.header, signature: meta.receipt?.signature };
    expect(verifyReceipt(response, sentOf(other.raw.request), keySet, target.now())).toMatchObject({ ok: false, step: 4 });
    expect(verifyReceipt({ ...response, status: 500 }, sentOf(meta.raw.request), keySet, target.now())).toMatchObject({
      ok: false,
      step: 5,
    });
  });

  it.runIf(IS_FAKE)("429: past the request quota, with Retry-After and the RateLimited body", async () => {
    const limited = await openTarget({ quotas: { requests_per_minute: 2 } }); // closed by closeTargets
    const limitedKeys = await trustedKeySet(limited); // the first request of the minute
    const cloud = limited.connect();
    expect((await cloud.meta()).status).toBe(200);
    const result = await cloud.meta();
    expect(result.status).toBe(429);
    expect(RateLimited.parse(result.body).limit).toBe("requests");
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
    expect(result.contractVersion).toBe(CONTRACT_VERSION);
    expect(receiptProblem(result, limitedKeys, limited.now())).toBeNull();
  });
});
