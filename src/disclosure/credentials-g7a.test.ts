// G2b follow-ups taken up by G7a (ADR-0017): compound token names (session_token, authToken, bearer) are digested
// like the plain secret keys; a form body (an OAuth endpoint's, RFC 7009 revocation) is logged, digested, scanned
// and checked by `intent verify` exactly as a JSON body; the MCP client name in `params._meta` is let through.
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED } from "../../test/support/trust-kit.ts";
import { type Entry, openStore, type Store } from "../store/index.ts";
import { runVerify } from "../verify/index.ts";
import {
  createDisclosedWallet,
  type DestinationTransport,
  DisclosureBlockedError,
  DisclosureRefusedError,
  openWalletSession,
  type OutboundRequest,
} from "./index.ts";

type Json = Record<string, unknown>;
const REFRESH = "shop-refresh-token-SECRET-9876543210";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const marker = (text: string) => `[redacted sha256:${sha(text)}]`;
const form = (fields: Record<string, string>) => new URLSearchParams(Object.entries(fields)).toString();

function transport(options: { form?: boolean; bytes?: (payload: unknown) => string } = {}) {
  const sent: OutboundRequest[] = [];
  const t: DestinationTransport = {
    prepare: (operation, payload) => ({
      operation,
      method: "POST",
      path: options.form === true ? "/oauth/revoke" : "/mcp",
      headers: [
        ["host", "wallet.example"],
        ["content-type", options.form === true ? "application/x-www-form-urlencoded" : "application/json"],
      ],
      body: Buffer.from((options.bytes ?? (options.form === true ? (p: unknown) => form(p as Record<string, string>) : JSON.stringify))(payload), "utf8"),
    }),
    send: (request) => {
      sent.push(request);
      return Promise.resolve({ status: 200, headers: [["content-type", "application/json"]], body: Buffer.from("{}") });
    },
  };
  return { transport: t, sent };
}

