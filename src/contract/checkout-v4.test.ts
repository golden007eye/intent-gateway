// Contract 1.7.1 vectors a4 (snapshot v4, coarse postcodes, submitted postcodes, country currencies, currency tables), e3 (step 7 for v4), h1 (account key
// thumbprints) and h2 (pause signatures), replayed against src/contract's pure rules.
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, nonIntegerToken, parseIntegerJson, sha256Hex } from "../jcs/index.ts";
import {
  accountKeyThumbprint,
  CheckoutRequest,
  CoarseShipTo,
  checkoutRefHash,
  checkoutRequestProblems,
  coarsePostcode,
  continueUrlAllowed,
  continueUrlHash,
  CurrencyTable,
  currencyTableVersion,
  isCoarsePostcode,
  PauseRequest,
  SnapshotV4,
  snapshotV4Problem,
  usableCurrencyTable,
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

  // A submitted postcode must already be coarse, and in its own country's form (else Intent Cloud answers 400).
  it.each((a4.submitted as Obj[]).map((c) => [`${c.country as string} ${JSON.stringify(c.postal_code)}`, c] as const))("submitted %s", (_, c) => {
    const accepted = CoarseShipTo.safeParse({ country: c.country, postal_code: c.postal_code }).success && isCoarsePostcode(c.country as string, c.postal_code as string);
    expect(accepted).toBe(c.accepted);
  });

  const countryCurrencies = a4.country_currencies as { countries: Record<string, string>; cases: { country: string; currency: string; refused: string | null }[] };
  it.each(countryCurrencies.cases.map((c) => [`${c.country} in ${c.currency}`, c] as const))("country currency: %s", (_, c) => {
    expect(countryCurrencies.countries[c.country] === c.currency ? null : "currency_unsupported").toBe(c.refused);
  });

  type Table = { version: string; currencies: Record<string, { order: number; week: number }>; countries?: Record<string, string>; jcs: string };
  it.each((a4.currency_tables as Table[]).map((c) => [c.version, c] as const))("currency table %s", (_, c) => {
    const hashed = c.countries === undefined ? c.currencies : { currencies: c.currencies, countries: c.countries };
    expect(canonicalize(hashed)).toBe(c.jcs);
    expect(currencyTableVersion(c)).toBe(c.version);
    // The gateway uses only a 1.7.1 table: one without countries (1.7.0's form) is not used.
    expect(usableCurrencyTable(CurrencyTable.parse({ version: c.version, currencies: c.currencies, ...(c.countries === undefined ? {} : { countries: c.countries }) }))).toBe(c.countries !== undefined);
  });

  it("attack: a table whose countries were changed after its version was taken is not used", () => {
    const table = (a4.currency_tables as Table[])[0] as Table;
    expect(usableCurrencyTable({ version: table.version, currencies: table.currencies, countries: { ...table.countries, GB: "EUR" } })).toBe(false);
    expect(usableCurrencyTable({ version: table.version, currencies: table.currencies })).toBe(false);
  });

  it("attack: a table that lists a currency without two decimals is not used, even when its version is right", () => {
    const body = { currencies: { USD: { order: 1, week: 1 }, JPY: { order: 1, week: 1 } }, countries: { US: "USD" } };
    expect(usableCurrencyTable({ version: currencyTableVersion(body), ...body })).toBe(false);
  });
});

describe("currency table keys (the spec has no propertyNames)", () => {
  it.each(["usd", "US", "USDX", "", "U$D"])("attack: the key %j is refused", (key) => {
    expect(CurrencyTable.safeParse({ version: "ct-0000000000000000", currencies: { [key]: { order: 1, week: 1 } } }).success).toBe(false);
  });
  it.each(["us", "USA", "", "U1"])("attack: the country key %j is refused", (key) => {
    expect(CurrencyTable.safeParse({ version: "ct-0000000000000000", currencies: { USD: { order: 1, week: 1 } }, countries: { [key]: "USD" } }).success).toBe(false);
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
