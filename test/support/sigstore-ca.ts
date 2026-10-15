// A local, offline stand-in for the Sigstore public-good instance, for supplychain tests: a test Fulcio-style CA,
// a test Rekor log and a test CT log, all with keys generated per run. It issues real X.509 certificates (with an
// embedded SCT), signs real DSSE envelopes and real tlog entries (inclusion promise and a one-leaf inclusion proof),
// so the production verifier runs unchanged with only the trusted root swapped for this one.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

// --- minimal DER encoder ---------------------------------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const octet = (b: Buffer): Buffer => tlv(0x04, b);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.from([unused]), b);
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 + n, inner);
function int(n: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let b = Buffer.from(hex, "hex");
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * (arcs[0] ?? 0) + (arcs[1] ?? 0)];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
}
const name = (cn: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const ext = (id: string, value: Buffer, critical = false): Buffer =>
  critical ? seq(oid(id), bool(true), octet(value)) : seq(oid(id), octet(value));

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();
const u16 = (n: number): Buffer => Buffer.from([n >> 8, n & 0xff]);
const u24 = (n: number): Buffer => Buffer.from([n >> 16, (n >> 8) & 0xff, n & 0xff]);
const b64 = (b: Buffer): string => b.toString("base64");

interface KeyPair {
  privateKey: KeyObject;
  spki: Buffer;
}
function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, spki: publicKey.export({ type: "spki", format: "der" }) };
}

interface CertSpec {
  serial: number;
  issuer: string;
  subject: string;
  notBefore: Date;
  notAfter: Date;
  spki: Buffer;
  extensions: Buffer[];
}
const tbs = (c: CertSpec): Buffer =>
  seq(
    explicit(0, int(2)),
    int(c.serial),
    ECDSA_SHA256,
    name(c.issuer),
    seq(utcTime(c.notBefore), utcTime(c.notAfter)),
    name(c.subject),
    c.spki,
    explicit(3, seq(...c.extensions)),
  );
const certificate = (tbsDer: Buffer, signer: KeyObject): Buffer =>
  seq(tbsDer, ECDSA_SHA256, bits(sign("sha256", tbsDer, signer)));

// --- the test instance -----------------------------------------------------------------------------------------

export const TEST_REKOR_URL = "https://rekor.sigstore-test.example";
export const TEST_FULCIO_URL = "https://fulcio.sigstore-test.example";
export const TEST_CTLOG_URL = "https://ctfe.sigstore-test.example";

export interface Identity {
  /** The certificate's SAN URI (for GitHub Actions: the workflow ref). */
  san: string;
  /** The OIDC issuer recorded in the Fulcio issuer extensions. */
  issuer: string;
}

export interface TestSigstore {
  /** Sigstore trusted root (protobuf JSON) that trusts only this instance. */
  trustedRoot: Record<string, unknown>;
  /** Sign an in-toto statement as `identity` and return a v0.3 Sigstore bundle (JSON). */
  attest(statement: unknown, identity: Identity): Record<string, unknown>;
}

const LOG_VALID_FROM = "2020-01-01T00:00:00Z";

