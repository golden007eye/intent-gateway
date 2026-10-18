// Contract 1.7.0 vectors a4 (snapshot v4, coarse postcodes, currency tables), e3 (step 7 for v4), h1 (account key
// thumbprints) and h2 (pause signatures), replayed against src/contract's pure rules.
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, nonIntegerToken, parseIntegerJson, sha256Hex } from "../jcs/index.ts";
import {
  accountKeyThumbprint,
  CheckoutRequest,
  checkoutRefHash,
  checkoutRequestProblems,
  coarsePostcode,
  continueUrlAllowed,
  continueUrlHash,
  CurrencyTable,
  currencyTableVersion,
  PauseRequest,
  SnapshotV4,
  snapshotV4Problem,
} from "./index.ts";

type Obj = Record<string, unknown>;
const vector = (name: string): Obj => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", name), "utf8")) as Obj;
const a4 = vector("a4-snapshot-v4.json");
const rawA4 = readFileSync(join(import.meta.dirname, "..", "..", "contract", "vectors", "a4-snapshot-v4.json"), "utf8");
const e3 = vector("e3-snapshot-v4-request.json");
const h1 = vector("h1-account-key.json");
const h2 = vector("h2-pause.json");

/** The raw Ed25519 public key (base64url) of a 32-byte seed. TEST KEYS ONLY, from the vectors. */
function publicX(seedHex: string): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  return jwk.x as string;
}

describe("a4: snapshot v4", () => {
  it.each((a4.cases as Obj[]).map((c) => [c.name as string, c] as const))("%s: hash, check code, refs and keys", (_, c) => {
    const input = c.input as Obj;
    const expected = c.expected as Obj;
    const snapshot = input.snapshot as Obj;
    expect(SnapshotV4.parse(snapshot)).toEqual(snapshot);
    expect(snapshotV4Problem(snapshot)).toBeNull();
    expect(canonicalize(snapshot)).toBe(expected.jcs);
    expect(sha256Hex(canonicalize(snapshot))).toBe(expected.snapshot_hash);
    expect((expected.snapshot_hash as string).slice(0, 8)).toBe(expected.check_code);
    expect(checkoutRefHash(input.checkout_id as string)).toBe(snapshot.checkout_ref_hash);
    expect(`gw-${publicX(input.completer_seed_hex as string)}`).toBe(snapshot.completer_keyid);
    expect(accountKeyThumbprint({ kty: "OKP", crv: "Ed25519", x: publicX(input.account_seed_hex as string) })).toBe(snapshot.account_key_thumbprint);
    if (snapshot.completion_mode === "handoff") expect(continueUrlHash(input.continue_url as string)).toBe(snapshot.continue_url_hash);
    else expect(snapshot.continue_url_hash).toBeUndefined();
  });

  it.each((a4.invalid as Obj[]).map((c) => [c.name as string, c] as const))("invalid: %s is refused", (name) => {
    // JSON.parse reads 1807.0 as 1807: only the integer-profile parse that every answer goes through sees it.
    if (name === "a float total") expect(nonIntegerToken(rawA4)).toBe("1807.0");
    const strict = ((parseIntegerJson(rawA4) as Obj).invalid as Obj[]).find((i) => i.name === name) as Obj;
    expect(snapshotV4Problem(strict.snapshot)).not.toBeNull();
  });

  const urls = a4.continue_urls as { store_site: string; myshopify_domain: string; cases: { continue_url: string; allowed: boolean }[] };
  it("continue_urls: holds the 13 cases", () => {
    expect(urls.cases).toHaveLength(13);
  });
  it.each(urls.cases.map((c) => [c.continue_url, c] as const))("continue_url %s", (_, c) => {
    expect(continueUrlAllowed(c.continue_url, urls)).toBe(c.allowed);
  });

  it.each((a4.coarse as Obj[]).map((c) => [`${c.country as string} ${JSON.stringify(c.postal_code)}`, c] as const))("coarse %s", (_, c) => {
    expect(coarsePostcode(c.country as string, c.postal_code as string)).toBe(c.coarse);
  });

  it.each((a4.currency_tables as Obj[]).map((c) => [c.version as string, c] as const))("currency table %s", (_, c) => {
    expect(canonicalize(c.currencies)).toBe(c.jcs);
    expect(currencyTableVersion(c.currencies as Record<string, { order: number; week: number }>)).toBe(c.version);
  });
});

describe("currency table keys (the spec has no propertyNames)", () => {
  it.each(["usd", "US", "USDX", "", "U$D"])("attack: the key %j is refused", (key) => {
    expect(CurrencyTable.safeParse({ version: "ct-0000000000000000", currencies: { [key]: { order: 1, week: 1 } } }).success).toBe(false);
  });
  it("an empty table is refused, a USD one accepted", () => {
    expect(CurrencyTable.safeParse({ version: "ct-0000000000000000", currencies: {} }).success).toBe(false);
    expect(CurrencyTable.safeParse({ version: "ct-0000000000000000", currencies: { USD: { order: 1, week: 1 } } }).success).toBe(true);
  });
});

describe("e3: step 7 for a v4 snapshot against the CheckoutRequest sent", () => {
  it.each((e3.cases as Obj[]).map((c) => [c.name as string, c] as const))("%s", (_, c) => {
    const input = c.input as Obj;
    const expected = c.expected as Obj;
    const request = CheckoutRequest.parse(input.checkout_request);
    const refused = checkoutRequestProblems(input.snapshot ?? e3.snapshot, request);
    expect(refused).toEqual(expected.refused);
    expect(refused.length === 0).toBe(expected.valid);
  });
});

describe("h1: account key thumbprints", () => {
  it.each((h1.cases as Obj[]).map((c, i) => [i, c] as const))("case %i", (_, c) => {
    const input = c.input as Obj;
    const jwk = input.jwk as { kty: "OKP"; crv: "Ed25519"; x: string };
    expect(publicX(input.seed_hex as string)).toBe(jwk.x);
    expect(accountKeyThumbprint(jwk)).toBe((c.expected as Obj).thumbprint);
  });
});

describe("h2: pause signatures", () => {
  const key = createPublicKey({ key: { ...(h2.account_key as Obj), kty: "OKP", crv: "Ed25519" }, format: "jwk" });
  it.each((h2.cases as Obj[]).map((c) => [c.name as string, c] as const))("%s", (_, c) => {
    const input = c.input as Obj;
    const body = PauseRequest.parse(input.body);
    const signed = `intent-pause-v1\n${canonicalize({ account_key_thumbprint: body.account_key_thumbprint, counter: body.counter, issued_at: body.issued_at, action: "pause" })}`;
    expect(signed).toBe(input.signing_input);
    expect(verify(null, Buffer.from(signed, "utf8"), key, Buffer.from(body.signature, "base64url"))).toBe((c.expected as Obj).signature_valid);
  });
});