let store: Store;
let dir: string;
afterEach(async () => {
  await store.close().catch(() => undefined);
});
async function setup() {
  dir = join(await fsp.mkdtemp(join(tmpdir(), "wallet-g7a-")), "data");
  store = await openStore(dir);
  return openWalletSession(store);
}
const audit = () => readFileSync(join(dir, "audit.jsonl"), "utf8");
const bodyOf = (entry: Entry | undefined) => entry?.body as Json;
const disclosures = () => store.entries().filter((e) => e.kind === "disclosure");
async function verifyFailures(): Promise<string[]> {
  await store.close();
  const report = await runVerify({ dataDir: dir, pinnedRootKeys: PINNED, now: new Date(), skipSupplyChain: true });
  return report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.details.join("; ")}`);
}

describe("compound token names are secret keys", () => {
  it("digests keys whose last word is token or bearer (session_token, authToken, bearer); verify passes", async () => {
    const session = await setup();
    const secrets = { session: "SESSION-SECRET-1", auth: "AUTH-SECRET-2", bearer: "BEARER-SECRET-3", nested: "NESTED-SECRET-4" };
    const { transport: t, sent } = transport();
    const shop = createDisclosedWallet(t, session, { destination: "shop" });
    await shop.call("x", { session_token: secrets.session, authToken: secrets.auth, bearer: secrets.bearer, deep: [{ "Shop-Access-Token": secrets.nested }], token_type_hint: "refresh_token" });
    expect(sent).toHaveLength(1);
    for (const value of Object.values(secrets)) expect(audit()).not.toContain(value);
    const body = bodyOf(disclosures()[0]);
    expect((body["redacted"] as { at: string }[]).map((r) => r.at)).toEqual(["body.session_token", "body.authToken", "body.bearer", "body.deep[0].Shop-Access-Token"]);
    // token_type_hint's last word is `hint`: it names a token, it is not one, and it stays readable.
    const loggedBody = JSON.parse(Buffer.from(body["body_b64"] as string, "base64").toString("utf8")) as Json;
    expect(loggedBody["token_type_hint"]).toBe("refresh_token");
    expect(await verifyFailures()).toEqual([]);
  });
});

describe("form bodies (OAuth endpoints)", () => {
  it("revocation: the token is digested in the logged form, the rest logged as sent, verify passes", async () => {
    const session = await setup();
    const { transport: t, sent } = transport({ form: true });
    const accounts = createDisclosedWallet(t, session, { destination: "shop_accounts" });
    await accounts.call("revoke", { token: REFRESH, token_type_hint: "refresh_token", client_id: "gw-client" });
    expect(Buffer.from(sent[0]?.body ?? []).toString("utf8")).toBe(form({ token: REFRESH, token_type_hint: "refresh_token", client_id: "gw-client" }));
    const body = bodyOf(disclosures()[0]);
    expect(body).toMatchObject({ endpoint: "revoke", destination: "shop_accounts", fields: ["client_id", "token", "token_type_hint"] });
    expect(Buffer.from(body["body_b64"] as string, "base64").toString("utf8")).toBe(form({ token: marker(REFRESH), token_type_hint: "refresh_token", client_id: "gw-client" }));
    expect(body["redacted"]).toEqual([{ at: "body.token", sha256: sha(REFRESH) }]);
    expect(audit()).not.toContain(REFRESH);
    expect(await verifyFailures()).toEqual([]);
  });

  it("attack: a form with a repeated name (one copy hidden from the scan) is refused; an email in a form is blocked", async () => {
    const session = await setup();
    const repeated = transport({ form: true, bytes: () => "q=ada%40example.com&q=lamp" });
    await expect(createDisclosedWallet(repeated.transport, session, { destination: "shop_accounts" }).call("revoke", {})).rejects.toBeInstanceOf(DisclosureRefusedError);
    const { transport: t, sent } = transport({ form: true });
    const accounts = createDisclosedWallet(t, session, { destination: "shop_accounts" });
    await expect(accounts.call("revoke", { token: "t", login_hint: "ada@example.com" })).rejects.toBeInstanceOf(DisclosureBlockedError);
    expect(repeated.sent.length + sent.length).toBe(0);
    expect(store.entries().map((e) => e.kind)).toEqual(["block", "block"]);
    expect(audit()).not.toContain("ada@example.com");
  });

  it("attack: a request with two content-type headers (a form read as JSON, or the reverse) is refused, never sent", async () => {
    const session = await setup();
    const sent: OutboundRequest[] = [];
    const twoTypes: DestinationTransport = {
      prepare: (operation) => ({
        operation,
        method: "POST",
        path: "/oauth/revoke",
        headers: [
          ["content-type", "application/json"],
          ["content-type", "application/x-www-form-urlencoded"],
        ],
        body: Buffer.from(JSON.stringify({ q: "lamp" })),
      }),
      send: (request) => {
        sent.push(request);
        return Promise.resolve({ status: 200, headers: [], body: Buffer.from("{}") });
      },
    };
    await expect(createDisclosedWallet(twoTypes, session, { destination: "shop_accounts" }).call("revoke", {})).rejects.toBeInstanceOf(DisclosureRefusedError);
    expect(sent).toHaveLength(0);
    expect(store.entries().map((e) => e.kind)).toEqual(["block"]);
  });

  it("attack: verify fails a hand-written chain whose form disclosure holds a token in clear", async () => {
    await setup();
    const bytes = Buffer.from(form({ token: REFRESH, client_id: "gw" }), "utf8");
    await store.append("session", { id: "s" });
    const { seq } = await store.append("disclosure", {
      endpoint: "revoke",
      method: "POST",
      path: "/oauth/revoke",
      fields: ["client_id", "token"],
      body_b64: bytes.toString("base64"),
      headers: [["content-type", "application/x-www-form-urlencoded"]],
      content_digest: `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
      destination: "shop_accounts",
      session: { id: "s", n: 0, open: [] },
    });
    await store.append("response", { disclosure_seq: seq, status: 200, body_sha256: sha("{}"), bytes: 2 });
    expect((await verifyFailures()).join("\n")).toContain("body.token is not redacted");
  });

  it("attack: verify fails a JSON disclosure holding a compound token name in clear", async () => {
    await setup();
    const bytes = Buffer.from(JSON.stringify({ session_token: "S" }), "utf8");
    await store.append("session", { id: "s" });
    const { seq } = await store.append("disclosure", {
      endpoint: "x",
      method: "POST",
      path: "/mcp",
      fields: ["session_token"],
      body_b64: bytes.toString("base64"),
      headers: [["content-type", "application/json"]],
      content_digest: `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
      destination: "shop",
      session: { id: "s", n: 0, open: [] },
    });
    await store.append("response", { disclosure_seq: seq, status: 200, body_sha256: sha("{}"), bytes: 2 });
    expect((await verifyFailures()).join("\n")).toContain("body.session_token is not redacted");
  });
});

describe("the MCP client name", () => {
  it("is let through under params._meta clientInfo only; another name there still blocks", async () => {
    const session = await setup();
    const { transport: t, sent } = transport();
    const shop = createDisclosedWallet(t, session, { destination: "shop" });
    const call = (clientInfo: Json) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_account", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": clientInfo } },
    });
    await shop.call("get_account", call({ name: "intent-gateway", version: "0.1.0" }));
    expect(sent).toHaveLength(1);
    await expect(shop.call("x", call({ name: "Ada Lovelace", version: "1" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    // Only the gateway's own name: another well-formed client name is a name like any other.
    await expect(shop.call("x", call({ name: "ada-lovelace", version: "1" }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    await expect(shop.call("x", call({ name: "intent-gateway", user: { name: "x" } }))).rejects.toBeInstanceOf(DisclosureBlockedError);
    expect(sent).toHaveLength(1);
  });
});
