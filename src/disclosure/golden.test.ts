// Golden chain: the disclosure log of a demo-shaped flow (key bootstrap, search, cart, approval, status) plus every
// follow-up path (unacknowledged, not sent, discarded, block, stop) must stay byte-identical across refactors of the
// disclosure core. Timestamps come from the store clock and the session id from a mocked randomUUID; the adapter is a
// scripted IntentCloud whose request bytes and receipts are fixed, so the whole audit.jsonl is reproducible.
// Regenerate (only for an intended chain format change, which needs an ADR): GOLDEN_UPDATE=1 pnpm test golden.
import * as fsp from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PINNED, S1, signReceipt, STATEMENT_VALID_AT } from "../../test/support/trust-kit.ts";
import type { CloudResult, IntentCloud, PreparedRequest } from "../cloud/index.ts";
import { CloudNetworkError } from "../cloud/index.ts";
import { contentDigest } from "../signing/index.ts";
import { openStore, type StoreFs } from "../store/index.ts";
import { verifyStatement } from "../trust/index.ts";
import { createDisclosedCloud, DisclosureBlockedError, DisclosureDiscardedError, DisclosureStoppedError } from "./index.ts";

let uuids = 0;
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => `00000000-0000-4000-8000-${String(uuids++).padStart(12, "0")}` };
});

const GOLDEN = join(import.meta.dirname, "..", "..", "test", "fixtures", "disclosure-golden.jsonl");
const statement = verifyStatement(S1.expected.statement, PINNED, STATEMENT_VALID_AT);
if (!statement.ok) throw new Error("s1 does not verify");
const KEYS = statement.keySet;

type Outcome = "signed" | "unsigned" | "502" | "neverLeft" | "noReceipt";

/** A scripted adapter: fixed request bytes per operation, and the next outcome from `script` once beforeSend passed. */
function scriptedCloud(script: Outcome[]): IntentCloud {
  let created = 1790251200;
  function prepared(operation: PreparedRequest["operation"], method: "GET" | "POST", path: string, payload: unknown): PreparedRequest {
    const body = payload === undefined ? new Uint8Array(0) : Buffer.from(JSON.stringify(payload), "utf8");
    const digest = contentDigest(body);
    const signed = method === "POST" || path.startsWith("/v1/approvals/");
    const headers: [string, string][] = [
      ["host", "cloud.example"],
      ["accept", "application/json"],
      ["content-digest", digest],
      ...(signed
        ? ([
            ["signature-input", `sig1=("@method" "@path" "content-digest");created=${String(created++)};keyid="gw-${"A".repeat(43)}";nonce="AAAAAAAAAAAAAAAAAAAAAA";alg="ed25519";tag="intent-gateway-v1"`],
            ["signature", "sig1=:AAAA:"],
          ] as [string, string][])
        : []),
      ["connection", "close"],
    ];
    return { operation, method, path, headers, body };
  }
  async function call<T>(request: PreparedRequest, okBody: unknown, options?: { beforeSend?: (r: PreparedRequest) => void | Promise<void> }) {
    await options?.beforeSend?.(request);
    const outcome = script.shift() ?? "signed";
    const raw = { request, responseHeaders: [], responseBytes: new Uint8Array(0) };
    if (outcome === "neverLeft") {
      throw new CloudNetworkError("network", request, "no connection", { neverLeft: true, failure: "connection refused" });
    }
    if (outcome === "502") return { ok: false, status: 502, body: null, receipt: null, contractVersion: null, retryAfter: null, raw } as CloudResult<T>;
    const signatureInput = request.headers.find(([k]) => k === "signature-input")?.[1] ?? "";
    const param = (name: string) => new RegExp(`;${name}=("?)([^";]*)\\1(?:;|$)`).exec(signatureInput)?.[2];
    const keyid = param("keyid");
    const nonce = param("nonce");
    const createdAt = param("created");
    const sent = {
      method: request.method,
      path: request.path,
      content_digest: request.headers.find(([k]) => k === "content-digest")?.[1] ?? "",
      ...(keyid === undefined ? {} : { keyid }),
      ...(nonce === undefined ? {} : { nonce }),
      ...(createdAt === undefined ? {} : { created: Number(createdAt) }),
    };
    const signed = signReceipt({ v: 1, kid: "cloud-receipt-202610", request: sent, status: 200, received_at: "2026-10-15T12:00:01Z" });
    const receipt = outcome === "noReceipt" ? null : { header: signed.receipt, signature: signed.signature };
    return { ok: true, status: 200, body: okBody, receipt, contractVersion: "1.5.0", retryAfter: null, raw } as CloudResult<T>;
  }
  return {
    meta: (o) => call(prepared("getMeta", "GET", "/v1/meta", undefined), {}, o),
    signatureKeys: (o) => call(prepared("getSignatureKeys", "GET", "/v1/signature-keys", undefined), {}, o),
    keyStatement: (o) => call(prepared("getKeyStatement", "GET", "/v1/key-statement", undefined), {}, o),
    search: (r, o) => call(prepared("searchCatalog", "POST", "/v1/catalog/search", r), {}, o),
    createCart: (r, o) => call(prepared("createCart", "POST", "/v1/carts", r), {}, o),
    createApproval: (h, o) => call(prepared("createApproval", "POST", `/v1/carts/${h}/approvals`, {}), {}, o),
    getApproval: (h, o) => call(prepared("getApproval", "GET", `/v1/approvals/${h}`, undefined), {}, o),
  };
}

