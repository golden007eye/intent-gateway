// Evidence packs (plan G9, ADR-0018) over chains the real gateway wrote against the fake Intent Cloud: a pack
// verifies offline with nothing but the file and the verifier's pin; any changed field, or an entry taken from
// another purchase, fails and names what failed; a pack never holds a credential or buyer identity.
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purchaseChain, type PurchaseChain } from "../../test/support/purchase-chain.ts";
import { createDisclosedWallet, type DestinationTransport, openWalletSession } from "../disclosure/index.ts";
import { buildEvidence, type EvidencePack, packText, readPack } from "../evidence/index.ts";
import { canonicalize } from "../jcs/index.ts";
import { findIdentity } from "../privacy/index.ts";
import { contentDigest } from "../signing/index.ts";
import { type Entry, readChain } from "../store/index.ts";
import { loadWalletKey, saveSecret } from "../wallet/index.ts";
import { formatReport, type Report, runVerifyEvidence } from "./index.ts";

vi.setConfig({ testTimeout: 60_000 });

const chains: PurchaseChain[] = [];
afterEach(async () => {
  for (const c of chains.splice(0)) await c.close().catch(() => undefined);
});

async function started(): Promise<PurchaseChain> {
  const c = await purchaseChain();
  chains.push(c);
  return c;
}

