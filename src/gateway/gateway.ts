// The gateway's use cases: find offers, create a cart and ask for approval, read the approval back. This is where
// the policy (invariant 1), the identity refusal (invariant 3) and the approval gate (invariant 4) meet; every call
// to Intent Cloud goes through the disclosed cloud, which logs before it sends (invariant 2).
//
// - Readiness: a search needs a product or category, a budget and a US ZIP. Missing ones are listed back for the
//   agent to ask about; the gateway never guesses one and calls nothing. Under a policy that blocks categories, the
//   category is required too: offers carry none of their own, so it is the only category the policy can check.
// - Identity: every tool input is scanned with findIdentity before any request is built. A finding writes a `block`
//   entry (kinds and paths, never values) and nothing is sent.
// - Policy: each outbound request is mapped onto the policy module's own types and evaluated (which applies
//   CLOUD_BASELINE). A refusal writes a `block` entry and nothing is sent. Offers that came back are filtered too.
//   A policy block also keeps, locally, the structured values it held back (`held`: the category "alcohol", the ZIP,
//   a cart's offer title): they never left the machine, and the identity check above already passed on them. Free
//   text the agent wrote (the search's `product`) is never kept: findIdentity finds emails, phones, cards and street
//   addresses, not a person's name in free text. An identity block never keeps a value.
// - Observations: after each answer whose receipt verified, an `observed` entry records a small summary of what Intent
//   Cloud returned (offers, the cart, the approval state) with any identity-looking value withheld. It is written after
//   the receipt, is never sent and answers no request, so log-before-send and `intent verify` are unchanged by it.
// - Approval: a cart is checked against the offer (merchant, quantity, variant, origin, completion mode) and the
//   policy before any approval is requested; the snapshot against the cart, the ZIP sent, the completer key made for
//   it and the caps, before the `approval_pending` entry is chained. "Approved" is reported only for a proof the
//   trust module verified against that entry, that was chained, and whose passkey is the pin.
// - Completer key (contract 1.6.0, ADR-0016): each cart gets a fresh Ed25519 key, saved to disk before the cart
//   request names it, so a restarted gateway (new session key) can still read the approval. A cart that goes no
//   further deletes it; otherwise the retention rules (retention.ts) do, on start and after each status call.
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  type ApprovalCreated,
  ApprovalHandle,
  ApprovalProof,
  type ApprovalStatus,
  type AnySnapshot,
  type Cart,
  type CartRequest as CloudCartRequest,
  type CompletionMode as CloudCompletionMode,
  CONTRACT_VERSION,
  type KeyStatement,
  type Offer as CloudOffer,
  type OutcomeState,
  OfferHandle,
  type SearchRequest as CloudSearchRequest,
} from "../contract/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  type DisclosedCloud,
  type DisclosedResult,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
  DisclosureRefusedError,
  DisclosureStoppedError,
} from "../disclosure/index.ts";
import { INTENT } from "../config/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { CLOUD_BASELINE, type CompletionMode as PolicyCompletionMode, evaluate, meet, type Offer as PolicyOffer, type Policy } from "../policy/index.ts";
import { observeApproval, observeCart, observeSearch, observeStatus } from "../observation/index.ts";
import { CloudOutcomeEntry, ORDER_REF, outcomesFor, readCloudOutcome, replaces, shownStatus, type StatementCheck } from "../outcome/index.ts";
import { findIdentity } from "../privacy/index.ts";
import type { CompleterKeys, Session } from "../signing/index.ts";
import { type Entry, type Store, StoreConflictError } from "../store/index.ts";
import {
  approverFingerprint,
  checkApprover,
  type FlagReason,
  type KeySet,
  onlyTestRoot,
  type PinnedRootKey,
  verifyApprovalProof,
  verifyOutcomeStatement,
  SENT_WORDS,
  readSent,
  stagingSourceAllowed,
  type SentPurchase,
  sentProblems,
  verifyStatement,
} from "../trust/index.ts";
import type { WalletAdapter } from "../wallet/index.ts";
import { advanceCompletion, type CompletionStep, type CompletionView } from "./complete.ts";
import { disclosedSince, spendHistory, summaryLine } from "./history.ts";
import { type ApprovalQr, approvalQr } from "./qr.ts";
import { expiredCompleterKeys } from "./retention.ts";
import { PROOF_STATES, statusProblem } from "./status-state.ts";

export interface GatewayLogger {
  /** One line for the developer's terminal (stderr): never for the agent. */
  warn(message: string): void;
}

export interface GatewayOptions {
  /**
   * Builds the disclosed cloud (disclosure's connectCloud). The gateway owns the verified key set and hands its
   * reader to the disclosed cloud here, so only a statement this gateway verified can unlock the signed calls.
   */
  cloud: (keySet: () => KeySet | null) => DisclosedCloud;
  store: Store;
  /** The completer keys of open purchases, `<data>/completer` (signing's openCompleterKeys). */
  completerKeys: CompleterKeys;
  /**
   * The gateway-wallet completion modes usable right now: a linked wallet whose adapter can complete a purchase
   * (`shop_agent` for the Shop wallet). Read at each cart. Default none, and nothing passes it until a wallet adapter
   * exists, so a cart offers only `handoff`, whatever the policy allows; a linked vault alone is not usable.
   */
  walletModes?: () => readonly CloudCompletionMode[];
  /**
   * One-tap with a linked wallet (plan G7b, ADR-0019). `connect` builds the wallet adapter once, behind the disclosed
   * cloud's log (src/disclosure's connectShop); null when no usable wallet is linked. With a wallet, carts offer its
   * mode (where the policy allows one_tap), and get_approval_status completes a verified `shop_agent` approval.
   */
  oneTap?: OneTapOptions;
  policy: Policy;
  /** The root keys pinned for the Intent Cloud host (config's PINNED_HOSTS, or `--trust-keys`). */
  pinnedRootKeys: readonly PinnedRootKey[];
  /** Milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to stderr. */
  logger?: GatewayLogger;
  /**
   * Demo mode: approval links point at the local demo confirm page (`http://127.0.0.1:<port>/confirm`) instead of
   * the statement's confirm origin, and the chain starts with a `session` entry `{mode: "demo"}`. start() accepts it
   * only when every pinned root key is the published test root, so a real Intent Cloud's approval links can never be
   * redirected. A demo chain and a real one never mix: each mode refuses the other's chain.
   */
  demo?: {
    confirmBaseUrl: string;
    /** A line added to a search that finds no offer, naming what the sample catalog holds ("The demo catalog has: …"). */
    catalogNote?: string;
  };
}

export interface OneTapOptions {
  readonly connect: (cloud: DisclosedCloud) => WalletAdapter | null;
  /** The rail's name for the merchant at a storefront origin (Shop: its myshopify domain); default: the host when it is one. */
  readonly storeFor?: (merchantOrigin: string) => string | null;
  /** Test seams (complete.ts). */
  readonly hook?: (step: CompletionStep) => void | Promise<void>;
  readonly newReportId?: () => string;
  readonly newKey?: () => string;
}

/**
 * The Shop store for a storefront origin (D7, decided): a merchant pairs its storefront origin with its
 * `*.myshopify.com` domain, which is how Shop names the store (S1: `shop=` and the order permalink host are the
 * myshopify domain, never the storefront's primary domain). Intent Cloud has not yet published the contract field
 * that will carry the pairing, so today only an origin that is itself a myshopify host names its store; every other
 * merchant is offered hand-off only.
 *
 * SEAM (D7): when Intent Cloud publishes the paired myshopify domain for an offer, it plugs in here (and in the
 * `storeFor` the completion step and the cart offer read): return the paired domain for that origin. Do not invent
 * the field before the contract names it.
 */