describe("golden chain", () => {
  it("writes a byte-identical audit.jsonl for the demo flow and every follow-up path", async () => {
    uuids = 0;
    const dir = join(await fsp.mkdtemp(join(tmpdir(), "golden-")), "data");
    let failNext = false;
    const fs: StoreFs = {
      ...fsp,
      open: (async (...args: Parameters<typeof fsp.open>) => {
        const handle = await fsp.open(...args);
        if (String(args[0]).endsWith("audit.jsonl") && typeof args[1] === "number" && (args[1] & fsp.constants.O_APPEND) !== 0) {
          const write = handle.write.bind(handle);
          handle.write = ((...w: Parameters<typeof write>) => {
            if (failNext) return Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
            return write(...w);
          }) as typeof handle.write;
        }
        return handle;
      }),
    };
    let tick = Date.parse("2026-10-15T12:00:00.000Z");
    const store = await openStore(dir, { fs, clock: () => tick++ });
    let keySet: typeof KEYS | null = null;
    const script: Outcome[] = ["signed", "signed", "signed", "signed", "signed", "signed", "signed", "502", "neverLeft", "noReceipt"];
    const cloud = createDisclosedCloud(scriptedCloud(script), store, { keySet: () => keySet, now: () => STATEMENT_VALID_AT.getTime() });

    await cloud.meta();
    await cloud.signatureKeys();
    await cloud.keyStatement();
    keySet = KEYS;
    await cloud.search({ ship_to: { postal_code: "94110", country: "US" }, product: "trail shoe" });
    await cloud.createCart({ offer_handle: "of_TEST0001", quantity: 1, ship_to: { country: "US", postal_code: "94110" } });
    await cloud.createApproval("ct_TEST0001");
    await cloud.getApproval("ap_TEST0001");
    await cloud.getApproval("ap_TEST0001"); // 502, no version: unacknowledged
    await expect(cloud.getApproval("ap_TEST0001")).rejects.toBeInstanceOf(CloudNetworkError); // not sent
    await expect(cloud.getApproval("ap_TEST0001")).rejects.toBeInstanceOf(DisclosureDiscardedError); // 2xx, no receipt
    await expect(
      cloud.search({ ship_to: { postal_code: "94110", country: "US" }, product: "for ada@example.com" }),
    ).rejects.toBeInstanceOf(DisclosureBlockedError);
    failNext = true;
    await expect(cloud.getApproval("ap_TEST0001")).rejects.toThrow("ENOSPC");
    failNext = false;
    await expect(cloud.getApproval("ap_TEST0001")).rejects.toBeInstanceOf(DisclosureStoppedError);
    await store.close();

    const text = readFileSync(join(dir, "audit.jsonl"), "utf8");
    if (process.env["GOLDEN_UPDATE"] === "1") writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
