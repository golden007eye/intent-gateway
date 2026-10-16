import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_HOSTS } from "../src/config/index.ts";
import { TEST_ROOT_KEY } from "../src/trust/index.ts";
import { annotation, checkStatement, expiryVerdict, KEY_STATEMENT_URL, rootKeysFor } from "./statement-expiry.ts";

const DAY = 86_400_000;
// Vector s1: a statement signed by the published test root, expiring 2026-11-30T00:00:00Z.
const S1 = JSON.parse(readFileSync(new URL("../contract/vectors/s1-key-statement.json", import.meta.url), "utf8")) as {
  expected: { statement: Record<string, unknown> };
};
const statement = S1.expected.statement;
const expiresAt = new Date("2026-11-30T00:00:00Z");
const daysBefore = (days: number): Date => new Date(expiresAt.getTime() - days * DAY);
const url = "https://cloud.example/v1/key-statement";

function serving(status: number, body: unknown): typeof fetch {
  return (() => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
}

describe("expiryVerdict", () => {
  it("fails with 13 days left", () => {
    const v = expiryVerdict(expiresAt, daysBefore(13));
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/13\.0 days from now: fewer than 14 days left/);
  });

  it("passes with 15 days left", () => {
    expect(expiryVerdict(expiresAt, daysBefore(15))).toEqual({
      ok: true,
      message: "the key statement expires at 2026-11-30T00:00:00.000Z, 15.0 days from now",
    });
  });

  it.each([
    [14, true],
    [13.99, false],
    [0, false],
    [-3, false],
  ])("%d days left → ok %s", (days, ok) => {
    expect(expiryVerdict(expiresAt, daysBefore(days)).ok).toBe(ok);
  });
});

describe("checkStatement", () => {
  const opts = { url, rootKeys: [TEST_ROOT_KEY] };

  it("passes a statement signed by the pinned root with 15 days left", async () => {
    expect(await checkStatement({ ...opts, now: daysBefore(15), fetch: serving(200, statement) })).toMatchObject({ ok: true });
  });

  it("fails the same statement with 13 days left", async () => {
    const v = await checkStatement({ ...opts, now: daysBefore(13), fetch: serving(200, statement) });
    expect(v).toMatchObject({ ok: false, message: expect.stringMatching(/fewer than 14 days left/) as unknown });
  });

  it("attack: a statement with a later expires_at but the old signature does not verify", async () => {
    const forged = { ...statement, expires_at: "2027-02-20T00:00:00Z" };
    const v = await checkStatement({ ...opts, now: daysBefore(13), fetch: serving(200, forged) });
    expect(v).toEqual({ ok: false, message: "the key statement does not verify against the pinned root (Appendix F step 2: bad_signature)" });
  });

  it("attack: a statement signed by a root that is not pinned does not verify", async () => {
    const other = { kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" } };
    const v = await checkStatement({ url, rootKeys: [other], now: daysBefore(30), fetch: serving(200, statement) });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/does not verify against the pinned root \(Appendix F step 2/);
  });

  it("fails an expired statement", async () => {
    const v = await checkStatement({ ...opts, now: expiresAt, fetch: serving(200, statement) });
    expect(v).toEqual({ ok: false, message: "the key statement does not verify against the pinned root (Appendix F step 3: expired)" });
  });

  it("fails with no root key to verify against, without fetching", async () => {
    const never = (() => Promise.reject(new Error("fetched"))) as typeof fetch;
    expect(await checkStatement({ url, rootKeys: [], now: daysBefore(30), fetch: never })).toEqual({
      ok: false,
      message: "no root key is pinned for cloud.example; set the TRUST_KEYS file or pin the key (docs/release.md)",
    });
  });

  it.each([
    ["an HTTP error", serving(503, "down"), /answered HTTP 503/],
    ["a body that is not JSON", serving(200, "<html>"), /cannot read/],
    ["an oversized body", serving(200, "x".repeat(70_000)), /more than 65536 bytes/],
    ["a network failure", (() => Promise.reject(new Error("ECONNREFUSED"))), /cannot read .*ECONNREFUSED/],
  ])("fails on %s (an outage is red, never skipped)", async (_name, doFetch, message) => {
    const v = await checkStatement({ ...opts, now: daysBefore(30), fetch: doFetch });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(message);
  });
});

describe("rootKeysFor", () => {
  it("reads a TRUST_KEYS file", () => {
    const dir = mkdtempSync(join(tmpdir(), "statement-expiry-"));
    const path = join(dir, "keys.json");
    writeFileSync(path, JSON.stringify({ rootKeys: [TEST_ROOT_KEY] }));
    expect(rootKeysFor(KEY_STATEMENT_URL, path)).toEqual([TEST_ROOT_KEY]);
    writeFileSync(path, JSON.stringify({ keys: [] }));
    expect(() => rootKeysFor(KEY_STATEMENT_URL, path)).toThrow(/is not \{"rootKeys": \[\.\.\.\]\}/);
  });

  it("uses the build's pin for the staging host without a file", () => {
    expect(rootKeysFor(KEY_STATEMENT_URL)).toBe(PINNED_HOSTS["staging-api.intentai.shop"]?.rootKeys);
    expect(rootKeysFor("https://constructor/v1/key-statement")).toEqual([]);
  });
});

describe("annotation", () => {
  it("is a notice when ok and an error otherwise, escaped to one line", () => {
    expect(annotation({ ok: true, message: "fine" })).toBe("::notice title=Key statement::fine");
    expect(annotation({ ok: false, message: "50% left\nnext" })).toBe("::error title=Key statement::50%25 left%0Anext");
  });
});
