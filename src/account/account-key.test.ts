// The account key (ADR-0021): made once, mode 0600, never overwritten; its thumbprint follows RFC 7638 and its
// signatures are Ed25519 (RFC 8037 test vectors). Attack cases: a file that is not a key, or whose public half does
// not match its private half, is refused and left as it was.
import { createPublicKey, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_KEY_FILE, AccountKeyError, ensureAccountKey, jwkThumbprint, loadAccountKey } from "./index.ts";

// RFC 8037 Appendix A.1 (the Ed25519 key), A.3 (its RFC 7638 thumbprint) and A.4 (a signature).
const RFC8037 = {
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  thumbprint: "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
  input: "eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc",
  signature: "hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg",
};

const dataDir = (): string => join(mkdtempSync(join(tmpdir(), "account-key-")), "data");

describe("account key", () => {
  it("thumbprint: the RFC 8037 A.3 vector (members crv, kty, x in that order)", () => {
    expect(jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: RFC8037.x })).toBe(RFC8037.thumbprint);
  });

  it("signs as Ed25519: the RFC 8037 A.4 vector, from a key file holding the A.1 key", async () => {
    const dir = dataDir();
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, ACCOUNT_KEY_FILE), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: RFC8037.x, d: RFC8037.d }), { mode: 0o600 });
    const key = await loadAccountKey(dir);
    expect(key?.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: RFC8037.x });
    expect(key?.thumbprint).toBe(RFC8037.thumbprint);
    expect(Buffer.from(key?.sign(Buffer.from(RFC8037.input)) ?? []).toString("base64url")).toBe(RFC8037.signature);
  });

  it("is made once, mode 0600 in a 0700 data dir, and never overwritten", async () => {
    const dir = dataDir();
    const first = await ensureAccountKey(dir);
    expect(first.created).toBe(true);
    const file = join(dir, ACCOUNT_KEY_FILE);
    expect(first.key.path).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const bytes = readFileSync(file, "utf8");
    const second = await ensureAccountKey(dir);
    expect(second.created).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(second.key.publicJwk).toEqual(first.key.publicJwk);
    expect(Object.keys(first.key.publicJwk).sort()).toEqual(["crv", "kty", "x"]);
    expect(first.key.publicJwk.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The public half verifies what the key signs.
    const message = Buffer.from("intent-pause-v1\n{}");
    const publicKey = createPublicKey({ key: { ...first.key.publicJwk }, format: "jwk" });
    expect(verify(null, message, publicKey, first.key.sign(message))).toBe(true);
  });

  it("attack: a file that is not an account key, or whose halves disagree, is refused and left as it is", async () => {
    const dir = dataDir();
    await ensureAccountKey(dir);
    const file = join(dir, ACCOUNT_KEY_FILE);
    const other = (await ensureAccountKey(dataDir())).key.publicJwk.x;
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (const text of ["not json", "{}", JSON.stringify({ ...stored, x: other }), JSON.stringify({ ...stored, crv: "X25519" })]) {
      writeFileSync(file, text);
      await expect(ensureAccountKey(dir)).rejects.toThrow(AccountKeyError);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    // The message never carries key material.
    writeFileSync(file, JSON.stringify({ ...stored, x: other }));
    const error = await ensureAccountKey(dir).catch((e: unknown) => e);
    expect(String(error)).not.toContain(stored.d ?? "-");
    expect(String(error)).not.toContain(other);
  });
});
