// The target the contract suite runs against, chosen by TARGET (plan §3.3, G23):
// - `fake` (the default, and what `pnpm test` runs in CI): the fake Intent Cloud on 127.0.0.1, pinned with its own
//   test root key (`cloud.keys.rootPin`), on a fixed clock.
// - `staging`: https://staging-api.intentai.shop on the real clock. Its root key comes from PINNED_HOSTS once one is
//   committed there; until then from the key file named by TRUST_KEYS (what `--trust-keys` takes), JSON of the form
//   `{"rootKeys": [{"kid": "cloud-root-1", "jwk": {"kty": "OKP", "crv": "Ed25519", "x": "…"}}]}`.
// The same assertions run against both. Only what a target cannot do is limited to the fake: approving with a
// passkey (staging needs a phone) and setting a quota low enough to provoke a 429.
//
// Nothing here catches a network error: when the host is unreachable the suite fails (R3-5, an outage is red).
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createHttpCloud, type CloudResult, type IntentCloud, type PreparedRequest } from "../../src/cloud/index.ts";
import { type FakeCloud, type Quotas, startFakeCloud } from "../../src/cloud-fake/index.ts";
import { PINNED_HOSTS } from "../../src/config/index.ts";
import { CONTRACT_VERSION } from "../../src/contract/index.ts";
import { createSession, type Session } from "../../src/signing/index.ts";
import { type KeySet, type PinnedRootKey, type SentRequest, verifyReceipt, verifyStatement } from "../../src/trust/index.ts";

export const STAGING_HOST = "staging-api.intentai.shop";
const FAKE_CLOCK = Date.parse("2026-10-15T12:00:00Z");

export type TargetName = "fake" | "staging";

/** TARGET from the environment; anything other than unset, `fake` or `staging` is an error, never a fallback. */
export function targetName(env: Readonly<Record<string, string | undefined>> = process.env): TargetName {
  const value = env.TARGET ?? "fake";
  if (value !== "fake" && value !== "staging") throw new Error(`TARGET must be "fake" or "staging", got ${JSON.stringify(value)}`);
  return value;
}

export const TARGET = targetName();
export const IS_FAKE = TARGET === "fake";

export interface Target {
  readonly name: TargetName;
  readonly baseUrl: string;
  readonly rootKeys: readonly PinnedRootKey[];
  /** The fake itself (for the passkey and quota steps), or null on staging. */
  readonly fake: FakeCloud | null;
  now(): Date;
  /** An adapter on a fresh session key. */
  connect(session?: Session): IntentCloud;
  close(): Promise<void>;
}

const RootKeyFile = z.object({
  rootKeys: z
    .array(z.object({ kid: z.string().min(1), jwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string() }) }))
    .min(1),
});

/** The staging root keys: the committed pin, else the TRUST_KEYS key file. Throws when there is neither. */
export function stagingRootKeys(env: Readonly<Record<string, string | undefined>> = process.env): readonly PinnedRootKey[] {
  const pinned = Object.hasOwn(PINNED_HOSTS, STAGING_HOST) ? (PINNED_HOSTS[STAGING_HOST]?.rootKeys ?? []) : [];
  if (pinned.length > 0) return pinned;
  const path = env.TRUST_KEYS;
  if (path === undefined || path === "") {
    throw new Error(`no root key is pinned for ${STAGING_HOST} in this build; set TRUST_KEYS to a key file`);
  }
  return RootKeyFile.parse(JSON.parse(readFileSync(path, "utf8"))).rootKeys;
}

const opened: Target[] = [];

/** Closes every target opened in this file; for afterAll, so a failed beforeAll leaves nothing to trip over. */
export async function closeTargets(): Promise<void> {
  await Promise.all(opened.splice(0).map((t) => t.close()));
}

/** Opens the target. `quotas` applies to the fake only. */
export async function openTarget(options: { quotas?: Partial<Quotas> } = {}): Promise<Target> {
  const target = await open(options);
  opened.push(target);
  return target;
}

async function open(options: { quotas?: Partial<Quotas> }): Promise<Target> {
  if (TARGET === "staging") {
    const baseUrl = `https://${STAGING_HOST}`;
    return {
      name: "staging",
      baseUrl,
      rootKeys: stagingRootKeys(),
      fake: null,
      now: () => new Date(),
      connect: (session = createSession()) => createHttpCloud({ baseUrl, session }),
      close: () => Promise.resolve(),
    };
  }
  const clock = FAKE_CLOCK;
  const fake = await startFakeCloud({ now: () => clock, ...(options.quotas === undefined ? {} : { quotas: options.quotas }) });
  return {
    name: "fake",
    baseUrl: fake.url,
    rootKeys: [fake.keys.rootPin],
    fake,
    now: () => new Date(clock),
    connect: (session = createSession()) => createHttpCloud({ baseUrl: fake.url, session, now: () => clock }),
    close: () => fake.close(),
  };
}