const packOf = (c: PurchaseChain, handle: string): EvidencePack => buildEvidence(readChain(c.dir), handle, [c.rootPin]);
const verifyPack = (c: PurchaseChain, pack: unknown): Report => runVerifyEvidence({ text: `${canonicalize(pack)}\n`, pinnedRootKeys: [c.rootPin] });
const failures = (report: Report): string => report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.details.join("; ")}`).join("\n");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const kinds = (pack: EvidencePack) => (pack.entries as Entry[]).map((e) => e.kind);

describe("export, then verify", () => {
  it("round trip: an ordered purchase's pack verifies offline, with its proof, receipts and outcome statement re-checked", async () => {
    const c = await started();
    await c.buy(1);
    const handle = await c.buy(0, { ordered: true });
    const pack = packOf(c, handle);
    const text = packText(pack);
    expect(readPack(text)).toEqual({ ok: true, pack });
    const report = runVerifyEvidence({ text, pinnedRootKeys: [c.rootPin] });
    expect(failures(report)).toBe("");
    expect(report.exitCode).toBe(0);
    const chain = readChain(c.dir) as Entry[];
    const head = chain.at(-1) as Entry;
    expect(report.head).toEqual({ seq: head.seq, hash: head.hash });
    expect(pack.skeleton).toHaveLength(chain.length);
    expect(report.counts).toMatchObject({ approvals: 1, outcomes: 2, discarded: 0 });
    expect(report.counts.receipts).toBeGreaterThanOrEqual(4);
    const text_ = formatReport(report);
    expect(text_).toMatch(/^purchase: ok\n {2}holds search: 1, cart request: 1, approval request: 1, approval pending: 1, approval: 1, status read: \d+, outcome: 2,/m);
    expect(text_).toContain("re-checked: 2 (handed_off: 1, ordered: 1)");
    expect(text_).toMatch(/verify: ok\n$/);
    // Only this purchase: the other purchase's approval is in the skeleton, not in the pack.
    const other = chain.filter((e) => e.kind === "approval" && (e.body as { handle: string }).handle !== handle);
    expect(other).toHaveLength(1);
    expect(pack.entries.some((e) => (e as Entry).hash === other[0]?.hash)).toBe(false);
    expect(kinds(pack)).not.toContain("approver_flag");
    expect(kinds(pack)).not.toContain("wallet");
  });

  it("a purchase with no outcome yet: the pack verifies and holds no outcome entry", async () => {
    const c = await started();
    const handle = await c.buy(0);
    const pack = packOf(c, handle);
    expect(kinds(pack)).not.toContain("outcome");
    const report = verifyPack(c, pack);
    expect(failures(report)).toBe("");
    expect(report.checks.map((check) => check.name)).not.toContain("outcomes");
    expect(report.counts.approvals).toBe(1);
  });

  it("no pack for a handle the chain has no verified approval for", async () => {
    const c = await started();
    await c.buy(0);
    expect(() => packOf(c, "ap_NOSUCHHANDLE000000")).toThrow(/no purchase ap_NOSUCHHANDLE000000 to export: no approval_pending entry names it/);
  });

  it("verifies under the verifier's pin only: a pack whose root another verifier does not pin fails, naming pinned_root", async () => {
    const c = await started();
    const handle = await c.buy(0);
    const x = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
    const report = runVerifyEvidence({ text: packText(packOf(c, handle)), pinnedRootKeys: [{ kid: c.rootPin.kid, jwk: { kty: "OKP", crv: "Ed25519", x } }] });
    expect(report.exitCode).toBe(1);
    expect(failures(report)).toMatch(/pinned_root\[0\]: root key \S+ is not one this verifier pins/);
  });
});

describe("attack: a changed pack fails, naming what changed", () => {
  it("every leaf of the pack, changed by one character, fails verify", async () => {
    const c = await started();
    const handle = await c.buy(0, { ordered: true });
    const pack = packOf(c, handle);
    let changed = 0;
    for (const path of leaves(pack)) {
      const tampered = clone(pack) as unknown as Record<string, unknown>;
      set(tampered, path, changeOne(get(tampered, path)));
      const report = verifyPack(c, tampered);
      expect(report.exitCode, `changing ${path.join(".")} went unnoticed`).toBe(1);
      changed += 1;
    }
    expect(changed).toBeGreaterThan(200);
  });

  it.each([
    ["a byte of an entry's body", (p: Mutable) => (entry(p, "approval_pending").body.total_minor = 1), /entries\[\d+\]: hash does not match the entry/],
    ["a skeleton hash", (p: Mutable) => ((p.skeleton[1] as { hash: string }).hash = "f".repeat(64)), /skeleton\[2\]\.prev is not the hash of the row before it/],
    ["the head", (p: Mutable) => (p.head.hash = "0".repeat(64)), /head is not the skeleton's last row/],
    ["the purchase", (p: Mutable) => (p.purchase = "ap_SOMEOTHERHANDLE000"), /no approval_pending entry names it/],
    ["an extra field", (p: Mutable) => (p.note = "trust me"), /not an evidence pack v1 \(pack: Unrecognized key: "note"/],
    ["the format version", (p: Mutable) => (p.v = 2), /not an evidence pack v1 \(v:/],
  ])("%s", async (_name, change, named) => {
    const c = await started();
    const pack = clone(packOf(c, await c.buy(0))) as unknown as Mutable;
    change(pack);
    const report = verifyPack(c, pack);
    expect(report.exitCode).toBe(1);
    expect(failures(report)).toMatch(named);
  });

  it("a file edited by hand (not canonical JSON any more) fails", async () => {
    const c = await started();
    const text = packText(packOf(c, await c.buy(0)));
    const report = runVerifyEvidence({ text: JSON.stringify(JSON.parse(text), null, 2), pinnedRootKeys: [c.rootPin] });
    expect(report.exitCode).toBe(1);
    expect(failures(report)).toMatch(/not canonical JSON/);
  });

  it("an entry swapped in from another purchase fails: the approval, then the cart request", async () => {
    const c = await started();
    const mine = await c.buy(0);
    const theirs = await c.buy(1);
    const pack = packOf(c, mine);
    const chain = readChain(c.dir) as Entry[];
    const swap = (kind: string, pick: (e: Entry) => boolean): EvidencePack => {
      const ownIndex = pack.entries.findIndex((e) => (e as Entry).kind === kind && !pick(e as Entry));
      const foreign = chain.find((e) => e.kind === kind && pick(e));
      if (ownIndex < 0 || foreign === undefined) throw new Error(`nothing to swap for ${kind}`);
      const entries = (pack.entries as Entry[]).filter((_, i) => i !== ownIndex).concat(foreign).sort((a, b) => a.seq - b.seq);
      return { ...pack, entries };
    };
    const approval = verifyPack(c, swap("approval", (e) => (e.body as { handle: string }).handle === theirs));
    expect(approval.exitCode).toBe(1);
    expect(failures(approval)).toMatch(new RegExp(`seq \\d+: the approval entry is not part of purchase ${mine}`));
    expect(failures(approval)).toContain("no approval entry names it");
    const theirCart = packOf(c, theirs).entries.find((e) => (e as Entry).kind === "disclosure" && ((e as Entry).body as { endpoint: string }).endpoint === "createCart") as Entry;
    const cart = verifyPack(c, swap("disclosure", (e) => e.hash === theirCart.hash));
    expect(cart.exitCode).toBe(1);
    expect(failures(cart)).toMatch(new RegExp(`seq ${String(theirCart.seq)}: the disclosure entry is not part of purchase ${mine}`));
  });
});

describe("attack: no credential and no buyer identity in a pack", () => {
  const TOKEN = "shop-refresh-token-SECRET-0123456789";
  const VAULTED = "shop-vault-access-token-SECRET-ABCDEFGH";

  it("a wallet request with a token (logged as a redaction marker), a vault and completer keys on disk: the pack holds the marker, never a secret", async () => {
    const c = await started();
    const handle = await c.buy(0);
    // A token saved in the vault, as `intent wallet link shop` leaves it.
    const key = await loadWalletKey({ kind: "default", path: join(c.dir, "wallet.key") }, { create: true });
    if (key === null) throw new Error("no wallet key");
    await saveSecret(c.dir, "shop", key, VAULTED);
    // A request to Shop for this purchase that carries a token: the disclosure core logs only its digest.
    const transport: DestinationTransport = {
      prepare: (operation, payload) => ({
        operation,
        method: "POST",
        path: "/mcp",
        headers: [["host", "shop.example"], ["content-type", "application/json"], ["authorization", `Bearer ${VAULTED}`]],
        body: Buffer.from(JSON.stringify(payload), "utf8"),
      }),
      send: () => Promise.resolve({ status: 200, headers: [["content-type", "application/json"]], body: Buffer.from("{}") }),
    };
    const shop = createDisclosedWallet(transport, openWalletSession(c.store), { destination: "shop" });
    await shop.call("get_checkout", { refresh_token: TOKEN, checkout: "c1" }, { purchase: handle });

    const pack = packOf(c, handle);
    const text = packText(pack);
    expect(kinds(pack)).toContain("response");
    expect(text).toContain("[redacted sha256:");
    for (const secret of [TOKEN, VAULTED, Buffer.from(TOKEN).toString("base64"), Buffer.from(VAULTED).toString("base64")]) expect(text).not.toContain(secret);
    // Nothing from the files beside the chain: the vault, the wallet key, the completer keys.
    for (const file of secretFiles(c.dir)) {
      for (const value of strings(readFileSync(file, "utf8"))) expect(text, `${file} leaked into the pack`).not.toContain(value);
    }
    // What the pack says was sent holds no buyer identity (the merchant's `name` in Intent Cloud's snapshot is
    // Intent Cloud's content, which the outbound rules would flag as a key, so the scan is over sent bodies).
    for (const e of pack.entries as Entry[]) {
      const b = e.body as { body_b64?: string; destination?: string };
      if (e.kind === "disclosure" && b.body_b64 !== undefined && b.body_b64 !== "") {
        expect(findIdentity(JSON.parse(Buffer.from(b.body_b64, "base64").toString("utf8")), { mcpEnvelope: b.destination !== undefined })).toEqual([]);
      }
    }
    expect(failures(verifyPack(c, pack))).toBe("");
  });

  it("a chain whose sent body holds buyer identity (written around the disclosure core) gives a pack that fails, naming it", async () => {
    const c = await started();
    const handle = await c.buy(0);
    const bytes = Buffer.from(JSON.stringify({ deliver_to: "jane@mail.example" }), "utf8");
    await c.store.append("disclosure", {
      endpoint: "get_checkout",
      destination: "shop",
      method: "POST",
      path: "/mcp",
      fields: ["deliver_to"],
      body_b64: bytes.toString("base64"),
      headers: [["content-type", "application/json"]],
      content_digest: contentDigest(bytes),
      purchase: handle,
    });
    const report = verifyPack(c, packOf(c, handle));
    expect(report.exitCode).toBe(1);
    expect(failures(report)).toMatch(/seq \d+: the disclosure entry holds what looks like buyer identity \(email at \$\.deliver_to\)/);
  });
});

// ---- helpers ------------------------------------------------------------------------------------------------------

/** A pack being tampered with: its fields writable, any extra field allowed. */
interface Mutable {
  [field: string]: unknown;
  purchase: string;
  v: number;
  head: { seq: number; hash: string };
  skeleton: { seq: number; prev: string; hash: string }[];
  entries: { kind: string; body: Record<string, unknown> }[];
}

function entry(pack: Mutable, kind: string): { body: Record<string, unknown> } {
  const found = pack.entries.find((e) => e.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} entry`);
  return found;
}

