// The key statement (Appendix F): the only way the gateway learns Intent Cloud's receipt and approval keys, the
// confirm origin and the passkey rp_id. It must be signed by a root key pinned for the host.
import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";
import { KeyStatement } from "../contract/index.ts";
import { canonicalize } from "../jcs/index.ts";
import { ed25519Key, fromBase64Url, parseTimestamp } from "./bytes.ts";

/** A root public key pinned for one host; the shape of `RootKey` in src/config. */
export interface PinnedRootKey {
  readonly kid: string;
  readonly jwk: Readonly<JsonWebKey>;
}

/** What a verified statement lets the gateway trust. Only `verifyStatement` makes one (checked at run time). */
export interface KeySet {
  readonly rootKid: string;
  readonly receiptKeys: ReadonlyMap<string, KeyObject>;
  readonly approvalKeys: ReadonlyMap<string, KeyObject>;
  readonly confirmOrigin: string;
  readonly rpId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type StatementFailure =
  | { ok: false; step: 1; reason: "schema" | "bad_timestamp" | "lifetime" | "key_count" | "duplicate_kid" | "bad_key" }
  | { ok: false; step: 2; reason: "root_not_pinned" | "bad_signature" }
  | { ok: false; step: 3; reason: "issued_in_future" | "expired" };

export type StatementResult = { ok: true; keySet: KeySet } | StatementFailure;

const DAY_MS = 86_400_000;
const MIN_LIFETIME_MS = 90 * DAY_MS;
const MAX_LIFETIME_MS = 180 * DAY_MS;
/** How far `issued_at` may be ahead of the gateway's clock (Appendix F, step 3). */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SIGNING_PREFIX = "intent-statement-v1\n";

interface Trusted {
  receipt: ReadonlyMap<string, KeyObject>;
  approval: ReadonlyMap<string, KeyObject>;
  confirmOrigin: string;
  rpId: string;
  expiresAtMs: number;
}

// The verifiers read keys, origin and rp_id from this private copy, so editing a KeySet's public fields, or
// building a look-alike object, gives an attacker nothing.
const trusted = new WeakMap<KeySet, Trusted>();

/**
 * Verifies a key statement against the root keys pinned for its host at time `now` (Appendix F), adding the rules
 * the schema leaves out: a 90 to 180 day lifetime, 1 or 2 keys per use, unique kids, and keys that decode to
 * 32 bytes.
 */
export function verifyStatement(statement: unknown, pinnedRootKeys: readonly PinnedRootKey[], now: Date): StatementResult {
  const parsed = KeyStatement.safeParse(statement);
  if (!parsed.success) return fail(1, "schema");
  const st = parsed.data;

  const issuedAtMs = parseTimestamp(st.issued_at);
  const expiresAtMs = parseTimestamp(st.expires_at);
  if (issuedAtMs === null || expiresAtMs === null) return fail(1, "bad_timestamp");
  const lifetime = expiresAtMs - issuedAtMs;
  if (lifetime < MIN_LIFETIME_MS || lifetime > MAX_LIFETIME_MS) return fail(1, "lifetime");

  const receipt = new Map<string, KeyObject>();
  const approval = new Map<string, KeyObject>();
  for (const key of st.keys) {
    if (receipt.has(key.kid) || approval.has(key.kid)) return fail(1, "duplicate_kid");
    const publicKey = ed25519Key(key.x);
    if (publicKey === null) return fail(1, "bad_key");
    (key.kid.startsWith("cloud-receipt-") ? receipt : approval).set(key.kid, publicKey);
  }
  if (![receipt.size, approval.size].every((n) => n >= 1 && n <= 2)) return fail(1, "key_count");

  const root = pinnedRootKeys.find((k) => k.kid === st.kid);
  const rootKey = root === undefined ? null : rootPublicKey(root.jwk);
  if (rootKey === null) return fail(2, "root_not_pinned");
  const { signature, ...unsigned } = st;
  const signed = Buffer.from(SIGNING_PREFIX + canonicalize(unsigned), "utf8");
  const sig = fromBase64Url(signature);
  if (sig === null || !verify(null, signed, rootKey, sig)) return fail(2, "bad_signature");

  if (issuedAtMs - now.getTime() > MAX_CLOCK_SKEW_MS) return fail(3, "issued_in_future");
  if (now.getTime() >= expiresAtMs) return fail(3, "expired");

  const keySet: KeySet = Object.freeze({
    rootKid: st.kid,
    receiptKeys: new Map(receipt),
    approvalKeys: new Map(approval),
    confirmOrigin: st.confirm_origin,
    rpId: st.rp_id,
    issuedAt: new Date(issuedAtMs),
    expiresAt: new Date(expiresAtMs),
  });
  trusted.set(keySet, { receipt, approval, confirmOrigin: st.confirm_origin, rpId: st.rp_id, expiresAtMs });
  return { ok: true, keySet };
}

/**
 * The trusted keys of a KeySet that `verifyStatement` made and that has not expired at `now`, or null. After
 * `expires_at` the gateway trusts no key of that host until it has a newer valid statement (fail closed).
 */
export function trustedKeys(keySet: KeySet, now: Date): Trusted | "not_verified" | "expired" {
  const t = trusted.get(keySet);
  if (t === undefined) return "not_verified";
  return now.getTime() < t.expiresAtMs ? t : "expired";
}

function rootPublicKey(jwk: Readonly<JsonWebKey>): KeyObject | null {
  try {
    const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
    // A pinned key of another type would make verify(null, …) run a different algorithm.
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function fail<S extends StatementFailure["step"]>(step: S, reason: Extract<StatementFailure, { step: S }>["reason"]): StatementFailure {
  return { ok: false, step, reason } as StatementFailure;
}
