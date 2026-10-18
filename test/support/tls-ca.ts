// A throwaway TLS certificate authority for tests: a CA and server certificates for given DNS names, with keys made
// per run (nothing secret is committed). Real X.509 (P-256, ECDSA-SHA256, a subjectAltName), so Node's own
// verification runs unchanged; a test trusts the CA through tls.setDefaultCACertificates and restores it afterwards.
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const octet = (b: Buffer): Buffer => tlv(0x04, b);
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.from([unused]), b);
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
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}
const name = (cn: string): Buffer => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
const ext = (id: string, value: Buffer, critical = false): Buffer => (critical ? seq(oid(id), bool(true), octet(value)) : seq(oid(id), octet(value)));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const pem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;

function issue(issuer: string, subject: string, spki: Buffer, signer: KeyObject, extensions: Buffer[]): string {
  const serial = randomBytes(8);
  serial[0] = ((serial[0] ?? 0) & 0x3f) | 0x40; // positive, and no leading zero byte (minimal DER)
  const day = 24 * 3600 * 1000;
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name(issuer),
    seq(utcTime(new Date(Date.now() - day)), utcTime(new Date(Date.now() + day))),
    name(subject),
    spki,
    tlv(0xa3, seq(...extensions)),
  );
  return pem(seq(tbs, ECDSA_SHA256, bits(sign("sha256", tbs, signer))));
}

const keyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

export interface TestCa {
  /** The CA certificate (PEM), to trust. */
  readonly cert: string;
  /** A server certificate and its key (PEM) for these DNS names, issued by this CA. */
  server(...dnsNames: string[]): { cert: string; key: string };
}

export function createTestCa(cn = "intent-gateway test CA"): TestCa {
  const ca = keyPair();
  const caSpki = ca.publicKey.export({ type: "spki", format: "der" });
  const cert = issue(cn, cn, caSpki, ca.privateKey, [ext("2.5.29.19", seq(bool(true)), true), ext("2.5.29.15", bits(Buffer.from([0x06]), 1), true)]);
  return {
    cert,
    server(...dnsNames) {
      const leaf = keyPair();
      const san = seq(...dnsNames.map((n) => tlv(0x82, Buffer.from(n, "ascii"))));
      const leafCert = issue(cn, dnsNames[0] ?? "server", leaf.publicKey.export({ type: "spki", format: "der" }), ca.privateKey, [
        ext("2.5.29.19", seq(), true),
        ext("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
        ext("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))),
        ext("2.5.29.17", san),
      ]);
      return { cert: leafCert, key: leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    },
  };
}
