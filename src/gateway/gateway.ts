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
// - Approval: a cart is checked against the offer, the snapshot against the cart, the ship-to area against the ZIP
//   sent and the total against the caps, before the `approval_pending` entry is chained. "Approved" is reported only
//   for a proof the trust module verified against that entry, that was chained, and whose passkey is the pin.
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  type ApprovalCreated,
  ApprovalHandle,
  ApprovalProof,
  type ApprovalStatus,
  type Cart,
  type CartRequest as CloudCartRequest,
  CONTRACT_VERSION,
  type KeyStatement,
  type Offer as CloudOffer,
  OfferHandle,
  type SearchRequest as CloudSearchRequest,
} from "../contract/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  type CloudResult,
  type DisclosedCloud,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
} from "../disclosure/index.ts";
import { INTENT } from "../config/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import { evaluate, type Offer as PolicyOffer, type Policy } from "../policy/index.ts";
import { findIdentity } from "../privacy/index.ts";
import type { Entry, Store } from "../store/index.ts";
import {
  approverFingerprint,
  checkApprover,
  type FlagReason,
  type KeySet,
  onlyTestRoot,
  type PinnedRootKey,
  verifyApprovalProof,
  verifyStatement,
} from "../trust/index.ts";
import { disclosedSince, spendHistory, summaryLine } from "./history.ts";
import { type ApprovalQr, approvalQr } from "./qr.ts";

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

