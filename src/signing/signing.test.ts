// Sessions, the signer and the appendix-C rejection table. Attack requests are built here with node:crypto directly,
// so a request that deviates from the profile is still correctly signed and only the profile check can refuse it.
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  contentDigest,
  createNonceCache,
  createSession,
  isEd25519PublicKey,
  type RejectCode,
  sessionFromSeed,
  SigningError,
  signRequest,
  verifyRequest,
} from "./index.ts";

const SEED = Buffer.from("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f", "hex");
const KEYID = "gw-Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc";
const NONCE = "bm9uY2UtdGVzdC0wMDAwMg==";
const NOW = 1790251200;
const BODY = Buffer.from('{"quantity":1}', "utf8");
const REQUEST: { method: string; path: string; body: Uint8Array } = { method: "POST", path: "/v1/carts", body: BODY };
const key = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]),
  format: "der",
  type: "pkcs8",
});

interface Forge {
  label?: string;
  params?: string;
  digest?: string;
  method?: string;
  path?: string;
}
// A request signed with the c2 test key over whatever signature parameters the attack names.
function forge(over: Forge = {}): Record<string, string> {
  const digest = over.digest ?? contentDigest(BODY);
  const sigParams =
    over.params ??
    `("@method" "@path" "content-digest");created=${String(NOW)};nonce="${NONCE}";keyid="${KEYID}";alg="ed25519";tag="intent-gateway-v1"`;
  const base = `"@method": ${over.method ?? "POST"}\n"@path": ${over.path ?? "/v1/carts"}\n"content-digest": ${digest}\n"@signature-params": ${sigParams}`;
  const label = over.label ?? "sig1";
  return {
    "Content-Digest": digest,
    "Signature-Input": `${label}=${sigParams}`,
    Signature: `${label}=:${sign(null, Buffer.from(base), key).toString("base64")}:`,
  };
}
const params = (p: { created?: number; nonce?: string; keyid?: string; alg?: string; tag?: string; tail?: string }) =>
  `("@method" "@path" "content-digest");created=${String(p.created ?? NOW)};nonce="${p.nonce ?? NONCE}";keyid="${p.keyid ?? KEYID}";alg="${p.alg ?? "ed25519"}";tag="${p.tag ?? "intent-gateway-v1"}"${p.tail ?? ""}`;

const check = (headers: Record<string, string | string[]>, now = NOW, request = REQUEST) =>
  verifyRequest(headers, request, { now, seenNonce: createNonceCache() });
const rejected = (code: RejectCode) => ({ ok: false, code, status: code === "digest_mismatch" ? 400 : 401 });

// 32 bytes, little-endian y with the sign bit in bit 255 (RFC 8032 §5.1.2).
const point = (y: bigint, signBit = 0): string => {
  const raw = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) raw[i] = Number((y >> BigInt(8 * i)) & 0xffn);
  raw[31] = (raw[31] ?? 0) | (signBit << 7);
  return raw.toString("base64url");
};
// Found with Euler's criterion, independently of isEd25519PublicKey: for y = 2, (y²−1)/(d·y²+1) is not a square
// mod p, so no x exists; for y = 3 it is.
const NOT_A_POINT = point(2n);
const P = 2n ** 255n - 19n;

describe("sessions", () => {
  it("gives each session its own keyid in the gw- shape", () => {
    const keyids = new Set(Array.from({ length: 20 }, () => createSession().keyid));
    expect(keyids.size).toBe(20);
    for (const keyid of keyids) expect(keyid).toMatch(/^gw-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  });

  it("exposes no private key bytes", () => {
    const fixed = sessionFromSeed(SEED);
    const secrets = [SEED.toString("hex"), SEED.toString("base64"), SEED.toString("base64url")];
    for (const session of [fixed, createSession()]) {
      const views = [JSON.stringify(session), inspect(session, { showHidden: true, depth: null })];
      expect(Object.keys(session)).toEqual(["keyid"]);
      expect(Reflect.ownKeys(session)).toEqual(["keyid"]);
      expect(Object.getPrototypeOf(session)).toBe(Object.prototype);
      expect(JSON.stringify(session)).toBe(JSON.stringify({ keyid: session.keyid }));
      expect(Object.isFrozen(session)).toBe(true);
      for (const view of views) for (const secret of secrets) expect(view).not.toContain(secret);
    }
  });

  it("will not sign for an object it did not create", () => {
    expect(() => signRequest({ keyid: KEYID }, REQUEST)).toThrow(SigningError);
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => sessionFromSeed(Buffer.alloc(31))).toThrow(SigningError);
  });
});