type Path = (string | number)[];

/** Every leaf (string, number, boolean, null) of a JSON value, as a path. */
function leaves(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...path, i]));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [path];
}

function get(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)[k], root);
}

function set(root: unknown, path: Path, value: unknown): void {
  const parent = get(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path.at(-1) as string | number] = value;
}

/** The value with one character (or one unit) changed. */
function changeOne(value: unknown): unknown {
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value === null) return "x";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === "") return "x";
  const i = Math.floor(s.length / 2);
  return s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
}

/** The files the data dir keeps beside the chain that hold secrets: the vault, the wallet key, the completer keys. */
function secretFiles(dir: string): string[] {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => !name.startsWith("audit."))
    .map((name) => join(dir, name));
  const found = files.filter((f) => /vault|wallet|completer\/.+/.test(f));
  expect(found.some((f) => f.includes("completer"))).toBe(true);
  return found.filter((f) => {
    try {
      readFileSync(f);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * What must not leak from a secret file: a completer key's private key (its PEM body, line by line), or else every
 * long run of the file's text (JSON string values, or the whole text when it is not JSON). A completer key's keyid
 * is public: the cart request sends it.
 */
function strings(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text.trim().length >= 16 ? [text.trim()] : [];
  }
  const pem = (value as { private_key_pem?: unknown }).private_key_pem;
  if (typeof pem === "string") {
    const lines = pem.split("\n").filter((l) => l.length >= 16 && !l.startsWith("-----"));
    expect(lines.length).toBeGreaterThan(0);
    return [...lines, lines.join("")];
  }
  return leaves(value)
    .map((p) => get(value, p))
    .filter((v): v is string => typeof v === "string" && v.length >= 16);
}