export type ApprovalStatusResult =
  | (Told & {
      readonly status: "approved";
      /** What Intent Cloud reported after the approval, worded as its report: handed_off or ordered. */
      readonly cloud_reported?: "handed_off" | "ordered";
      readonly order_number?: string;
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
const PROOF_STATES = new Set(["approved", "handed_off", "ordered"]);

export function createGateway(options: GatewayOptions): Gateway {
  const { store, policy, pinnedRootKeys } = options;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? {
    warn: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
  };
  let keySet: KeySet | null = null;
  const cloud = options.cloud(() => keySet);
  const offers = new Map<string, RememberedOffer>();

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

  /** Writes a `block` entry and returns the refusal. Items name fields and rules, never values. */
  async function block(
    endpoint: string,
    fields: readonly string[],
    blocked: readonly string[],
    fromSeq: number,
    status: Refused["status"],
    message: string,
  ): Promise<Refused> {
    await store.append("block", { endpoint, fields: [...fields], blocked: [...blocked] });
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
  async function call<T>(run: () => Promise<CloudResult<T>>, fromSeq: number): Promise<{ ok: true; body: T } | { ok: false; refused: Refused }> {
    const refuse = (status: Refused["status"], message: string) => ({ ok: false as const, refused: { status, message, summary: summary(fromSeq) } });
    let result: CloudResult<T>;
    try {
      result = await run();
    } catch (error) {
      if (error instanceof DisclosureBlockedError) return refuse("blocked", "Not sent: the request body looked like buyer identity.");
      if (error instanceof DisclosureDiscardedError) {
        return refuse("error", "Intent Cloud's answer carried no valid receipt, so the gateway discarded it.");
      }
      if (error instanceof DisclosureKeysExpiredError) {
        return refuse("error", `Not sent: the key statement expired on ${error.expiresAt.toISOString()}; restart the gateway to fetch a fresh one.`);
      }
      if (error instanceof DisclosureNoKeysError) return refuse("error", "No verified key statement: restart the gateway.");
      if (error instanceof CloudNetworkError) {
        return refuse("error", "Intent Cloud could not be reached; the request is logged as sent but not acknowledged.");
      }
      if (error instanceof CloudResponseError) return refuse("error", `Intent Cloud's answer was malformed (${error.reason}).`);
      if (error instanceof CloudRequestError) return refuse("invalid", `Not sent: ${error.message}`);
      throw error;
    }
    if (result.ok) return { ok: true, body: result.body };
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
    if (!meta.ok) throw new GatewayStartError(`Intent Cloud meta failed with status ${String(meta.status)}`);
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
    const request: CloudCartRequest = { offer_handle: known.offer.offer_handle, quantity, ship_to: { country: "US", postal_code: known.zip } };
    if (before.length > 0) {
      return block("createCart", inputFields(request), before.map((b) => `${b.rule} at ${b.path}`), fromSeq, "blocked",
        `Not sent: the gateway policy refuses this cart (${before.map((b) => b.reason).join("; ")}).`);
    }

    const fresh = await currentKeys(fromSeq);
    if (!fresh.ok) return fresh.refused;
    const keys = fresh.keys;
    const cartCall = await call(() => cloud.createCart(request), fromSeq);
    if (!cartCall.ok) return cartCall.refused;
    const cart = cartCall.body;
    const cartProblems = [
      ...(cart.merchant.domain === domain ? [] : ["merchant differs from the offer"]),
      ...(cart.quantity === quantity ? [] : ["quantity differs from the request"]),
      ...spendCheck(policyOffer(cart.merchant.domain, known.category, cart.total, null, cart.quantity)).map((b) => b.reason),
    ];
    if (cartProblems.length > 0) {
      return block("createCart", ["cart"], cartProblems.map((p) => `cart: ${p}`), fromSeq, "refused",
        `Refused: the cart Intent Cloud created does not match what was asked (${cartProblems.join("; ")}). No approval was requested.`);
    }

    const approvalCall = await call(() => cloud.createApproval(cart.cart_handle), fromSeq);
    if (!approvalCall.ok) return approvalCall.refused;
    const created = approvalCall.body;
    const snapshotProblems = [
      ...checkSnapshot(created, cart, known.zip),
      ...spendCheck(policyOffer(created.snapshot.merchant.domain, known.category, created.snapshot.total, null, created.snapshot.quantity)).map((b) => b.reason),
    ];
    if (snapshotProblems.length > 0) {
      return block("createApproval", ["snapshot"], snapshotProblems.map((p) => `snapshot: ${p}`), fromSeq, "refused",
        `Refused: the purchase snapshot does not match the cart (${snapshotProblems.join("; ")}). Do not approve it.`);
    }

    // start() admitted the demo base only under the published test root, so a real host's link is never rewritten.
    const approvalUrl = (options.demo?.confirmBaseUrl ?? keys.confirmOrigin) + created.approval_link_path;
    await store.append("approval_pending", {
      handle: created.approval_handle,
      approval_url: approvalUrl,
      snapshot_hash: created.snapshot_hash,
      total_minor: created.snapshot.total.amount_minor,
      expires_at: created.snapshot.expires_at,
    });
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
          : `Demo: ask the user to open the approval link ${approvalUrl} and click Approve with demo passkey ` +
            `(enter the code shown in the gateway's terminal); the page shows check code ${created.check_code}. ` +
            "Then call get_approval_status.",
      summary: summary(fromSeq),
    };
  }

  /** The policy's refusals for one purchase, counting what the chain already holds against the caps. */
  function spendCheck(offer: PolicyOffer) {
    const at = now();
    return evaluate(policy, { kind: "cart", offer }, spendHistory(store.entries(), at), at).blocked;
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
    const fetched = await call(() => cloud.getApproval(handle), fromSeq);
    if (chained !== undefined) return reportChained(chained, fetched.ok ? fetched.body : null, fromSeq);
    if (!fetched.ok) return fetched.refused;
    const status = fetched.body;

    if (status.proof === undefined && !PROOF_STATES.has(status.state)) {
      const message =
        status.state === "pending"
          ? options.demo === undefined
            ? "Waiting for the buyer to approve with their passkey."
            : "Waiting for the user to click Approve with demo passkey on the approval link (with the code shown in the gateway's terminal)."
          : status.state === "rejected"
            ? "The buyer rejected this purchase."
            : "This approval expired. Create a new cart to try again.";
      return { status: status.state === "pending" ? "pending" : status.state === "rejected" ? "rejected" : "expired", message, summary: summary(fromSeq) };
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
    return approved(check.fingerprint, status, fromSeq);
  }

  /** A handle already chained: its proof was verified, and its passkey was the pin, when it was chained. */
  function reportChained(chained: Entry, status: ApprovalStatus | null, fromSeq: number): ApprovalStatusResult {
    const proof = ApprovalProof.safeParse(bodyOf(chained).proof);
    if (!proof.success) return { status: "not_verified", message: `The chained approval is malformed; run ${INTENT} verify.`, summary: summary(fromSeq) };
    return approved(approverFingerprint(proof.data.credential_public_key), status, fromSeq);
  }

  function approved(fingerprint: string, status: ApprovalStatus | null, fromSeq: number): ApprovalStatusResult {
    const base = "Approved: the buyer's pinned passkey signed this purchase, and the gateway verified and logged the proof.";
    const state = status?.state;
    if (state === "handed_off" || state === "ordered") {
      const order = status?.order_number;
      const report =
        state === "ordered"
          ? ` Intent Cloud reported that the merchant placed the order${order === undefined ? "" : ` (order ${order})`}.`
          : " Intent Cloud reported that the buyer was handed off to the merchant checkout.";
      return {
        status: "approved",
        cloud_reported: state,
        ...(order === undefined ? {} : { order_number: order }),
        fingerprint,
        message: base + report,
        summary: summary(fromSeq),
      };
    }
    return { status: "approved", fingerprint, message: `${base} The buyer pays at the merchant checkout.`, summary: summary(fromSeq) };
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
    getApprovalStatus: (input) => serial(() => getApprovalStatus(input)),
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

/** The snapshot must be the cart, for the area sent, under the hash Intent Cloud gave (Appendix A). */
function checkSnapshot(created: ApprovalCreated, cart: Cart, zip: string): string[] {
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
  if (s.ship_to.postal_prefix !== zip.slice(0, 3)) problems.push("ship_to differs from the ZIP sent");
  return problems;
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