export function createTestSigstore(signingTime = new Date("2026-09-01T12:00:00Z")): TestSigstore {
  const ca = keyPair();
  const rekor = keyPair();
  const ctlog = keyPair();
  const rekorLogId = sha256(rekor.spki);
  const ctLogId = sha256(ctlog.spki);
  const caCert = certificate(
    tbs({
      serial: 1,
      issuer: "sigstore-test-ca",
      subject: "sigstore-test-ca",
      notBefore: new Date("2020-01-01T00:00:00Z"),
      notAfter: new Date("2040-01-01T00:00:00Z"),
      spki: ca.spki,
      extensions: [ext("2.5.29.19", seq(bool(true)), true), ext("2.5.29.15", bits(Buffer.from([0x06]), 1), true)],
    }),
    ca.privateKey,
  );

  const logEntry = (kp: KeyPair) => ({
    hashAlgorithm: "SHA2_256",
    publicKey: { rawBytes: b64(kp.spki), keyDetails: "PKIX_ECDSA_P256_SHA_256", validFor: { start: LOG_VALID_FROM } },
    logId: { keyId: b64(sha256(kp.spki)) },
  });
  const trustedRoot = {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [{ baseUrl: TEST_REKOR_URL, ...logEntry(rekor) }],
    certificateAuthorities: [
      {
        subject: { organization: "sigstore-test", commonName: "sigstore-test-ca" },
        uri: TEST_FULCIO_URL,
        certChain: { certificates: [{ rawBytes: b64(caCert) }] },
        validFor: { start: LOG_VALID_FROM },
      },
    ],
    ctlogs: [{ baseUrl: TEST_CTLOG_URL, ...logEntry(ctlog) }],
    timestampAuthorities: [],
  };

  let serial = 100;
  const issueLeaf = (identity: Identity, leafSpki: Buffer): Buffer => {
    const base: CertSpec = {
      serial: serial++,
      issuer: "sigstore-test-ca",
      subject: "",
      notBefore: new Date(signingTime.getTime() - 60_000),
      notAfter: new Date(signingTime.getTime() + 10 * 60_000),
      spki: leafSpki,
      extensions: [
        ext("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
        ext("2.5.29.17", seq(tlv(0x86, Buffer.from(identity.san, "ascii"))), true),
        ext("1.3.6.1.4.1.57264.1.1", Buffer.from(identity.issuer, "ascii")),
        ext("1.3.6.1.4.1.57264.1.8", utf8(identity.issuer)),
      ],
    };
    // RFC 6962 §3.2: the SCT signs the TBS without the SCT extension, prefixed by the issuer key hash.
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(BigInt(signingTime.getTime()));
    const preTbs = tbs(base);
    const signed = Buffer.concat([
      Buffer.from([0, 0]),
      timestamp,
      u16(1),
      sha256(ca.spki),
      u24(preTbs.length),
      preTbs,
      u16(0),
    ]);
    const sig = sign("sha256", signed, ctlog.privateKey);
    const sct = Buffer.concat([Buffer.from([0]), ctLogId, timestamp, u16(0), Buffer.from([4, 3]), u16(sig.length), sig]);
    const list = Buffer.concat([u16(sct.length + 2), u16(sct.length), sct]);
    const finalTbs = tbs({ ...base, extensions: [...base.extensions, ext("1.3.6.1.4.1.11129.2.4.2", octet(list))] });
    return certificate(finalTbs, ca.privateKey);
  };

  let logIndex = 0;
  const attest = (statement: unknown, identity: Identity): Record<string, unknown> => {
    const leaf = keyPair();
    const cert = issueLeaf(identity, leaf.spki);
    const payloadType = "application/vnd.in-toto+json";
    const payload = Buffer.from(JSON.stringify(statement), "utf8");
    const pae = Buffer.concat([
      Buffer.from(`DSSEv1 ${String(payloadType.length)} ${payloadType} ${String(payload.length)} `, "utf8"),
      payload,
    ]);
    const sig = sign("sha256", pae, leaf.privateKey);

    const body = Buffer.from(
      JSON.stringify({
        apiVersion: "0.0.1",
        kind: "dsse",
        spec: {
          payloadHash: { algorithm: "sha256", value: sha256(payload).toString("hex") },
          signatures: [{ signature: b64(sig), verifier: b64(cert) }],
        },
      }),
      "utf8",
    );
    const index = logIndex++;
    const integratedTime = Math.floor(signingTime.getTime() / 1000);
    // Keys in RFC 8785 order: body, integratedTime, logID, logIndex.
    const setPayload = `{"body":"${b64(body)}","integratedTime":${String(integratedTime)},"logID":"${rekorLogId.toString("hex")}","logIndex":${String(index)}}`;
    const set = sign("sha256", Buffer.from(setPayload, "utf8"), rekor.privateKey);
    // One-leaf tree: the root is the leaf hash and the proof has no hashes.
    const root = sha256(Buffer.concat([Buffer.from([0]), body]));
    const origin = new URL(TEST_REKOR_URL).host;
    const note = `${origin} - test\n1\n${b64(root)}\n`;
    const noteSig = Buffer.concat([rekorLogId.subarray(0, 4), sign("sha256", Buffer.from(note, "utf8"), rekor.privateKey)]);

    return {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: b64(cert) },
        tlogEntries: [
          {
            logIndex: String(index),
            logId: { keyId: b64(rekorLogId) },
            kindVersion: { kind: "dsse", version: "0.0.1" },
            integratedTime: String(integratedTime),
            inclusionPromise: { signedEntryTimestamp: b64(set) },
            inclusionProof: {
              logIndex: "0",
              rootHash: b64(root),
              treeSize: "1",
              hashes: [],
              checkpoint: { envelope: `${note}\n— ${origin} ${b64(noteSig)}\n` },
            },
            canonicalizedBody: b64(body),
          },
        ],
        timestampVerificationData: {},
      },
      dsseEnvelope: { payload: b64(payload), payloadType, signatures: [{ sig: b64(sig), keyid: "" }] },
    };
  };

  return { trustedRoot, attest };
}