export function myshopifyStore(merchantOrigin: string): string | null {
  const host = /^https:\/\/([a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)$/.exec(merchantOrigin.toLowerCase())?.[1];
  return host ?? null;
}

/** The first entry of a demo chain. */
export const DEMO_SESSION = Object.freeze({ mode: "demo" });
const DEMO_CONFIRM_BASE = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/confirm$/;

/** Whether a chain was written in demo mode (its first entry is the demo session), or is still empty. */
export function chainMode(entries: readonly Entry[]): "empty" | "demo" | "normal" {
  const first = entries[0];
  if (first === undefined) return "empty";
  const body = first.body as { mode?: unknown } | null;
  return first.kind === "session" && typeof body === "object" && body !== null && body.mode === "demo" ? "demo" : "normal";
}

/** The sha256 of `contract/SHA256SUMS` this gateway was built with; Intent Cloud's Meta must report the same. */
export function contractSums(): string {
  // src/gateway and dist/gateway both sit two levels below the package root, next to `contract/`.
  return sha256Hex(readFileSync(new URL("../../contract/SHA256SUMS", import.meta.url)));
}

/** start() could not establish a trusted connection: the contract differs, or the key statement did not verify. */
export class GatewayStartError extends Error {
  override name = "GatewayStartError";
  /** The HTTP status when Intent Cloud's first request (meta) answered with an error: the host is up but not serving. */
  readonly metaStatus: number | null;
  constructor(message: string, metaStatus: number | null = null) {
    super(message);
    this.metaStatus = metaStatus;
  }
}

/** A tool was called before start() succeeded. */
export class GatewayNotStartedError extends Error {
  override name = "GatewayNotStartedError";
}

// ---- Tool inputs ----------------------------------------------------------------------------------------------

// The tool input schemas. The MCP module lists these very schemas to agents (as JSON Schema), so the descriptions
// are written for an agent: pass only what the user said, never guess.
export const FindOffersInput = z.strictObject({
  product: z.string().max(200).optional().describe("An exact product the user named. Give this or category."),
  category: z.string().max(60).optional().describe("The kind of product the user wants, such as running-shoes. Give this or product."),
  must_haves: z
    .array(z.string().min(1).max(60))
    .max(8)
    .optional()
    .describe("Features the user said the product must have, in their words."),
  budget_usd: z.number().optional().describe("The most the user said they will spend, in US dollars. Never guess it."),
  zip: z.string().optional().describe("The 5-digit US ZIP code the user said to ship to. Never guess it."),
});
export type FindOffersInput = z.input<typeof FindOffersInput>;

export const CreateCartInput = z.strictObject({
  offer_handle: OfferHandle.describe("The offer_handle of the offer the user picked, from find_offers."),
  quantity: z.int().min(1).max(3).optional().describe("How many the user asked for (1 to 3). Defaults to 1."),
});
export type CreateCartInput = z.input<typeof CreateCartInput>;

export const ApprovalStatusInput = z.strictObject({
  approval_handle: ApprovalHandle.describe("The approval_handle that create_cart returned."),
});
export type ApprovalStatusInput = z.input<typeof ApprovalStatusInput>;

// ---- Tool results ---------------------------------------------------------------------------------------------

/** A detail a search needs that the agent did not give. The agent asks the user for it; the gateway never guesses. */
export interface MissingDetail {
  readonly field: "product_or_category" | "category" | "budget_usd" | "zip";
  readonly ask: string;
}

/** Shared by every result: a sentence for the agent and the "Sent: … / Blocked: …" line. */
interface Told {
  readonly message: string;
  readonly summary: string;
}

/** Nothing was sent: the input was malformed, identity was found, or the policy refused the request. */
export type Refused = Told & { readonly status: "invalid" | "blocked" | "refused" | "error" };

export type FindOffersResult =
  | (Told & { readonly status: "needs_details"; readonly missing: readonly MissingDetail[] })
  | (Told & { readonly status: "offers"; readonly offers: readonly CloudOffer[]; readonly hidden: number })
  | Refused;

export type CreateCartResult =
  | (Told & {
      readonly status: "approval_needed";
      readonly approval_handle: string;
      readonly approval_url: string;
      readonly check_code: string;
      readonly qr: ApprovalQr;
      readonly cart: Cart;
    })
  | Refused;

/**
 * Intent Cloud's outcome as the gateway read it (ADR-0015): `state_shown` is never more than the verified statement
 * (rule O1, invariant 5); null when nothing was acted on (no statement, or one that did not verify).
 */
export interface ShownOutcome {
  /**
   * What the gateway shows: this read's outcome when its statement verified (and R5a lets it replace the one adopted
   * before), else the outcome adopted from an earlier verified statement, else null.
   */
  readonly state_shown: OutcomeState | null;
  /** True when `state_shown` comes from an earlier verified statement, not this read's. */
  readonly kept_earlier?: true;
  /** The order the shown outcome's statement names. */
  readonly order_ref?: string;
  /** Intent Cloud's own words in this read, as it served them. */
  readonly cloud_state: OutcomeState;
  readonly source: string;
  readonly assurance: string;
  /** Whether this read's statement verified. */
  readonly statement_verified: boolean;
  /** The rule this read's statement failed, when it did not verify. */
  readonly refused_by?: string;
}

export type ApprovalStatusResult =
  | (Told & {
      readonly status: "approved";
      /** What Intent Cloud reported after the approval, worded as its report: handed_off or ordered (from the verified statement only). */
      readonly cloud_reported?: "handed_off" | "ordered";
      /** The order the verified statement names, when it shows `ordered`. */
      readonly order_number?: string;
      readonly outcome?: ShownOutcome;
      /** A one-tap purchase: where the gateway's own completion stands (its evidence, never Intent Cloud's word). */
      readonly completion?: CompletionView;
      readonly fingerprint: string;
    })
  | (Told & { readonly status: "flagged"; readonly fingerprint: string })
  | (Told & { readonly status: "pending" | "rejected" | "expired" | "not_verified" | "unknown" })
  | Refused;

export interface Gateway {
  start(): Promise<void>;
  findOffers(input: unknown): Promise<FindOffersResult>;
  createCart(input: unknown): Promise<CreateCartResult>;
  getApprovalStatus(input: unknown): Promise<ApprovalStatusResult>;
}

interface RememberedOffer {
  readonly offer: CloudOffer;
  /** The category the search asked for ("" for a product-only search): offers carry none of their own. */
  readonly category: string;
  readonly zip: string;
}

const MAX_REMEMBERED_OFFERS = 500;
const US_ZIP = /^[0-9]{5}$/;
/** The contract's completion mode for each policy mode. */
const CONTRACT_MODE: Readonly<Record<PolicyCompletionMode, CloudCompletionMode>> = { handoff: "handoff", one_tap: "shop_agent" };

export function createGateway(options: GatewayOptions): Gateway {
  const { store, policy, pinnedRootKeys, completerKeys } = options;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? {
    warn: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
  };
  let keySet: KeySet | null = null;
  const cloud = options.cloud(() => keySet);
  let wallet: WalletAdapter | null = null;
  try {
    wallet = options.oneTap?.connect(cloud) ?? null;
  } catch (error) {
    logger.warn(`intent-gateway: the linked wallet cannot be used, so purchases are handed off: ${(error as Error).message}`);
  }
  const offers = new Map<string, RememberedOffer>();
  /** Approvals whose cart this process's session key created; any other is read with its completer key. */
  const createdHere = new Set<string>();
  let stopReported = false;

  // One call at a time: the spend caps and the replay check read the chain and then append to it.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  }

  function started(): KeySet {
    if (keySet === null) throw new GatewayNotStartedError("the gateway has not started: call start() first");
    return keySet;
  }

  const head = (): number => store.entries().at(-1)?.seq ?? -1;
  const summary = (fromSeq: number, extra: readonly string[] = []): string => summaryLine(disclosedSince(store.entries(), fromSeq), extra);

  /**
   * Writes a `block` entry and returns the refusal. Items name fields and rules. `held` (policy blocks only) keeps the
   * values the policy held back, which never left the machine; it is dropped whole if any of it looks like identity.
   */
  async function block(
    endpoint: string,
    fields: readonly string[],
    blocked: readonly string[],
    fromSeq: number,
    status: Refused["status"],
    message: string,
    held: Readonly<Record<string, unknown>> = {},
  ): Promise<Refused> {
    const keep = Object.keys(held).length > 0 && findIdentity(held).length === 0;
    await store.append("block", { endpoint, fields: [...fields], blocked: [...blocked], ...(keep ? { held: { ...held } } : {}) });
    return { status, message, summary: summary(fromSeq) };
  }

  /** Invariant 3, before anything is built from the input: identity anywhere in it means nothing is sent. */
  async function identityRefusal(endpoint: string, input: unknown, fromSeq: number): Promise<Refused | null> {
    const findings = findIdentity(input);
    if (findings.length === 0) return null;
    // A field name can itself be identity ({"jane@example.com": 1}); such a name is never written to the chain.
    const named = (text: string, kind: string): string => (findIdentity(text).length === 0 ? text : `${kind} in a field name`);
    return block(
      endpoint,
      inputFields(input).map((f) => named(f, "identity")),
      findings.map((f) => named(`${f.kind} at ${f.path}`, f.kind)),
      fromSeq,
      "blocked",
      "Not sent: the request contains buyer identity (a name, address, phone, email or card). The gateway never " +
        "sends or keeps it; the buyer gives it to the merchant at checkout. Remove it and try again.",
    );
  }

  /** Runs one disclosed call; a failure becomes a Refused naming what happened, never Cloud's content. */
  async function call<T>(
    run: () => Promise<DisclosedResult<T>>,
    fromSeq: number,
  ): Promise<{ ok: true; body: T; seq: number } | { ok: false; refused: Refused }> {
    const refuse = (status: Refused["status"], message: string) => ({ ok: false as const, refused: { status, message, summary: summary(fromSeq) } });
    let result: DisclosedResult<T>;
    try {
      result = await run();
    } catch (error) {
      if (error instanceof DisclosureBlockedError) return refuse("blocked", "Not sent: the request body looked like buyer identity.");
      // The reasons are the core's own words (a rule and a field name), never a value from the request.
      if (error instanceof DisclosureRefusedError) return refuse("blocked", `Not sent: ${error.reasons.join("; ")}.`);
      if (error instanceof DisclosureStoppedError) {
        // Said once on the terminal too: the developer must restart the gateway, the agent cannot fix it.
        if (!stopReported) logger.warn(`intent-gateway: ${error.message}. Restart the gateway, then run ${INTENT} verify.`);
        stopReported = true;
        return refuse("error", `Not sent: ${error.message}. The developer must restart the gateway.`);
      }
      if (error instanceof DisclosureDiscardedError) {
        return refuse("error", "Intent Cloud's answer carried no valid receipt, so the gateway discarded it.");
      }
      if (error instanceof DisclosureKeysExpiredError) {
        return refuse("error", `Not sent: the key statement expired on ${error.expiresAt.toISOString()}; restart the gateway to fetch a fresh one.`);
      }
      if (error instanceof DisclosureNoKeysError) return refuse("error", "No verified key statement: restart the gateway.");
      if (error instanceof CloudNetworkError) {
        // Invariant 5: with no connection made, the logged request never left, and the summary does not list it as sent.
        if (error.neverLeft) return refuse("error", `Not sent: ${error.message}, so the request never left this machine. Try again later.`);
        return refuse("error", `${error.message}; the request may have reached it, and is logged as sent but not acknowledged.`);
      }
      if (error instanceof CloudResponseError) return refuse("error", `Intent Cloud's answer was malformed (${error.reason}).`);
      if (error instanceof CloudRequestError) return refuse("invalid", `Not sent: ${error.message}`);
      throw error;
    }
    // Every answer must be in this gateway's contract version, not only Meta at start: an answer in another version
    // (a host that downgraded mid-session) is parsed under rules it does not follow, so its content is not used.
    // An answer with no version header at all is a non-2xx from in front of the edge, handled below.
    if (result.contractVersion !== CONTRACT_VERSION && (result.ok || result.contractVersion !== null)) {
      return refuse(
        "error",
        `Intent Cloud answered in contract ${result.contractVersion ?? "(none)"}, not ${CONTRACT_VERSION}, so the gateway did not use the answer. Restart the gateway to check the host again.`,
      );
    }
    if (result.ok) return { ok: true, body: result.body, seq: result.disclosureSeq };
    const said = result.body === null ? "" : `: ${result.body.message}`;
    const retry = result.retryAfter === null ? "" : ` Try again in ${String(result.retryAfter)} s.`;
    return refuse("error", `Intent Cloud answered ${String(result.status)}${said}.${retry}`);
  }

  // ---- start ----------------------------------------------------------------------------------------------------

  /** Demo mode only with the test root and a loopback confirm page; a chain only in the mode that started it. */
  async function checkMode(): Promise<void> {
    const mode = chainMode(store.entries());
    if (options.demo === undefined) {
      if (mode === "demo") {
        throw new GatewayStartError(
          `this data dir holds a demo chain (test keys, sample catalog); run \`${INTENT} demo\`, or use another data dir`,
        );
      }
      return;
    }
    if (!onlyTestRoot(pinnedRootKeys)) {
      throw new GatewayStartError("demo mode trusts only the published test root key; refusing other pinned keys");
    }
    if (!DEMO_CONFIRM_BASE.test(options.demo.confirmBaseUrl)) {
      throw new GatewayStartError("the demo confirm page must be http://127.0.0.1:<port>/confirm");
    }
    if (mode === "normal") {
      throw new GatewayStartError("this data dir holds a real chain; demo mode uses its own data dir (<data>/demo)");
    }
    if (mode === "empty") await store.append("session", DEMO_SESSION);
  }

  async function start(): Promise<void> {
    if (keySet !== null) return;
    await checkMode();
    const meta = await cloud.meta();
    if (!meta.ok) throw new GatewayStartError(`Intent Cloud meta failed with status ${String(meta.status)}`, meta.status);
    const sums = contractSums();
    const problems: string[] = [];
    if (meta.contractVersion !== CONTRACT_VERSION) {
      problems.push(`Intent-Contract-Version is ${meta.contractVersion ?? "missing"}`);
    }
    if (meta.body.contract_version !== CONTRACT_VERSION) problems.push(`Meta.contract_version is ${meta.body.contract_version}`);
    if (meta.body.contract_sums_sha256 !== sums) problems.push(`Meta.contract_sums_sha256 is ${meta.body.contract_sums_sha256}`);
    if (problems.length > 0) {
      throw new GatewayStartError(
        `contract mismatch: this gateway implements contract ${CONTRACT_VERSION} (SHA256SUMS sha256 ${sums}), but ` +
          `${problems.join("; ")}. Update the gateway, or point it at an Intent Cloud host that serves ${CONTRACT_VERSION}.`,
      );
    }

    const statement = await cloud.keyStatement();
    if (!statement.ok) throw new GatewayStartError(`Intent Cloud key statement failed with status ${String(statement.status)}`);
    const verified = await chainStatement(statement.body);
    if (typeof verified === "string") throw new GatewayStartError(verified);
    keySet = verified;
    await collectKeys();
  }

  /** Deletes the completer keys no purchase needs any more (retention.ts). A failure is said on the terminal only. */
  async function collectKeys(): Promise<void> {
    try {
      const keys = await completerKeys.list();
      for (const keyid of expiredCompleterKeys(store.entries(), keys, now())) await completerKeys.remove(keyid);
    } catch (error) {
      logger.warn(`intent-gateway: could not tidy the completer keys in ${completerKeys.dir}: ${(error as Error).message}`);
    }
  }

  /** Deletes one completer key whose cart went no further. A failure is left to the retention rules. */
  async function dropKey(keyid: string): Promise<void> {
    try {
      await completerKeys.remove(keyid);
    } catch {
      // The orphan rule of retention.ts deletes it later.
    }
  }

  /** Verifies a served statement against the pin and chains it in a `keys` entry; a string says why it failed. */
  async function chainStatement(statement: KeyStatement): Promise<KeySet | string> {
    const verified = verifyStatement(statement, pinnedRootKeys, new Date(now()));
    if (!verified.ok) {
      return `the key statement did not verify against the pinned root key (Appendix F step ${String(verified.step)}: ${verified.reason})`;
    }
    await store.append("keys", { statement });
    return verified.keySet;
  }

  /**
   * The key set for the next signed call. Once the statement has expired no key of it is trusted, so the statement
   * is fetched again through the same disclosed bootstrap read start() uses (its receipt is logged unverified, then
   * checked by `intent verify` against the statement it delivered). A fresh valid one is chained and used; otherwise
   * the call is refused before anything else is sent.
   */
  async function currentKeys(fromSeq: number): Promise<{ ok: true; keys: KeySet } | { ok: false; refused: Refused }> {
    const current = started();
    if (now() < current.expiresAt.getTime()) return { ok: true, keys: current };
    const expiredOn = current.expiresAt.toISOString();
    keySet = null;
    let why: string;
    try {
      const fetched = await call(() => cloud.keyStatement(), fromSeq);
      const verified = fetched.ok ? await chainStatement(fetched.body) : fetched.refused.message;
      if (typeof verified !== "string") {
        keySet = verified;
        logger.warn(`intent-gateway: the key statement expired on ${expiredOn}; fetched and chained a fresh one.`);
        return { ok: true, keys: verified };
      }
      why = verified;
    } finally {
      // Kept so the next call tries again; the disclosed cloud refuses every signed call under it meanwhile.
      if (keySet === null) keySet = current;
    }
    return {
      ok: false,
      refused: {
        status: "error",
        message:
          `Not sent: the key statement expired on ${expiredOn}, and the one Intent Cloud returns now is not a fresh valid one (${why}). ` +
          "Restart the gateway to fetch a fresh one later.",
        summary: summary(fromSeq),
      },
    };
  }

  // ---- find offers ----------------------------------------------------------------------------------------------

  async function findOffers(raw: unknown): Promise<FindOffersResult> {
    started();
    const fromSeq = head();
    const identity = await identityRefusal("searchCatalog", raw, fromSeq);
    if (identity !== null) return identity;
    const parsed = FindOffersInput.safeParse(raw);
    if (!parsed.success) return { status: "invalid", message: `Not sent: ${z.prettifyError(parsed.error)}`, summary: summary(fromSeq) };
    const input = parsed.data;

    const product = blankToUndefined(input.product);
    const category = blankToUndefined(input.category);
    const missing: MissingDetail[] = [];
    if (product === undefined && category === undefined) {
      missing.push({ field: "product_or_category", ask: "What should I look for: an exact product, or a kind of product?" });
    } else if (category === undefined && policy.categories.block.length > 0) {
      // Offers carry no category of their own, so a product-only search would skip every category the policy
      // blocks (invariant 1). Under such a policy a search must name its category; offers and carts are then checked
      // against it.
      missing.push({
        field: "category",
        ask: "What kind of product is it (for example running-shoes)? The gateway policy blocks some categories, so a search must name one.",
      });
    }
    const budget = input.budget_usd;
    if (budget === undefined || !Number.isFinite(budget) || budget <= 0) {
      missing.push({ field: "budget_usd", ask: "What is the most you want to spend, in US dollars?" });
    }
    const zip = input.zip?.trim();
    if (zip === undefined || !US_ZIP.test(zip)) {
      missing.push({ field: "zip", ask: "Which 5-digit US ZIP code should it ship to?" });
    }
    if (missing.length > 0 || budget === undefined || zip === undefined) {
      return {
        status: "needs_details",
        missing,
        message: `Ask the user only for: ${missing.map((m) => m.ask).join(" ")}`,
        summary: summary(fromSeq),
      };
    }

    const mustHaves = input.must_haves;
    const decision = evaluate(
      policy,
      {
        kind: "search",
        ...(category === undefined ? {} : { category }),
        ...(mustHaves === undefined ? {} : { must_haves: mustHaves }),
        budget_usd: budget,
        ship_to_zip: zip,
      },
      [],
      now(),
    );
    const request: CloudSearchRequest = {
      ...(category === undefined ? {} : { category }),
      ...(product === undefined ? {} : { product }),
      ...(mustHaves === undefined ? {} : { must_haves: mustHaves }),
      budget_max: { amount_minor: Math.round(budget * 100), currency: "USD" },
      ship_to: { country: "US", postal_code: zip },
    };
    if (!decision.send) {
      return block(
        "searchCatalog",
        inputFields(request),
        decision.blocked.map((b) => `${b.rule} at ${b.path}`),
        fromSeq,
        "blocked",
        `Not sent: the gateway policy refuses this search (${decision.blocked.map((b) => b.reason).join("; ")}).`,
        // Structured values only: never the free-text product, whose words findIdentity cannot vet (a name is free text).
        {
          ...(category === undefined ? {} : { category }),
          ...(decision.blocked.some((b) => b.path === "ship_to_zip") ? { zip } : {}),
        },
      );
    }

    const keys = await currentKeys(fromSeq);
    if (!keys.ok) return keys.refused;
    const sent = await call(() => cloud.search(request), fromSeq);
    if (!sent.ok) return sent.refused;
    const history = spendHistory(store.entries(), now());
    const kept: CloudOffer[] = [];
    const hiddenBy = new Set<string>();
    for (const offer of sent.body.offers) {
      const verdict = evaluate(policy, { kind: "cart", offer: policyOffer(offer.merchant.domain, category ?? "", offer.price, offer.shipping, 1) }, history, now());
      if (verdict.send) kept.push(offer);
      else for (const b of verdict.blocked) hiddenBy.add(b.rule);
    }
    for (const offer of kept) remember(offer.offer_handle, { offer, category: category ?? "", zip });
    const hidden = sent.body.offers.length - kept.length;
    await store.append("observed", observeSearch(sent.seq, sent.body, hidden));
    // Rule names only (e.g. merchants.block), never the merchant, category or price that matched it.
    const rules = [...hiddenBy].sort().join(", ");
    const hiddenNote = hidden === 0 ? "" : ` ${String(hidden)} more hidden by the gateway policy (${rules}).`;
    // Demo mode: a search that found nothing says what the sample catalog holds, so the agent can adapt.
    const note = options.demo?.catalogNote;
    const emptyNote = sent.body.offers.length === 0 && note !== undefined ? ` ${note}` : "";
    const hiddenBlocked = hidden === 0 ? [] : [`${String(hidden)} offer${hidden === 1 ? "" : "s"} (${rules})`];
    return {
      status: "offers",
      offers: kept,
      hidden,
      message: `${String(kept.length)} offer${kept.length === 1 ? "" : "s"}.${hiddenNote}${emptyNote}`,
      summary: summary(fromSeq, hiddenBlocked),
    };
  }

  function remember(handle: string, offer: RememberedOffer): void {
    offers.delete(handle);
    offers.set(handle, offer);
    while (offers.size > MAX_REMEMBERED_OFFERS) {
      const oldest = offers.keys().next();
      if (oldest.done === true) break;
      offers.delete(oldest.value);
    }
  }

  // ---- create cart ----------------------------------------------------------------------------------------------

  async function createCart(raw: unknown): Promise<CreateCartResult> {
    started();
    const fromSeq = head();
    const identity = await identityRefusal("createCart", raw, fromSeq);
    if (identity !== null) return identity;
    const parsed = CreateCartInput.safeParse(raw);
    if (!parsed.success) return { status: "invalid", message: `Not sent: ${z.prettifyError(parsed.error)}`, summary: summary(fromSeq) };
    const quantity = parsed.data.quantity ?? 1;
    const known = offers.get(parsed.data.offer_handle);
    if (known === undefined) {
      return {
        status: "invalid",
        message: "Not sent: this offer did not come from a search through this gateway. Call find_offers first.",
        summary: summary(fromSeq),
      };
    }

    // The policy on the offer as searched, with the spend so far from the chain.
    const domain = known.offer.merchant.domain;
    const before = spendCheck(policyOffer(domain, known.category, known.offer.price, known.offer.shipping, quantity));
    const request: Omit<CloudCartRequest, "completer_keyid" | "completion_accepts"> = { offer_handle: known.offer.offer_handle, quantity, ship_to: { country: "US", postal_code: known.zip } };
    if (before.length > 0) {
      return block("createCart", inputFields(request), before.map((b) => `${b.rule} at ${b.path}`), fromSeq, "blocked",
        `Not sent: the gateway policy refuses this cart (${before.map((b) => b.reason).join("; ")}).`,
        { title: known.offer.title, merchant: known.offer.merchant.name, quantity });
    }

    // A 1.6.0 offer names its variant, which the cart and the snapshot must repeat (offer = cart = snapshot). Without
    // it there is nothing to check them against, so nothing is sent and no completer key is made.
    if (known.offer.variant_ref === undefined) {
      return block("createCart", inputFields(request), ["offer: no variant_ref"], fromSeq, "refused",
        "Not sent: the offer names no variant_ref, so the gateway cannot check that the cart is the item offered. Search again.");
    }
    const fresh = await currentKeys(fromSeq);
    if (!fresh.ok) return fresh.refused;
    const keys = fresh.keys;
    const accepts = completionAccepts(`https://${domain.toLowerCase()}`);
    if (accepts.length === 0) {
      return block("createCart", inputFields(request), ["completion at completion_accepts"], fromSeq, "blocked",
        "Not sent: no completion mode the gateway policy allows is available here (one-tap needs a linked wallet).");
    }

    // The completer key is on disk before the cart request names it: a crash after the approval is chained must
    // still leave a key that can read it. Its keyid is regenerated in the rare case it looks like identity.
    let completer: Session;
    try {
      // Never an earlier approval's key (amendment M5); a fresh key repeats one only by a fault, refused all the same.
      const earlier = new Set(store.entries().flatMap((e) => (e.kind === "approval_pending" ? [bodyOf(e).completer_keyid] : [])));
      completer = await completerKeys.create((keyid) => !earlier.has(keyid) && findIdentity({ completer_keyid: keyid }).length === 0);
    } catch (error) {
      return { status: "error", message: `Not sent: the completer key could not be saved (${(error as Error).message}).`, summary: summary(fromSeq) };
    }
    let keep = false;
    try {
      const outcome = await cartAndApproval(
        { ...request, completer_keyid: completer.keyid, completion_accepts: [...accepts] },
        known,
        keys.confirmOrigin,
        fromSeq,
      );
      keep = outcome.status === "approval_needed";
      return outcome;
    } finally {
      if (!keep) await dropKey(completer.keyid);
    }
  }

  /**
   * The cart request, its checks, the approval request and the snapshot's checks, up to the `approval_pending`
   * entry. Every check of the cart runs before the approval request, so a refused cart reaches no passkey.
   */
  async function cartAndApproval(
    request: CloudCartRequest & { completer_keyid: string; completion_accepts: CloudCompletionMode[] },
    known: RememberedOffer,
    confirmOrigin: string,
    fromSeq: number,
  ): Promise<CreateCartResult> {
    const { quantity } = request;
    const domain = known.offer.merchant.domain;
    const cartCall = await call(() => cloud.createCart(request), fromSeq);
    if (!cartCall.ok) return cartCall.refused;
    const cart = cartCall.body;
    await store.append("observed", observeCart(cartCall.seq, cart));
    const mode = cart.completion_mode;
    const cartProblems = [
      ...(cart.merchant.domain === domain ? [] : ["merchant differs from the offer"]),
      ...(cart.quantity === quantity ? [] : ["quantity differs from the request"]),
      ...cartV16Problems(cart, known.offer, request.completion_accepts),
      ...spendCheck(policyOffer(cart.merchant.domain, known.category, cart.total, null, cart.quantity), mode).map((b) => b.reason),
    ];
    if (cartProblems.length > 0) {
      return block("createCart", ["cart"], cartProblems.map((p) => `cart: ${p}`), fromSeq, "refused",
        `Refused: the cart Intent Cloud created does not match what was asked (${cartProblems.join("; ")}). No approval was requested.`);
    }

    // What step 7 matches the snapshot to, now and when the approval is accepted (chained below). Checked against its
    // schema before the approval request, so a `sent` that step 7 could not read never reaches the buyer's passkey.
    const sent = readSent({
      cart_request: request,
      offer: { variant_ref: known.offer.variant_ref, merchant: known.offer.merchant },
      cart: { merchant_origin: cart.merchant_origin, variant_ref: cart.variant_ref, total: cart.total, expires_at: cart.expires_at },
    });
    if (sent === null) {
      return block("createCart", ["cart"], ["cart: not what step 7 can check (sent)"], fromSeq, "refused",
        "Refused: the cart and offer do not give what the approval is checked against (Appendix E step 7). No approval was requested.");
    }

    const approvalCall = await call(() => cloud.createApproval(cart.cart_handle), fromSeq);
    if (!approvalCall.ok) return approvalCall.refused;
    const created = approvalCall.body;
    await store.append("observed", observeApproval(approvalCall.seq, created));
    const snapshotProblems = [
      ...checkSnapshot(created, cart, sent),
      ...spendCheck(policyOffer(created.snapshot.merchant.domain, known.category, created.snapshot.total, null, created.snapshot.quantity), mode).map(
        (b) => b.reason,
      ),
    ];
    if (snapshotProblems.length > 0) {
      return block("createApproval", ["snapshot"], snapshotProblems.map((p) => `snapshot: ${p}`), fromSeq, "refused",
        `Refused: the purchase snapshot does not match the cart (${snapshotProblems.join("; ")}). Do not approve it.`);
    }

    // start() admitted the demo base only under the published test root, so a real host's link is never rewritten.
    const approvalUrl = (options.demo?.confirmBaseUrl ?? confirmOrigin) + created.approval_link_path;
    // The cap reservation is atomic: the caps are re-checked over the chain under the store lease, with the entry that
    // reserves the room, so two carts in two processes cannot both fit under one cap.
    const reserved = policyOffer(created.snapshot.merchant.domain, known.category, created.snapshot.total, null, created.snapshot.quantity);
    try {
      await store.appendUnless(
        "approval_pending",
        {
          handle: created.approval_handle,
          approval_url: approvalUrl,
          snapshot_hash: created.snapshot_hash,
          total_minor: created.snapshot.total.amount_minor,
          expires_at: created.snapshot.expires_at,
          completion_mode: mode,
          completer_keyid: request.completer_keyid,
          sent,
        },
        (chain) => spendCheck(reserved, mode, chain).length > 0,
      );
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      const over = spendCheck(reserved, mode).map((b) => b.reason);
      return block("createApproval", ["snapshot"], over.map((p) => `snapshot: ${p}`), fromSeq, "refused",
        `Refused: another purchase took the room under the gateway policy's limits meanwhile (${over.join("; ")}). Do not approve it.`);
    }
    createdHere.add(created.approval_handle);
    return {
      status: "approval_needed",
      approval_handle: created.approval_handle,
      approval_url: approvalUrl,
      check_code: created.check_code,
      qr: approvalQr(approvalUrl),
      cart,
      message:
        options.demo === undefined
          ? `Ask the buyer to open ${approvalUrl} (or scan the QR code) and approve with their passkey; ` +
            `the page shows check code ${created.check_code}. Then call get_approval_status.`
          : `Demo: ask the user to open the approval link ${approvalUrl} and click "${approveLabel(created.snapshot.total.amount_minor)}" ` +
            `(enter the code shown in the gateway's terminal); the page shows check code ${created.check_code}. ` +
            "Then call get_approval_status.",
      summary: summary(fromSeq),
    };
  }

  /**
   * The policy's refusals for one purchase, counting what the chain already holds against the caps. `mode` is the
   * contract's completion mode, checked as the policy's (G1); absent means `handoff`.
   */
  function spendCheck(offer: PolicyOffer, mode?: CloudCompletionMode, chain: readonly Entry[] = store.entries()) {
    const at = now();
    const completion = mode === undefined ? {} : { completion_mode: policyMode(mode) };
    return evaluate(policy, { kind: "cart", offer, ...completion }, spendHistory(chain, at), at).blocked;
  }

  /**
   * `completion_accepts` for a cart (contract 1.6.0 §3): the modes the policy, met with Intent Cloud's baseline,
   * allows and this gateway can complete, gateway wallets first and `handoff` last.
   */
  function completionAccepts(merchantOrigin: string): CloudCompletionMode[] {
    const allowed = meet(policy, CLOUD_BASELINE).completion.map((m) => CONTRACT_MODE[m]);
    // The wallet's mode only where it can name the merchant's store: otherwise the purchase is handed off from the
    // start, rather than refused locally after the buyer's tap.
    const storeKnown = (options.oneTap?.storeFor ?? myshopifyStore)(merchantOrigin) !== null;
    const usable = [...(options.walletModes?.() ?? []), ...(wallet === null || !storeKnown ? [] : (["shop_agent"] as const))];
    const wallets = usable.filter((m) => m !== "handoff" && allowed.includes(m));
    return [...new Set(wallets), ...(allowed.includes("handoff") ? ["handoff" as const] : [])];
  }

  // ---- approval status ------------------------------------------------------------------------------------------

  async function getApprovalStatus(raw: unknown): Promise<ApprovalStatusResult> {
    started();
    const fromSeq = head();
    const identity = await identityRefusal("getApproval", raw, fromSeq);
    if (identity !== null) return identity;
    const parsed = ApprovalStatusInput.safeParse(raw);
    if (!parsed.success) return { status: "invalid", message: `Not sent: ${z.prettifyError(parsed.error)}`, summary: summary(fromSeq) };
    const handle = parsed.data.approval_handle;

    const chain = store.entries();
    const pending = chain.findLast((e) => e.kind === "approval_pending" && bodyOf(e).handle === handle);
    if (pending === undefined) {
      return { status: "unknown", message: "This gateway did not ask for that approval, so it cannot report on it.", summary: summary(fromSeq) };
    }
    const chained = chain.find((e) => e.kind === "approval" && bodyOf(e).handle === handle);

    const fresh = await currentKeys(fromSeq);
    if (!fresh.ok) return fresh.refused;
    const keys = fresh.keys;
    const signer = await readSigner(handle, bodyOf(pending));
    const fetched = await call(() => cloud.getApproval(handle, signer), fromSeq);
    if (fetched.ok) await store.append("observed", observeStatus(fetched.seq, handle, fetched.body));
    const mode = bodyOf(pending).completion_mode === "shop_agent" ? "shop_agent" : "handoff";
    if (chained !== undefined) return reportChained(chained, pending, fetched.ok ? fetched.body : null, mode, keys, fromSeq);
    if (!fetched.ok) return fetched.refused;
    const status = fetched.body;

    if (status.proof === undefined && !PROOF_STATES.has(status.state)) {
      const message =
        status.state === "pending"
          ? options.demo === undefined
            ? "Waiting for the buyer to approve with their passkey."
            : `Waiting for the user to click "${approveLabel(bodyOf(pending).total_minor)}" on the approval link (with the code shown in the gateway's terminal).`
          : status.state === "rejected"
            ? "The buyer rejected this purchase."
            : "This approval expired. Create a new cart to try again.";
      return { status: status.state === "pending" ? "pending" : status.state === "rejected" ? "rejected" : "expired", message, summary: summary(fromSeq) };
    }

    // A live approval is a 1.6.0 one, chained with step 7's `sent`. A pending entry without it (written by a 1.5.0
    // gateway) is refused here, so the released 1.5.0 proof form is accepted only by `intent verify` on old chains.
    if (readSent(bodyOf(pending).sent) === null) {
      return {
        ...(await block("getApproval", ["proof"], ["approval_proof: chained without what Appendix E step 7 checks (sent)"], fromSeq, "refused", "")),
        status: "not_verified",
        message: "This approval was asked for before contract 1.6.0, so it cannot be checked now. Create a new cart.",
      };
    }
    const verified = verifyApprovalProof(status, pending, keys, chain, new Date(now()));
    if (!verified.ok) {
      const step = verified.step === null ? "" : ` (Appendix E step ${String(verified.step)})`;
      return {
        ...(await block("getApproval", ["proof"], [`approval_proof: ${verified.reason}${step}`], fromSeq, "refused", "")),
        status: "not_verified",
        message: `The approval could not be verified (${verified.reason}${step}). The purchase is not approved.`,
      };
    }

    const check = checkApprover(verified.credential, chain);
    if (check.decision === "flag") {
      // A flagged approval is not chained as an approval: it stays unapproved until a person accepts the passkey at
      // a terminal (`intent approver accept` writes a new pin), and the next status call then finds a match. One
      // flag per passkey per pin, so polling does not repeat it.
      const lastPin = chain.findLastIndex((e) => e.kind === "approver_pin");
      const alreadyFlagged = chain.some((e, i) => i > lastPin && e.kind === "approver_flag" && bodyOf(e).fingerprint === check.fingerprint);
      if (!alreadyFlagged) await store.append(check.entry.kind, check.entry.body);
      return flagged(check.fingerprint, check.reason, fromSeq);
    }
    if (check.entry !== null) await store.append(check.entry.kind, check.entry.body);
    await store.append("approval", { handle, proof: status.proof, sign_count: verified.credential.signCount });
    if (check.decision === "pin") {
      logger.warn(`intent-gateway: pinned the first approving passkey. Fingerprint: ${check.fingerprint}`);
    }
    const shown = await recordOutcome(handle, status, verified.snapshot, verified.snapshotHash, keys);
    const parsedProof = ApprovalProof.safeParse(status.proof);
    const completion = mode === "shop_agent" && parsedProof.success ? await complete(handle, pending, parsedProof.data, keys) : null;
    return approved(check.fingerprint, status, mode, shown, fromSeq, completion);
  }

  /**
   * The key a status read is signed with: the session key for a cart this process created, else the approval's
   * completer key (Appendix G R7), so a restarted gateway can still read it. Without a readable key file, the session
   * key, which Intent Cloud then answers with 404.
   */
  async function readSigner(handle: string, pending: Record<string, unknown>): Promise<Session | undefined> {
    const keyid = pending.completer_keyid;
    if (createdHere.has(handle) || typeof keyid !== "string") return undefined;
    try {
      return (await completerKeys.load(keyid)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** A handle already chained: its proof was verified, and its passkey was the pin, when it was chained. */
  async function reportChained(
    chained: Entry,
    pending: Entry,
    status: ApprovalStatus | null,
    mode: CloudCompletionMode,
    keys: KeySet,
    fromSeq: number,
  ): Promise<ApprovalStatusResult> {
    const proof = ApprovalProof.safeParse(bodyOf(chained).proof);
    if (!proof.success) return { status: "not_verified", message: `The chained approval is malformed; run ${INTENT} verify.`, summary: summary(fromSeq) };
    const handle = String(bodyOf(chained).handle);
    const shown = await recordOutcome(handle, status, proof.data.snapshot, proof.data.snapshot_hash, keys);
    // After a restart every resume comes through here (plan G7b step 6, resume rule).
    const completion = mode === "shop_agent" ? await complete(handle, pending, proof.data, keys) : null;
    return approved(approverFingerprint(proof.data.credential_public_key), status, mode, shown, fromSeq, completion);
  }

  /** Advances a verified `shop_agent` purchase (complete.ts), every Intent Cloud call signed with its completer key. */
  async function complete(handle: string, pending: Entry, proof: z.infer<typeof ApprovalProof>, keys: KeySet): Promise<CompletionView> {
    const keyid = bodyOf(pending).completer_keyid;
    let signer: Session | undefined;
    try {
      signer = typeof keyid === "string" ? ((await completerKeys.load(keyid)) ?? undefined) : undefined;
    } catch {
      signer = undefined;
    }
    const met = meet(policy, CLOUD_BASELINE);
    const cap = met.spend.per_order_usd;
    const oneTap = options.oneTap;
    return advanceCompletion(
      {
        store,
        cloud,
        wallet,
        storeFor: oneTap?.storeFor ?? myshopifyStore,
        oneTapAllowed: met.completion.includes("one_tap"),
        overCap: (chain) => {
          // This purchase counted once: its own approval and pending entries left out, then evaluated as a new cart.
          const others = chain.filter((e) => !((e.kind === "approval" || e.kind === "approval_pending") && bodyOf(e).handle === handle));
          const s = proof.snapshot;
          return spendCheck(policyOffer(s.merchant.domain, "", s.total, null, s.quantity), "shop_agent", others).some(
            (b) => b.rule.startsWith("spend.") || b.rule === "history_invalid",
          );
        },
        perOrderCapMinor: cap === undefined ? null : Math.round(cap * 100),
        signer,
        keys,
        now,
        ...(oneTap?.hook === undefined ? {} : { hook: oneTap.hook }),
        ...(oneTap?.newReportId === undefined ? {} : { newReportId: oneTap.newReportId }),
        ...(oneTap?.newKey === undefined ? {} : { newKey: oneTap.newKey }),
      },
      { handle, pending, proof },
    );
  }

  /**
   * Reads Intent Cloud's outcome for a chained approval (ADR-0015) and chains an `outcome` entry, once per distinct
   * outcome and shown state. Only a verified outcome statement whose `outcome` equals the status's (M1) is acted on;
   * the gateway re-runs the binding result with its own total check and shows no more than that (O1, O2). A statement
   * refused by any rule shows nothing of its own: the outcome adopted from an earlier verified statement stays shown.
   * A verified outcome that may not replace the adopted one (R5a: a terminal verified outcome is final) is not adopted.
   * Nothing here frees spend-cap room: only local evidence does (contract §6).
   */
  async function recordOutcome(handle: string, status: ApprovalStatus | null, snapshot: AnySnapshot, snapshotHash: string, keys: KeySet): Promise<ShownOutcome | null> {
    if (status === null) return null;
    const { outcome, outcome_statement: statement } = status;
    const stated = statement?.outcome ?? outcome;
    if (stated === undefined) return null;
    let check: StatementCheck;
    if (outcome === undefined || statement === undefined || canonicalize(outcome) !== canonicalize(statement.outcome)) {
      check = { ok: false, refused_by: "m1", signed: false };
    } else {
      check = verifyOutcomeStatement(statement, { handle, snapshot, snapshotHash }, keys, new Date(now()), { stagingSource: stagingSourceAllowed(pinnedRootKeys) });
    }
    // The statement is kept so `intent verify` can re-check it offline, unless it holds what looks like buyer identity:
    // then it is not kept, and nothing in it is acted on (refused_by "identity").
    const held = statement !== undefined && findIdentity(statement).length === 0;
    if (statement !== undefined && !held) check = { ok: false, refused_by: "identity", signed: false };
    const reading = readCloudOutcome(stated, snapshot.total.amount_minor, check);
    const shownState = reading.state_shown;
    const cloud = { state: stated.state, source: stated.source, assurance: stated.assurance };
    const named = shownState !== null && stated.order_ref !== undefined && ORDER_REF.test(stated.order_ref);
    const body = CloudOutcomeEntry.parse({
      handle,
      basis: "cloud",
      outcome_hash: sha256Hex(canonicalize(outcome ?? stated)),
      cloud,
      statement_verified: check.ok,
      ...(check.ok ? {} : { refused_by: check.refused_by }),
      ...(held ? { statement_jcs: canonicalize(statement) } : {}),
      ...(reading.local_binding === null ? {} : { local_binding: reading.local_binding }),
      state_shown: shownState,
      ...(named ? { order_ref: stated.order_ref } : {}),
      ...(shownState !== null && stated.final_total !== undefined ? { final_total_minor: stated.final_total.amount_minor } : {}),
    });
    const words = {
      cloud_state: cloud.state,
      source: cloud.source,
      assurance: cloud.assurance,
      statement_verified: check.ok,
      ...(check.ok ? {} : { refused_by: check.refused_by }),
    };
    const recorded = outcomesFor(store.entries(), handle).filter((o): o is CloudOutcomeEntry => o.basis === "cloud");
    // The outcome adopted so far: the latest one a verified statement showed.
    const adopted = recorded.findLast((o) => o.statement_verified && o.state_shown !== null && o.cloud !== null);
    const keep = (): ShownOutcome =>
      adopted?.state_shown == null
        ? { ...words, state_shown: null }
        : { ...words, state_shown: adopted.state_shown, kept_earlier: true, ...(adopted.order_ref === undefined ? {} : { order_ref: adopted.order_ref }) };
    if (shownState !== null && adopted?.cloud != null && !replaces(adopted.cloud, cloud)) {
      logger.warn(
        `intent-gateway: Intent Cloud reported outcome ${cloud.state} for ${handle} after it reported the final outcome ${adopted.cloud.state} (Appendix G R5a); the gateway keeps the earlier one.`,
      );
      return keep();
    }
    const duplicate = recorded.some((o) => o.outcome_hash === body.outcome_hash && o.state_shown === body.state_shown && o.statement_verified === body.statement_verified);
    if (!duplicate) await store.append("outcome", body);
    if (shownState === null) return keep();
    return { ...words, state_shown: shownState, ...(body.order_ref === undefined ? {} : { order_ref: body.order_ref }) };
  }

  function approved(
    fingerprint: string,
    status: ApprovalStatus | null,
    mode: CloudCompletionMode,
    shown: ShownOutcome | null,
    fromSeq: number,
    completion: CompletionView | null = null,
  ): ApprovalStatusResult {
    const base = "Approved: the buyer's pinned passkey signed this purchase, and the gateway verified and logged the proof.";
    if (completion !== null) {
      // A one-tap purchase is told from the gateway's own evidence (its chain and Shop's answers), never Intent Cloud's.
      return {
        status: "approved",
        fingerprint,
        ...(shown === null ? {} : { outcome: shown }),
        completion,
        message: `${base} ${completionWords(completion)}`,
        summary: summary(fromSeq),
      };
    }
    // Intent Cloud's word is repeated only when its state and outcome agree (Appendix G; never more than the outcome).
    const inconsistent = status === null ? null : statusProblem(status.state, status.outcome, mode);
    if (inconsistent !== null) {
      logger.warn(`intent-gateway: Intent Cloud reported an approval state and an outcome that disagree (${inconsistent}); the gateway does not repeat them.`);
      // The structured reading (never more than the verified statement) is still given; the sentence repeats nothing.
      return {
        status: "approved",
        fingerprint,
        ...(shown === null ? {} : { outcome: shown }),
        message: `${base} Intent Cloud reported what happened next inconsistently, so the gateway does not repeat it.`,
        summary: summary(fromSeq),
      };
    }
    // A statement this read refused: say what Intent Cloud reported and which rule failed, and count nothing from it.
    const refusal =
      shown === null || shown.statement_verified
        ? ""
        : ` Intent Cloud reported ${shown.cloud_state.replace("_", " ")}, but its statement fails ${shown.refused_by ?? "a rule"}; ${
            // With an earlier verified outcome kept, "not counted as placed" would read against a kept `ordered`.
            shown.state_shown === null ? "not counted as placed" : "not acted on"
          }.`;
    if (shown !== null && shown.state_shown === null) {
      return { status: "approved", fingerprint, outcome: shown, message: base + refusal, summary: summary(fromSeq) };
    }
    if (shown !== null && shown.state_shown !== null) {
      const state = shown.state_shown;
      const word = shownStatus(state, mode);
      // The order of the shown outcome's own statement (an earlier one when it was kept), never of a refused one.
      const order = state === "ordered" ? shown.order_ref : undefined;
      return {
        status: "approved",
        ...(word === "approved" ? {} : { cloud_reported: word }),
        ...(order === undefined ? {} : { order_number: order }),
        outcome: shown,
        fingerprint,
        message: base + outcomeWords(state, order) + refusal,
        summary: summary(fromSeq),
      };
    }
    const next = mode === "handoff" ? "The buyer pays at the merchant checkout." : "The purchase is to be completed by the gateway's wallet.";
    return { status: "approved", fingerprint, message: `${base} ${next}`, summary: summary(fromSeq) };
  }

  function flagged(fingerprint: string, reason: FlagReason, fromSeq: number): ApprovalStatusResult {
    if (reason === "sign_count") {
      return {
        status: "flagged",
        fingerprint,
        message:
          `Not approved: the pinned passkey (fingerprint ${fingerprint}) signed with a signature counter that did not ` +
          "go up since its last approval, as happens when a passkey has been copied. Check the passkey with its owner " +
          "before creating a new cart.",
        summary: summary(fromSeq),
      };
    }
    return {
      status: "flagged",
      fingerprint,
      message:
        `Not approved: a passkey other than the pinned approver signed this purchase (fingerprint ${fingerprint}). ` +
        `If that passkey is the buyer's, the developer runs \`${INTENT} approver accept\` at a terminal and types this ` +
        "fingerprint; then ask again.",
      summary: summary(fromSeq),
    };
  }

  return {
    start: () => serial(start),
    findOffers: (input) => serial(() => findOffers(input)),
    createCart: (input) => serial(() => createCart(input)),
    getApprovalStatus: (input) =>
      serial(async () => {
        try {
          return await getApprovalStatus(input);
        } finally {
          if (keySet !== null) await collectKeys();
        }
      }),
  };
}

/**
 * One purchase in the policy's terms. Spend caps count what the buyer pays, shipping included, so the per-unit
 * price is the total divided by the quantity (the policy multiplies it back). With `shipping` null, `price` is
 * already the total.
 */
function policyOffer(
  merchant: string,
  category: string,
  price: { amount_minor: number },
  shipping: { amount_minor: number } | null,
  quantity: number,
): PolicyOffer {
  const totalMinor = shipping === null ? price.amount_minor : price.amount_minor * quantity + shipping.amount_minor;
  return { merchant, category, price_usd: totalMinor / 100 / quantity, quantity };
}

/** The policy's completion mode for a contract mode; an unknown one maps to itself, which the policy refuses. */
function policyMode(mode: CloudCompletionMode): PolicyCompletionMode {
  const found = (Object.keys(CONTRACT_MODE) as PolicyCompletionMode[]).find((m) => CONTRACT_MODE[m] === mode);
  return found ?? (mode as PolicyCompletionMode);
}

/**
 * The 1.6.0 checks of a cart against the offer and the request, before any approval is requested (contract 1.6.0
 * §3, offer = cart = snapshot): every 1.6.0 field present, a completion mode the gateway offered, the offer's
 * variant, and the origin `https://` + the merchant's domain, lowercased and ASCII only (Appendix G check 1).
 */
function cartV16Problems(cart: Cart, offer: CloudOffer, accepts: readonly CloudCompletionMode[]): string[] {
  const missing = (["completion_mode", "merchant_origin", "variant_ref", "total_estimated"] as const).filter((k) => cart[k] === undefined);
  if (missing.length > 0) return [`cart lacks ${missing.join(", ")}, which a 1.6.0 host sends`];
  const problems: string[] = [];
  const mode = cart.completion_mode as CloudCompletionMode; // present: `missing` above is empty
  if (!accepts.includes(mode)) problems.push(`completion mode ${mode} was not offered (completion_accepts ${accepts.join(", ")})`);
  // createCart refused an offer without variant_ref before anything was sent, so this compares two values.
  if (cart.variant_ref !== offer.variant_ref) problems.push("variant_ref differs from the offer");
  const domain = cart.merchant.domain;
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]+$/.test(domain) || cart.merchant_origin !== `https://${domain.toLowerCase()}`) {
    problems.push("merchant_origin is not https:// + the merchant's domain");
  }
  return problems;
}

/**
 * The snapshot must be the cart under the hash Intent Cloud gave (Appendix A) and, from a 1.6.0 host, a v2 snapshot
 * that passes Appendix E step 7 against what was sent and received (`sent`, trust's sentProblems): the same check
 * the approval must pass again when it is accepted.
 */
function checkSnapshot(created: ApprovalCreated, cart: Cart, sent: SentPurchase): string[] {
  const s = created.snapshot;
  const problems: string[] = [];
  if (sha256Hex(canonicalize(s)) !== created.snapshot_hash) problems.push("snapshot_hash is not the snapshot's hash");
  if (created.check_code !== created.snapshot_hash.slice(0, 8)) problems.push("check_code is not the start of snapshot_hash");
  if (s.approval !== created.approval_handle) problems.push("snapshot is for another approval");
  if (created.state !== "pending") problems.push(`approval is ${created.state}, not pending`);
  const same = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);
  for (const key of ["merchant", "item", "quantity", "unit_price", "shipping", "total", "total_kind"] as const) {
    if (!same(s[key], cart[key])) problems.push(`${key} differs from the cart`);
  }
  // The schema admits only v2 from a 1.6.0 host; a v1 snapshot that got past it fails step 7 below (snapshot_version).
  for (const key of ["completion_mode", "total_estimated"] as const) {
    if (s[key] !== cart[key]) problems.push(`${key} differs from the cart`);
  }
  problems.push(...sentProblems(s, sent).map((reason) => SENT_WORDS[reason]));
  return problems;
}

/** The demo confirm page's Approve button, `Approve $1,234.56 with demo passkey`, so the agent names what the user sees. */
/**
 * What the gateway says about Intent Cloud's outcome: worded as Intent Cloud's report, and never more than the state
 * the gateway shows (invariant 5).
 */
function outcomeWords(state: OutcomeState, order: string | undefined): string {
  switch (state) {
    case "ordered":
      return ` Intent Cloud reported that the merchant placed the order${order === undefined ? "" : ` (order ${order})`}, in a statement the gateway verified.`;
    case "handed_off":
      return " Intent Cloud reported that the buyer was handed off to the merchant checkout.";
    case "mismatch":
      return " Intent Cloud reported an order that does not match what the buyer approved (merchant, item, ZIP or total). Check the order with the merchant.";
    case "checkout_expired":
      return " Intent Cloud reported that the merchant checkout expired; no order was read.";
    case "reported":
      return " Intent Cloud reported an order it could not verify; the gateway does not count it as placed.";
    default:
      return ` Intent Cloud reported the purchase as ${state.replace("_", " ")}.`;
  }
}

/** What the gateway says about its own completion of a one-tap purchase: what it sent and what Shop answered. */
function completionWords(c: CompletionView): string {
  const again = "Call get_approval_status again until it says ordered, failed or mismatch.";
  const note = c.advisory?.includes("title_differs") === true ? " Note: Shop's item title differs from the approved one (variant, quantity, ZIP and total match)." : "";
  switch (c.state) {
    case "completing":
      return `The gateway is completing the purchase with the linked Shop wallet. ${again}${note}`;
    case "indeterminate":
      return (
        "The gateway sent the purchase to Shop and does not know the result yet; it will not send it again. " +
        (c.reason !== undefined && SHOP_ERROR_CODES.has(c.reason) ? `Shop answered with the error ${c.reason}. ` : "") +
        `The amount stays reserved against the spend caps. Check the order in the Shop app if it does not resolve. ${again}`
      );
    case "ordered":
      return `Shop reported the order${c.order_ref === undefined ? "" : ` (order ${c.order_ref})`}, and it matches what the buyer approved (read from Shop by the gateway).`;
    case "mismatch":
      return "Shop reported an order that does not match what the buyer approved (merchant, item, ZIP or total). Check the order in the Shop app.";
    case "failed":
      return c.source === "shop_api"
        ? "Shop reported the checkout as not completed (read from Shop by the gateway). Create a new cart to hand the purchase off to the merchant's checkout."
        : `The gateway did not send the purchase to Shop (${c.reason ?? "refused"}): no complete_checkout was sent.${refusalWords(c.reason)} Create a new cart to hand the purchase off to the merchant's checkout.`;
  }
}

/** Shop's tool-level error codes (S1) that an indeterminate outcome may carry as its reason, and that are named to the developer. */
const SHOP_ERROR_CODES: ReadonlySet<string> = new Set(["checkout_completion_ineligible", "invalid_checkout_id"]);

/** What the developer can do about a one-tap refusal the gateway made before paying (complete.ts reasons). */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  budget_unknown: 'Shop shows no budget for this connection: turn on "Allow agent to pay" with a budget in the Shop app.',
  no_budget_instrument: 'Shop offered no agent budget to pay this checkout with, and the gateway never pays with the card: turn on "Allow agent to pay" with a budget in the Shop app.',
  wallet_disconnected: "Shop says this connection can no longer read the account (it was removed in the Shop app): run intent wallet unlink shop, then intent wallet link shop.",
  create_unconfirmed: "Shop gave no usable answer to the checkout request, and the gateway never sends it twice.",
};

function refusalWords(reason: string | undefined): string {
  const words = reason === undefined ? undefined : REFUSAL_WORDS[reason];
  return words === undefined ? "" : ` ${words}`;
}

function approveLabel(totalMinor: unknown): string {
  if (typeof totalMinor !== "number" || !Number.isSafeInteger(totalMinor) || totalMinor < 0) return "Approve with demo passkey";
  return `Approve $${Math.floor(totalMinor / 100).toLocaleString("en-US")}.${String(totalMinor % 100).padStart(2, "0")} with demo passkey`;
}

function bodyOf(entry: Entry): Record<string, unknown> {
  return typeof entry.body === "object" && entry.body !== null ? (entry.body as Record<string, unknown>) : {};
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** The input's field names as dotted paths, for a `block` entry: names only, never values. */
function inputFields(value: unknown, prefix = "", out = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) inputFields(item, `${prefix}[]`, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix === "" ? key : `${prefix}.${key}`;
      out.add(name);
      inputFields(item, name, out);
    }
  }
  return [...out].sort();
}