describe("signRequest", () => {
  const session = createSession();

  it("signs with the current time and a fresh 16-byte nonce by default", () => {
    const now = Math.floor(Date.now() / 1000);
    const first = signRequest(session, REQUEST);
    const second = signRequest(session, REQUEST);
    const nonce = /;nonce="([^"]+)"/.exec(first["signature-input"])?.[1] ?? "";
    expect(Buffer.from(nonce, "base64url")).toHaveLength(16);
    expect(second["signature-input"]).not.toBe(first["signature-input"]);
    const seenNonce = createNonceCache();
    expect(verifyRequest(first, REQUEST, { now, seenNonce })).toMatchObject({ ok: true, keyid: session.keyid, nonce });
    expect(verifyRequest(second, REQUEST, { now, seenNonce }).ok).toBe(true);
  });

  it("carries the RFC 9530 digest of an empty body", () => {
    const headers = signRequest(session, { method: "GET", path: "/v1/meta", body: new Uint8Array() });
    expect(headers["content-digest"]).toBe("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:");
  });

  it.each([
    ["a query", { path: "/v1/carts?x=1" }],
    ["a fragment", { path: "/v1/carts#x" }],
    ["a relative path", { path: "v1/carts" }],
    ["a lowercase method", { method: "post" }],
    ["a 15-byte nonce", { nonce: randomBytes(15).toString("base64") }],
    ["a non-base64 nonce", { nonce: "not a nonce!!!!!!!!!!!!!" }],
    ["fractional created", { created: 1.5 }],
  ])("refuses %s", (_, over) => {
    expect(() => signRequest(session, { ...REQUEST, ...over })).toThrow(SigningError);
  });
});