/** Fetches the key statement and verifies it against the target's root pin; throws when it does not verify. */
export async function trustedKeySet(target: Target): Promise<KeySet> {
  const result = await target.connect().keyStatement();
  if (!result.ok) throw new Error(`GET /v1/key-statement answered ${String(result.status)}`);
  const verified = verifyStatement(result.body, target.rootKeys, target.now());
  if (!verified.ok) throw new Error(`key statement does not verify: step ${String(verified.step)} ${verified.reason}`);
  return verified.keySet;
}

/** The sha256 of SHA256SUMS that contract/SOURCE.md records. */
export function sourceSums(): string {
  const text = readFileSync(join(import.meta.dirname, "..", "..", "contract", "SOURCE.md"), "utf8");
  const found = /sha256 of `SHA256SUMS`: `([0-9a-f]{64})`/.exec(text)?.[1];
  if (found === undefined) throw new Error("contract/SOURCE.md records no SHA256SUMS hash");
  return found;
}

const PROFILE_INPUT = /^sig1=\("@method" "@path" "content-digest"\);created=(\d+);nonce="([^"]*)";keyid="([^"]*)";alg="ed25519";tag="intent-gateway-v1"$/;

/**
 * What a request sent, in receipt terms. `bodyDigest` overrides the digest when the body on the wire is not the one
 * the content-digest header names (the edge computes the receipt's digest from what it received).
 */
export function sentOf(
  request: { method: string; path: string; headers: readonly (readonly [string, string])[] },
  bodyDigest?: string,
): SentRequest {
  const header = (name: string): string | undefined => request.headers.find(([k]) => k.toLowerCase() === name)?.[1];
  const digest = bodyDigest ?? header("content-digest");
  if (digest === undefined) throw new Error("request has no content-digest");
  const profile = PROFILE_INPUT.exec(header("signature-input") ?? "");
  return {
    method: request.method,
    path: request.path,
    content_digest: digest,
    ...(profile === null ? {} : { created: Number(profile[1]), nonce: profile[2] ?? "", keyid: profile[3] ?? "" }),
  };
}

/** Checks an adapter result: the contract version header and a receipt that verifies for the request sent. */
export function receiptProblem(result: CloudResult<unknown>, keySet: KeySet, now: Date): string | null {
  if (result.contractVersion !== CONTRACT_VERSION) return `Intent-Contract-Version is ${String(result.contractVersion)}`;
  const verified = verifyReceipt(
    { status: result.status, receipt: result.receipt?.header, signature: result.receipt?.signature },
    sentOf(result.raw.request),
    keySet,
    now,
  );
  return verified.ok ? null : `receipt step ${String(verified.step)} ${verified.reason}`;
}

export interface RawReply {
  status: number;
  headers: Record<string, string | undefined>;
  json: unknown;
}

/**
 * Sends one request outside the adapter, for the statuses the adapter never provokes (an unsigned or mismatched
 * request). `headers` is the whole header set apart from host and content-length.
 */
export function sendRaw(
  target: Target,
  request: { method: "GET" | "POST"; path: string; headers: readonly (readonly [string, string])[]; body: Uint8Array },
): Promise<RawReply> {
  const url = new URL(target.baseUrl);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        method: request.method,
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: request.path,
        agent: false,
        headers: { ...Object.fromEntries(request.headers), "content-length": String(request.body.length), connection: "close" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = text;
          try {
            json = JSON.parse(text);
          } catch {
            // left as text; the caller's schema check fails on it
          }
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
          resolve({ status: res.statusCode ?? 0, headers, json });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error(`no response from ${url.host} within 30 s`)));
    req.on("error", reject);
    req.end(request.body.length > 0 ? request.body : undefined);
  });
}

/** Checks a raw reply the same way as receiptProblem. */
export function rawReceiptProblem(reply: RawReply, sent: SentRequest, keySet: KeySet, now: Date): string | null {
  if (reply.headers["intent-contract-version"] !== CONTRACT_VERSION) {
    return `Intent-Contract-Version is ${String(reply.headers["intent-contract-version"])}`;
  }
  const verified = verifyReceipt(
    { status: reply.status, receipt: reply.headers["intent-receipt"], signature: reply.headers["intent-receipt-signature"] },
    sent,
    keySet,
    now,
  );
  return verified.ok ? null : `receipt step ${String(verified.step)} ${verified.reason}`;
}

/** Captures the request the adapter would send for `call`, without sending it. */
export async function prepared(call: (beforeSend: (r: PreparedRequest) => void) => Promise<unknown>): Promise<PreparedRequest> {
  let captured: PreparedRequest | undefined;
  const stop = new Error("captured");
  try {
    await call((r) => {
      captured = r;
      throw stop;
    });
  } catch (error) {
    if (error !== stop) throw error;
  }
  if (captured === undefined) throw new Error("the adapter sent nothing to capture");
  return captured;
}