describe("verifyRequest: appendix C rejection table", () => {
  it("accepts the unmodified attack baseline", () => {
    expect(check(forge())).toMatchObject({ ok: true, keyid: KEYID });
  });

  describe("missing or malformed headers, or any deviation from the profile: 401", () => {
    it.each(["Content-Digest", "Signature-Input", "Signature"])("missing %s", (name) => {
      const headers = Object.fromEntries(Object.entries(forge()).filter(([key]) => key !== name));
      expect(check(headers)).toEqual(rejected("missing_header"));
    });

    it.each([
      ["a repeated header", { "signature-input": ["a", "b"] }],
      ["a lowercase duplicate", { "content-digest": contentDigest(BODY) }],
      ["a garbage Signature-Input", { "Signature-Input": "sig1" }],
      ["a garbage Signature", { Signature: "sig1=u3IUXVI4" }],
      ["a Content-Digest with another algorithm", { "Content-Digest": "sha-512=:AAAA:" }],
      ["two digests", { "Content-Digest": `${contentDigest(BODY)}, sha-512=:AAAA:` }],
      ["a 63-byte signature", { Signature: `sig1=:${Buffer.alloc(63).toString("base64")}:` }],
      ["non-canonical signature base64", { Signature: `sig1=:${Buffer.alloc(64).toString("base64").slice(0, -2)}:` }],
    ])("%s", (_, over) => {
      expect(check({ ...forge(), ...over })).toEqual(rejected("malformed_header"));
    });

    it.each([
      ["created as a string", params({}).replace(`created=${String(NOW)}`, `created="${String(NOW)}"`)],
      ["negative created", params({}).replace(`created=${String(NOW)}`, "created=-1")],
      ["nonce as an integer", params({}).replace(`nonce="${NONCE}"`, "nonce=12345")],
    ])("%s", (_, p) => {
      expect(check(forge({ params: p }))).toEqual(rejected("malformed_header"));
    });

    it.each([
      ["another label", { label: "sig2" }],
      ["components in another order", { params: params({}).replace('"@method" "@path"', '"@path" "@method"') }],
      ["a missing component", { params: params({}).replace(' "content-digest"', "") }],
      ["an extra parameter", { params: params({ tail: ";expires=1790251300" }) }],
      ["a repeated parameter", { params: params({ tail: ';tag="intent-gateway-v1"' }) }],
      ["parameters in another order", { params: params({}).replace(/;created=\d+(;nonce="[^"]+")/, `$1;created=${String(NOW)}`) }],
      ["no tag", { params: params({}).replace(';tag="intent-gateway-v1"', "") }],
    ])("%s", (_, over) => {
      expect(check(forge(over))).toEqual(rejected("profile_mismatch"));
    });

    it("a Signature label that differs from Signature-Input", () => {
      const headers = forge();
      headers.Signature = headers.Signature?.replace(/^sig1/, "sig2") ?? "";
      expect(check(headers)).toEqual(rejected("profile_mismatch"));
    });

    it.each(["intent-gateway-v0", "intent-gateway-v2", ""])("another tag, correctly signed: %j", (tag) => {
      expect(check(forge({ params: params({ tag }) }))).toEqual(rejected("wrong_tag"));
    });

    it.each(["rsa-pss-sha512", "ED25519", "hmac-sha256"])("another alg, correctly signed: %s", (alg) => {
      expect(check(forge({ params: params({ alg }) }))).toEqual(rejected("wrong_alg"));
    });
  });

  it("Content-Digest that does not match the body: 400", () => {
    expect(check(forge(), NOW, { ...REQUEST, body: Buffer.from('{"quantity":3}') })).toEqual(rejected("digest_mismatch"));
    expect(check(forge(), NOW, { ...REQUEST, body: new Uint8Array() })).toEqual(rejected("digest_mismatch"));
  });

  describe("created older than 60 s or more than 5 s in the future: 401", () => {
    it.each([
      [NOW + 60, true],
      [NOW + 61, false],
      [NOW - 5, true],
      [NOW - 6, false],
    ])("at now = %i: accepted %s", (now, ok) => {
      const result = check(forge(), now);
      expect(result.ok).toBe(ok);
      if (!ok) expect(result).toEqual(rejected(now > NOW ? "created_too_old" : "created_in_future"));
    });
  });

  describe("nonce shorter than 128 bits, or not base64: 401", () => {
    it.each([
      ["15 bytes, base64", randomBytes(15).toString("base64"), "nonce_too_short"],
      ["15 bytes, base64url", randomBytes(15).toString("base64url"), "nonce_too_short"],
      ["empty", "", "nonce_not_base64"],
      ["mixed alphabets", "ab+cd_efghijklmnopqrstuv", "nonce_not_base64"],
      ["not base64", "nonce-test-00002!!!!!!!!", "nonce_not_base64"],
      ["non-canonical padding bits", "bm9uY2UtdGVzdC0wMDAwMh==", "nonce_not_base64"],
    ] as const)("%s", (_, nonce, code) => {
      expect(check(forge({ params: params({ nonce }) }))).toEqual(rejected(code));
    });

    it.each([
      ["16 bytes, base64url", randomBytes(16).toString("base64url")],
      ["32 bytes, base64", randomBytes(32).toString("base64")],
    ])("accepts %s", (_, nonce) => {
      expect(check(forge({ params: params({ nonce }) })).ok).toBe(true);
    });
  });

  describe("keyid malformed, or not a valid Ed25519 public key: 401", () => {
    it.each([
      ["no gw- prefix", KEYID.slice(3)],
      ["another prefix", `app-${KEYID.slice(3)}`],
      ["another prefix of the same length", `gx-${KEYID.slice(3)}`],
      ["too short", KEYID.slice(0, -1)],
      ["padded", `${KEYID}=`],
      ["standard base64 alphabet", KEYID.replace("_", "/")],
      ["non-zero padding bits", `${KEYID.slice(0, -1)}d`],
      ["32 bytes that are not a curve point", `gw-${NOT_A_POINT}`],
      ["y not below p", `gw-${point(P)}`],
      ["x = 0 with the sign bit set", `gw-${point(1n, 1)}`],
    ])("%s", (_, keyid) => {
      expect(check(forge({ params: params({ keyid }) }))).toEqual(rejected("bad_keyid"));
    });

    it("decodes curve points per RFC 8032", () => {
      expect(isEd25519PublicKey(Buffer.from(NOT_A_POINT, "base64url"))).toBe(false);
      expect(isEd25519PublicKey(Buffer.from(point(3n), "base64url"))).toBe(true);
      expect(isEd25519PublicKey(Buffer.from(point(1n), "base64url"))).toBe(true);
      expect(isEd25519PublicKey(Buffer.from(point(P - 1n), "base64url"))).toBe(true);
      expect(isEd25519PublicKey(new Uint8Array(31))).toBe(false);
      for (let i = 0; i < 50; i++) {
        expect(isEd25519PublicKey(Buffer.from(createSession().keyid.slice(3), "base64url"))).toBe(true);
      }
    });
  });

  describe("signature invalid: 401", () => {
    it.each([
      ["another method", { ...REQUEST, method: "PUT" }],
      ["another path", { ...REQUEST, path: "/v1/carts/x/approvals" }],
    ])("%s than was signed", (_, request) => {
      expect(check(forge(), NOW, request)).toEqual(rejected("bad_signature"));
    });

    it("another session's keyid on this signature", () => {
      const other = createSession().keyid;
      expect(check(forge({ params: params({ keyid: other }) }))).toEqual(rejected("bad_signature"));
    });
  });

  describe("nonce already seen: 401", () => {
    it("refuses a replay while the nonce is retained and records nonces only after the signature verifies", () => {
      const seenNonce = createNonceCache();
      const forged = { ...forge(), Signature: `sig1=:${Buffer.alloc(64, 1).toString("base64")}:` };
      expect(verifyRequest(forged, REQUEST, { now: NOW, seenNonce })).toEqual(rejected("bad_signature"));
      expect(verifyRequest(forge(), REQUEST, { now: NOW, seenNonce }).ok).toBe(true);
      expect(verifyRequest(forge(), REQUEST, { now: NOW + 30, seenNonce })).toEqual(rejected("replay"));
    });

    it("catches the same nonce bytes written in the other alphabet", () => {
      const bytes = Buffer.from([0xfb, 0xff, ...randomBytes(14)]);
      const seenNonce = createNonceCache();
      const first = forge({ params: params({ nonce: bytes.toString("base64") }) });
      const second = forge({ params: params({ nonce: bytes.toString("base64url") }) });
      expect(verifyRequest(first, REQUEST, { now: NOW, seenNonce }).ok).toBe(true);
      expect(verifyRequest(second, REQUEST, { now: NOW, seenNonce })).toEqual(rejected("replay"));
    });

    it("retains a nonce for 65 s, covering a request created 5 s ahead and replayed at the end of its window", () => {
      const created = NOW + 5;
      const headers = forge({ params: params({ created }) });
      const seenNonce = createNonceCache();
      expect(verifyRequest(headers, REQUEST, { now: NOW, seenNonce }).ok).toBe(true);
      expect(verifyRequest(headers, REQUEST, { now: created + 60, seenNonce })).toEqual(rejected("replay"));
    });

    it("forgets a nonce after 65 s", () => {
      const seenNonce = createNonceCache();
      expect(seenNonce(NONCE, NOW)).toBe(false);
      expect(seenNonce(NONCE, NOW + 65)).toBe(true);
      expect(seenNonce("b3RoZXItbm9uY2UtMDAwMDA=", NOW + 66)).toBe(false);
      expect(seenNonce(NONCE, NOW + 131)).toBe(false);
      expect(seenNonce(NONCE, NOW + 132)).toBe(true);
    });
  });
});
