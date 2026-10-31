// The gateway's use cases: find offers, create a cart and ask for approval, read the approval back. This is where
// the policy (invariant 1), the identity refusal (invariant 3) and the approval gate (invariant 4) meet; every call
// to Intent Cloud goes through the disclosed cloud, which logs before it sends (invariant 2).
//
// - Readiness: a search needs a product or category, a budget and a country and postcode. Missing ones are listed back
//   for the agent to ask about; the gateway never guesses one and calls nothing. Under a policy that blocks
//   categories, the category is required too: offers carry none of their own, so it is the only category the policy
//   can check. The postcode is coarsened at once (src/shipto): only {country, coarse} is held, sent or remembered.
// - Countries: a search ships to a country the currency table Intent Cloud returns lists in its `countries`, that the
//   contract names and that src/shipto has coarse rules for (shipsTo), in the currency that table gives it; outside
//   the US only through a linked Shop wallet. The policy's USD caps are scaled to
//   the currency by the table's ceilings (policy's capsIn), and count only orders in that currency.
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
// - Completer key (contract 1.6.x, ADR-0016): each cart gets a fresh Ed25519 key, saved to disk before the cart
//   request names it, so a restarted gateway (new session key) can still read the approval. A cart that goes no
//   further deletes it; otherwise the retention rules (retention.ts) do, on start and after each status call.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  type ApprovalCreated,
  ApprovalHandle,
  type ApprovalStatus,
  BindableApprovalProof,
  bindingRuleFor,
  snapshotTotal,
  type AnySnapshot,
  type Cart,
  type CheckoutRequest,
  COARSE_COUNTRIES,
  type CoarseCountry,
  continueUrlAllowed,
  type CurrencyTable,
  usableCurrencyTable,
  snapshotV4Problem,
  totalsAddUp,
  StoreSite,
  type CartRequest as CloudCartRequest,
  type CompletionMode as CloudCompletionMode,
  CONTRACT_VERSION,
  isMyshopifyDomain,
  type KeyStatement,
  type Offer as CloudOffer,
  type OutcomeState,
  type RefusalCode,
  type SnapshotV3,
  OfferHandle,
  type PauseAccepted,
  type PauseRequest,
  type SearchRequest as CloudSearchRequest,
} from "../contract/index.ts";
import {
  CloudNetworkError,
  CloudRequestError,
  CloudResponseError,
  connectStorefront,
  type DisclosedCloud,
  type DisclosedResult,
  DisclosureBlockedError,
  DisclosureDiscardedError,
  DisclosureKeysExpiredError,
  DisclosureNoKeysError,
  DisclosureRefusedError,
  DisclosureStoppedError,
  SHOP_PUBLIC_CLIENT_ID,
  type StorefrontPort,
} from "../disclosure/index.ts";
import { INTENT } from "../config/index.ts";
import { canonicalize, sha256Hex } from "../jcs/index.ts";
import {
  type Blocked,
  capsIn,
  CLOUD_BASELINE,
  scalable,
  type CompletionMode as PolicyCompletionMode,
  evaluate,
  meet,
  type Offer as PolicyOffer,
  type Policy,
} from "../policy/index.ts";
import { coarsen, currencyFor, currencyWords, namesText, shipCountry } from "../shipto/index.ts";
import { isPausedAnswer, noteSubmitAnswer, pausedIn, pausedRefusalWords, pauseState, refuseForPause } from "../pause/index.ts";
import { observeApproval, observeCart, observeSearch, observeStatus } from "../observation/index.ts";
import { createShopProvider, filterOffers, newOfferHandle, type SearchOffer, type SearchProvider, searchProviders } from "../search/index.ts";
import { CloudOutcomeEntry, ORDER_REF, outcomesFor, readCloudOutcome, replaces, shownStatus, type StatementCheck } from "../outcome/index.ts";
import { findIdentity, ORDER_REF_AT, TOOL_POSTCODE_AT } from "../privacy/index.ts";
import type { CompleterKeys, Session } from "../signing/index.ts";
import { appendedHere, type Entry, recordAppends, type Store, StoreConflictError } from "../store/index.ts";
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
  readSentCheckout,
  type SentCheckout,
  SENT_CHECKOUT_WORDS,
  sentCheckoutOf,
  sentCheckoutProblems,
  stagingSourceAllowed,
  type SentPurchase,
  sentProblems,
  verifyStatement,
} from "../trust/index.ts";
import { AddressFieldsRequiredError, CheckoutUnconfirmedError, type WalletAdapter, type WalletCheckout, WalletRailError } from "../wallet/index.ts";
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
  /**
   * The account key (ADR-0022, contract 1.7.0 Appendix H): its public JWK goes as `account_key` in every checkout the
   * gateway submits, and the v4 snapshot signs its thumbprint. Read at each submit; without it nothing is submitted.
   */
  accountKey?: () => Promise<AccountKeyPort>;
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

/** What the gateway needs of the account key: its public half and RFC 7638 thumbprint (src/account's AccountKey fits). */
export interface AccountKeyPort {
  readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
  readonly thumbprint: string;
}

export interface OneTapOptions {
  readonly connect: (cloud: DisclosedCloud) => WalletAdapter | null;
  /**
   * The merchant storefront the store pair check reaches (contract 1.6.1, ADR-0020), behind the disclosed cloud's log.
   * Default: the real storefront transport (src/disclosure's connectStorefront); demo mode and tests pass a fake.
   */
  readonly storefront?: (cloud: DisclosedCloud) => StorefrontPort;
  /**
   * The search seam (G5, ADR-0021): find_offers searches the linked wallet's catalog (Shop's search_catalog) in the
   * gateway, and sends nothing to Intent Cloud for the search. Off by default, so a wallet without it keeps Intent
   * Cloud's catalog.
   */
  readonly searchInGateway?: boolean;
  /** Test seams (complete.ts). */
  readonly hook?: (step: CompletionStep) => void | Promise<void>;
  readonly newReportId?: () => string;
  readonly newKey?: () => string;
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
  budget: z
    .number()
    .optional()
    .describe(
      "The most the user said they will spend, in the currency of the ship-to country (USD for the US, GBP for the UK, " +
        "EUR for the euro countries). Never guess it.",
    ),
  country: z
    .string()
    .max(60)
    .optional()
    .describe(
      "The ship-to country as an ISO 3166 alpha-2 code (US, CA, GB, DE, ...), from what the user said. Never guess it, " +
        "except US for a 5-digit ZIP code or ZIP+4 with a budget in dollars when nothing in the conversation suggests " +
        "another country; if unsure, ask.",
    ),
  postcode: z.string().max(40).optional().describe("The postcode (ZIP code in the US) the user said to ship to. Never guess it."),
});
export type FindOffersInput = z.input<typeof FindOffersInput>;

/** Intent Cloud's baseline allows at most 3 items per cart (the policy may allow fewer). */
const QUANTITY_LIMIT = "quantity must be 1 to 3: a cart holds at most 3 items";

export const CreateCartInput = z.strictObject({
  offer_handle: OfferHandle.describe("The offer_handle of the offer the user picked, from find_offers."),
  quantity: z
    .int()
    .min(1, QUANTITY_LIMIT)
    .max(3, QUANTITY_LIMIT)
    .optional()
    .describe("How many the user asked for (1 to 3). Defaults to 1."),
});
export type CreateCartInput = z.input<typeof CreateCartInput>;

export const ApprovalStatusInput = z.strictObject({
  approval_handle: ApprovalHandle.optional().describe(
    "The approval_handle that create_cart returned. Leave it out to list the purchases with no approval chained in this gateway's log, with their handles.",
  ),
});
export type ApprovalStatusInput = z.input<typeof ApprovalStatusInput>;

// ---- Tool results ---------------------------------------------------------------------------------------------

/** A detail a search needs that the agent did not give. The agent asks the user for it; the gateway never guesses. */
export interface MissingDetail {
  readonly field: "product_or_category" | "category" | "budget" | "ship_to" | "postcode";
  readonly ask: string;
}

/** Shared by every result: a sentence for the agent and the "Sent: … / Blocked: …" line. */
interface Told {
  readonly message: string;
  readonly summary: string;
}

/**
 * A call's next step for the agent: after an answer with a status, or when no usable answer came back. `refused`,
 * when it returns a sentence, words a known refusal whole (its next step included) in place of the plain one.
 */
interface Next {
  answered(status: number): string;
  readonly unsure: string;
  refused?(status: number, message: string | null): string | null;
}

/** Nothing was sent: the input was malformed, identity was found, or the policy refused the request. */
export type Refused = Told & { readonly status: "invalid" | "blocked" | "refused" | "error" };

/**
 * An offer found by the gateway's own search (G5), as the agent sees it: display fields and an opaque handle. The
 * store, variant and provider stay in the gateway, behind the handle, for the Shop checkout (G6).
 */
export interface ShopOfferView {
  readonly offer_handle: string;
  readonly title: string;
  readonly variant: string;
  /** The storefront host, else the myshopify domain. */
  readonly store: string;
  readonly price: { readonly amount_minor: number; readonly currency: string };
  readonly availability: "in_stock";
  readonly image_url?: string;
  readonly product_url?: string;
}

export type FindOffersResult =
  | (Told & { readonly status: "needs_details"; readonly missing: readonly MissingDetail[] })
  | (Told & { readonly status: "offers"; readonly offers: readonly CloudOffer[]; readonly hidden: number })
  | (Told & { readonly status: "shop_offers"; readonly offers: readonly ShopOfferView[]; readonly hidden: number })
  | Refused;

/**
 * A Shop checkout this gateway created, read back and submitted for approval (contract 1.7.0), as the agent sees it:
 * what the passkey will sign, never the checkout id or the full postcode.
 */
export interface SubmittedCheckoutView {
  readonly store: string;
  readonly title: string;
  readonly quantity: number;
  readonly totals: { readonly subtotal: number; readonly shipping: number; readonly tax: number; readonly total: number };
  readonly currency: string;
  readonly ship_to: { readonly country: string; readonly postal_code_coarse: string };
  /** `shop_agent`: approving pays at once with the linked Shop wallet; `handoff`: the buyer pays on the store's checkout page. */
  readonly completion_mode: CloudCompletionMode;
}

export type CreateCartResult =
  | (Told & {
      readonly status: "approval_needed";
      readonly approval_handle: string;
      readonly approval_url: string;
      readonly check_code: string;
      readonly qr: ApprovalQr;
      /** The cart Intent Cloud made (an offer from Intent Cloud's catalog). */
      readonly cart?: Cart;
      /** The Shop checkout the gateway submitted (an offer from Shop search, contract 1.7.0). */
      readonly checkout?: SubmittedCheckoutView;
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
  /**
   * Sends a signed pause to Intent Cloud through the disclosure log (ADR-0023); throws as the disclosed cloud does. When
   * `unless` holds over the chain under the store lease, nothing is logged or sent (DisclosureConflictError).
   */
  sendPause(request: PauseRequest, unless?: (entries: readonly Entry[]) => boolean): Promise<DisclosedResult<PauseAccepted>>;
}

interface RememberedOffer {
  readonly offer: CloudOffer;
  /** The category the search asked for ("" for a product-only search): offers carry none of their own. */
  readonly category: string;
  readonly shipTo: ShipTo;
}

/** Where a search ships to, as the gateway holds it: the country and the coarse postcode, never the full one. */
interface ShipTo {
  readonly country: CoarseCountry;
  readonly coarse: string;
}

/**
 * An offer the gateway's own search found (G5), kept behind its opaque handle: everything a Shop checkout needs (G6),
 * the store's myshopify domain, the variant and the quantity, plus what the policy checks on a cart.
 */
interface LocalOffer {
  readonly offer: SearchOffer;
  readonly quantity: number;
  readonly category: string;
  readonly shipTo: ShipTo;
  /** The search's currency: the ship-to country's. */
  readonly currency: string;
}

const MAX_REMEMBERED_OFFERS = 500;
/** How many waiting purchases a get_approval_status without a handle lists. */
const MAX_WAITING_LISTED = 5;
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
  /** Intent Cloud's currency table from Meta at start (1.7.0), or null when it sent none or one whose version is not its hash. */
  let currencyTable: CurrencyTable | null = null;
  const cloud = options.cloud(() => keySet);
  let wallet: WalletAdapter | null = null;
  try {
    wallet = options.oneTap?.connect(cloud) ?? null;
  } catch (error) {
    logger.warn(`intent: the linked wallet cannot be used, so purchases are handed off: ${(error as Error).message}`);
  }
  // The store pair check's storefront, behind the same disclosure core (log before send to every destination).
  const storefront: StorefrontPort | null = wallet === null ? null : (options.oneTap?.storefront ?? connectStorefront)(cloud);
  const offers = new Map<string, RememberedOffer>();
  const localOffers = new Map<string, LocalOffer>();
  const providers: SearchProvider[] = options.oneTap?.searchInGateway === true && wallet?.searchCatalog !== undefined ? [createShopProvider(wallet)] : [];
  /** Approvals whose cart this process's session key created; any other is read with its completer key. */
  const createdHere = new Set<string>();
  /**
   * The approval each offer handle last led to here, with its quantity and ship-to postcode (the coarse one, as Intent
   * Cloud's replay key has it): a repeated create_cart with all three the same returns it (samePending).
   */
  const askedFor = new Map<string, { approval: string; quantity: number; postcode: string | undefined }>();
  let stopReported = false;

  // One call at a time: the spend caps and the replay check read the chain and then append to it. Each call records
  // the entries it appends, so its "Sent:" line names only its own requests (invariant 5).
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const own = (): Promise<T> => recordAppends(run);
    const result = tail.then(own, own);
    tail = result.catch(() => undefined);
    return result;
  }

  function started(): KeySet {
    if (keySet === null) throw new GatewayNotStartedError("the gateway has not started: call start() first");
    return keySet;
  }

  /** Intent Cloud's ceilings per currency, which scale the policy's USD caps (policy's capsIn); null with no valid table. */
  const ceilings = (): CurrencyTable["currencies"] | null => currencyTable?.currencies ?? null;

  /**
   * The countries a search may ship to now: those the currency table's `countries` lists (contract 1.7.1: only the
   * countries whose currency is in the table), met with the contract's ship_to enum (COARSE_COUNTRIES) and the
   * countries src/shipto has coarse rules for. A country's currency comes only from that map. With no valid table,
   * none: the gateway has no currency to put its limits in.
   */
  function shipsTo(): CoarseCountry[] {
    return COARSE_COUNTRIES.filter((c) => {
      const currency = currencyOf(c);
      // A currency whose ceilings are out of line with the USD ones cannot carry the caps (policy's scalable).
      return shipCountry(c) !== undefined && currency !== undefined && currencyTable?.currencies[currency] !== undefined && scalable(currency, ceilings());
    });
  }

  /** The currency of a search to `country`: the `countries` of the table Intent Cloud sent (src/shipto's currencyFor). */
  const currencyOf = (country: string): string | undefined => currencyFor(country, currencyTable);

  /** Why a search cannot ship to `country` (upper-cased), in one line for the agent, or null when it can. */
  function countryRefusal(country: string): string | null {
    const accepted = shipsTo();
    if ((accepted as readonly string[]).includes(country)) return null;
    if (currencyTable === null) return NO_CURRENCY_TABLE;
    if (accepted.length === 0) return "Not sent: the currency table Intent Cloud returns lists no country intent ships to, so no search can be made now.";
    const rules = shipCountry(country);
    const currency = currencyOf(country);
    if (rules !== undefined && currency !== undefined && (COARSE_COUNTRIES as readonly string[]).includes(country)) {
      return currencyTable.currencies[currency] === undefined
        ? `Not sent: intent cannot take orders in ${currency} now, so it cannot ship to ${rules.name} for now.`
        : `Not sent: the ceilings Intent Cloud returns for ${currency} are out of line with its US-dollar ones, so intent cannot put your limits in ${currency} for ${rules.name}; try later.`;
    }
    return rules === undefined
      ? `Not sent: intent ships to ${namesText(accepted)} for now.`
      : `Not sent: intent does not ship to ${rules.name} yet; it ships to ${namesText(accepted)}.`;
  }

  const head = (): number => store.entries().at(-1)?.seq ?? -1;
  const summary = (fromSeq: number, extra: readonly string[] = []): string => summaryLine(disclosedSince(store.entries(), fromSeq, appendedHere()), extra);

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
    // The agent's own text, so the free-text rules run; the postcode field holds a whole postcode by design (coarsened).
    const findings = findIdentity(input, { freeText: true, postcodeAt: TOOL_POSTCODE_AT });
    if (findings.length === 0) return null;
    // A field name can itself be identity ({"jane@example.com": 1}); such a name is never written to the chain.
    const named = (text: string, kind: string): string => (findIdentity(text).length === 0 ? text : `${kind} in a field name`);
    return block(
      endpoint,
      inputFields(input).map((f) => named(f, "identity")),
      findings.map((f) => named(`${f.kind} at ${f.path}`, f.kind)),
      fromSeq,
      "blocked",
      "Not sent: the request holds what looks like buyer identity (an address, a full postcode, a phone number, an email " +
        "or a card). The gateway never sends or keeps it; the buyer gives it to the merchant at checkout. Remove any " +
        "address or postcode from the product, category and must-haves, pass the postcode in the postcode field only, " +
        "and try again.",
    );
  }

  /**
   * Runs one disclosed call; a failure becomes a Refused naming what happened, never Cloud's content. `next` is the
   * step's next step (NEXT), added where no more specific line names one, so every refusal the agent relays names
   * what to do: `answered` after a status with no refusal code, `unsure` when the request may have reached Intent
   * Cloud but no usable answer came back (a timeout, an unreceipted or a malformed answer).
   */
  async function call<T>(
    run: () => Promise<DisclosedResult<T>>,
    fromSeq: number,
    next: Next = { answered: () => "", unsure: "" },
  ): Promise<{ ok: true; body: T; seq: number } | { ok: false; refused: Refused; paused?: true }> {
    const refuse = (status: Refused["status"], message: string) => ({ ok: false as const, refused: { status, message, summary: summary(fromSeq) } });
    let result: DisclosedResult<T>;
    try {
      result = await run();
    } catch (error) {
      // Intent Cloud's `paused` refusal (contract 1.7.0) arrives outside the 1.6.1 error schema: the caller records it.
      if (isPausedAnswer(error)) return { ...refuse("refused", PAUSED_BY_CLOUD), paused: true as const };
      if (error instanceof DisclosureBlockedError) return refuse("blocked", "Not sent: the request body looked like buyer identity.");
      // The reasons are the core's own words (a rule and a field name), never a value from the request.
      if (error instanceof DisclosureRefusedError) return refuse("blocked", `Not sent: ${error.reasons.join("; ")}.`);
      if (error instanceof DisclosureStoppedError) {
        // Said once on the terminal too: the developer must restart the gateway, the agent cannot fix it.
        if (!stopReported) logger.warn(`intent: ${error.message}. Restart the gateway, then run ${INTENT} verify.`);
        stopReported = true;
        return refuse("error", `Not sent: ${error.message}. The developer must restart the gateway.`);
      }
      if (error instanceof DisclosureDiscardedError) {
        return refuse("error", `Intent Cloud's answer carried no valid receipt, so the gateway discarded it.${next.unsure}`);
      }
      if (error instanceof DisclosureKeysExpiredError) {
        return refuse("error", `Not sent: the key statement expired on ${error.expiresAt.toISOString()}; restart the gateway to fetch a fresh one.`);
      }
      if (error instanceof DisclosureNoKeysError) return refuse("error", "No verified key statement: restart the gateway.");
      if (error instanceof CloudNetworkError) {
        // Invariant 5: with no connection made, the logged request never left, and the summary does not list it as sent.
        if (error.neverLeft) return refuse("error", `Not sent: ${error.message}, so the request never left this machine. Try again later.`);
        return refuse("error", `${error.message}; the request may have reached it, and is logged as sent but not acknowledged.${next.unsure}`);
      }
      if (error instanceof CloudResponseError) return refuse("error", `Intent Cloud's answer was malformed (${error.reason}).${next.unsure}`);
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
    if (isPausedAnswer(result)) return { ...refuse("refused", PAUSED_BY_CLOUD), paused: true as const };
    // Every other 1.7.0 refusal names its reason in `code` (403, or a 409 ceiling): told in the gateway's words, by code.
    const code = result.body !== null && "code" in result.body ? result.body.code : undefined;
    if (code !== undefined && (result.status === 403 || result.status === 409)) {
      return refuse("refused", `Refused: ${code}. ${REFUSAL_CODE_WORDS[code]}`);
    }
    const retry = result.retryAfter === null ? "" : ` Try again in ${waitText(result.retryAfter)}.`;
    // 1.7.0: the per-IP checkout quota. Said once; the gateway never resubmits on its own.
    if (result.status === 429 && result.body !== null && "limit" in result.body && result.body.limit === "checkouts") {
      return refuse("refused", `Refused: Intent Cloud answered that this network has submitted too many checkouts this hour. Nothing was bought, and the gateway does not resubmit by itself.${retry}`);
    }
    // No HTTP status number in the agent's text (an agent relays "a 409 error" to the buyer): it is in `intent log`.
    const message = result.body === null ? null : result.body.message;
    const known = next.refused?.(result.status, message) ?? null;
    if (known !== null) return refuse("error", `${known}${retry}`);
    return refuse("error", `${answerWords(result.status, message)}${retry}${next.answered(result.status)}`);
  }

  /**
   * The next step for each call the agent's tools make, for `call`. Nothing here names a cause the answer did not.
   * "No approval was made" is said only after an answer that refused with a status; when the request may have reached
   * Intent Cloud and no usable answer came back (`unsure`), an approval may exist there, but the gateway has no link
   * to it, so none can be approved.
   */
  const NO_LINK = " Nothing was bought: the gateway has no approval link, so none can be approved.";
  const transient = (status: number): boolean => status >= 500 || status === 429;
  const NEXT_CART: Next = {
    answered: () => " Nothing was bought: no approval was made. Pick another offer, or search again.",
    unsure: `${NO_LINK} Pick another offer, or search again.`,
  };
  const NEXT = {
    search: { answered: () => " Search again, or change the search.", unsure: " Search again, or change the search." },
    cart: NEXT_CART,
    /** A cart to `zip`: Intent Cloud's "did not quote a final total" said in plain words, with its next step. */
    cartTo: (zip: string): Next => ({
      ...NEXT_CART,
      refused: (status, message) =>
        status === 409 && message !== null && /final total/i.test(message)
          ? `This merchant could not quote a final total for delivery to ZIP ${zip}, so no cart was made. Nothing was bought: no approval was made. ` +
            "Pick another offer, or try again later."
          : null,
    }),
    approval: {
      answered: () => " Nothing was bought: no approval was made. Call create_cart again, or pick another offer.",
      unsure: `${NO_LINK} Call create_cart again, or pick another offer.`,
    },
    status: {
      answered: (status: number) =>
        transient(status)
          ? " Call get_approval_status again in a minute."
          : " Calling get_approval_status again will not change this answer. Tell the buyer the approval could not be checked; do not create a new cart for this purchase unless the buyer asks for one.",
      unsure: " Call get_approval_status again in a minute.",
    },
  } as const satisfies Record<string, Next | ((zip: string) => Next)>;

  /** Chains Intent Cloud's `paused` refusal of a request sent since `fromSeq`, and what it says about the pause. */
  async function pausedByCloud(step: "create_cart" | "create_approval", endpoint: string, fromSeq: number): Promise<void> {
    const sent = store.entries().findLast((e) => e.seq > fromSeq && e.kind === "disclosure" && bodyOf(e).endpoint === endpoint);
    await refuseForPause(store, { step, source: "intent_cloud", ...(sent === undefined ? {} : { disclosureSeq: sent.seq }) });
    await noteSubmitAnswer(store, { paused: true, disclosureSeq: sent?.seq ?? null });
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

    // The currency table (1.7.1): which currencies a submitted checkout may be in, and each ship-to country's currency.
    // It must carry `countries`, list two-decimal currencies only, and its version must be the hash of
    // {currencies, countries}; otherwise it is not used (a search or a submit then refuses, naming why).
    const table = meta.body.currency_table;
    currencyTable = usableCurrencyTable(table) ? table : null;
    // Said once on the terminal too, so the developer learns of it before the first search.
    if (currencyTable === null) logger.warn(`intent: ${NO_TABLE_AT_START}`);

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
      logger.warn(`intent: could not tidy the completer keys in ${completerKeys.dir}: ${(error as Error).message}`);
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
        logger.warn(`intent: the key statement expired on ${expiredOn}; fetched and chained a fresh one.`);
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
    // A blocked category is refused first, before any detail is asked for: a search for it would never be sent,
    // whatever the user answers, and words that name it in the product or must-haves count too (invariant 1).
    const blockedCategory = evaluate(
      policy,
      { kind: "search", ...(product === undefined ? {} : { product }), ...(category === undefined ? {} : { category }), ...(input.must_haves === undefined ? {} : { must_haves: input.must_haves }) },
      [],
      now(),
    ).blocked.filter((b) => b.rule === "categories.block");
    if (blockedCategory.length > 0) {
      return block(
        "searchCatalog",
        // The fields the search would have sent, by the request's names (never their values).
        inputFields({
          ...(category === undefined ? {} : { category }),
          ...(product === undefined ? {} : { product }),
          ...(input.must_haves === undefined ? {} : { must_haves: input.must_haves }),
          ...(input.budget === undefined ? {} : { budget_max: { amount_minor: 0, currency: "" } }),
          ...(input.country === undefined && input.postcode === undefined ? {} : { ship_to: { country: "", postal_code: "" } }),
        }),
        blockedCategory.map((b) => `${b.rule} at ${b.path}`),
        fromSeq,
        "blocked",
        `Not sent: this search is for a blocked category (${blockedCategory.map((b) => b.reason).join("; ")}). Nothing was searched. ` +
          "Tell the user this cannot be bought through intent. Do not search again for it with other words.",
        // Structured values only: never the free-text product or must-haves, whose words findIdentity cannot vet.
        category === undefined ? {} : { category },
      );
    }
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
    // The country first: one the gateway cannot ship to is refused before anything else is asked.
    // Anything but a two-letter code (a country's name, say) is asked for again, as the ship-to.
    const named = blankToUndefined(input.country)?.toUpperCase();
    const country = named !== undefined && /^[A-Z]{2}$/.test(named) ? named : undefined;
    const refusal = country === undefined ? null : countryRefusal(country);
    if (refusal !== null) return { status: "refused", message: refusal, summary: summary(fromSeq) };
    const place = country === undefined ? undefined : shipCountry(country);
    // Outside the US the search runs only against Shop: Intent Cloud's catalog search takes a US ZIP only. Said
    // before any postcode is asked for, since no postcode would make it searchable.
    if (place !== undefined && place.code !== "US" && providers.length === 0) {
      return {
        status: "refused",
        message: `Not sent: searching for ${place.name} needs a linked Shop wallet; without one, intent searches the US only. ${LINK_SHOP}`,
        summary: summary(fromSeq),
      };
    }
    // shipsTo admitted the country, so its currency is in the table.
    const currency = place === undefined ? undefined : currencyOf(place.code);
    const budget = input.budget;
    if (budget === undefined || !Number.isFinite(budget) || budget <= 0) {
      missing.push({ field: "budget", ask: `What is the most you want to spend${place === undefined || currency === undefined ? "" : `, in ${currencyWords(currency)}`}?` });
    }
    // The full postcode is coarsened here and goes no further: not into the log, a request or a remembered offer.
    const full = blankToUndefined(input.postcode);
    const coarse = place === undefined || full === undefined ? null : coarsen(place.code, full);
    if (place === undefined) {
      missing.push({ field: "ship_to", ask: "Where should it ship? Country and postcode." });
    } else if (full === undefined) {
      missing.push({ field: "postcode", ask: `Which postcode in ${place.name} should it ship to? Give ${place.format}.` });
    } else if (coarse === null) {
      missing.push({ field: "postcode", ask: `That postcode does not look right for ${place.name}: give ${place.format}.` });
    }
    if (missing.length > 0 || budget === undefined || place === undefined || coarse === null || currency === undefined) {
      return {
        status: "needs_details",
        missing,
        message: `${missing.length === 1 ? "Ask the user only this:" : "Ask the user only these questions:"} ${missing.map((m) => m.ask).join(" ")}`,
        summary: summary(fromSeq),
      };
    }
    const shipTo: ShipTo = { country: place.code as CoarseCountry, coarse };

    const mustHaves = input.must_haves;
    const decision = evaluate(
      policy,
      {
        kind: "search",
        ...(product === undefined ? {} : { product }),
        ...(category === undefined ? {} : { category }),
        ...(mustHaves === undefined ? {} : { must_haves: mustHaves }),
        budget_usd: budget,
        ship_to_zip: coarse,
        ship_to_country: shipTo.country,
      },
      [],
      now(),
    );
    const request: CloudSearchRequest = {
      ...(category === undefined ? {} : { category }),
      ...(product === undefined ? {} : { product }),
      ...(mustHaves === undefined ? {} : { must_haves: mustHaves }),
      budget_max: { amount_minor: Math.round(budget * 100), currency: "USD" },
      ship_to: { country: "US", postal_code: coarse },
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
          ...(decision.blocked.some((b) => b.path === "ship_to_zip") ? { country: shipTo.country, postcode: coarse } : {}),
        },
      );
    }

    // A linked Shop wallet: the search runs here, against Shop, and Intent Cloud is sent nothing (G5).
    if (providers.length > 0) return localSearch({ product, category, mustHaves: mustHaves ?? [], budget, shipTo, currency }, fromSeq);

    const keys = await currentKeys(fromSeq);
    if (!keys.ok) return keys.refused;
    const sent = await call(() => cloud.search(request), fromSeq, NEXT.search);
    if (!sent.ok) return sent.refused;
    const history = spendHistory(store.entries(), now());
    const kept: CloudOffer[] = [];
    const hiddenBy = new Set<string>();
    for (const offer of sent.body.offers) {
      const verdict = evaluate(policy, { kind: "cart", offer: policyOffer(offer.merchant.domain, category ?? "", offer.price, offer.shipping, 1) }, history, now());
      if (verdict.send) kept.push(offer);
      else for (const b of verdict.blocked) hiddenBy.add(b.rule);
    }
    for (const offer of kept) remember(offer.offer_handle, { offer, category: category ?? "", shipTo });
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
    keep(offers, handle, offer);
  }

  /**
   * The search seam (G5, ADR-0021): the providers (Shop's search_catalog, logged before it is sent), then merge, the
   * policy filter and the excluded categories, all here. Each offer kept gets a new opaque handle.
   */
  async function localSearch(
    asked: { product: string | undefined; category: string | undefined; mustHaves: readonly string[]; budget: number; shipTo: ShipTo; currency: string },
    fromSeq: number,
  ): Promise<FindOffersResult> {
    const { currency, shipTo } = asked;
    const budget = { amountMinor: Math.round(asked.budget * 100), currency };
    let found: SearchOffer[];
    try {
      found = await searchProviders(providers, {
        ...(asked.product === undefined ? {} : { product: asked.product }),
        ...(asked.category === undefined ? {} : { category: asked.category }),
        mustHaves: asked.mustHaves,
        budget,
        country: shipTo.country,
        currency,
        postcode: shipTo.coarse,
      });
    } catch (error) {
      return { status: providerFailure(error), message: searchFailureMessage(error), summary: summary(fromSeq) };
    }
    const filtered = filterOffers(policy, found, {
      ...(asked.category === undefined ? {} : { category: asked.category }),
      budget,
      currency,
      ceilings: ceilings(),
      history: spendHistory(store.entries(), now()),
      now: now(),
    });
    const shown = filtered.kept.map((offer): ShopOfferView => {
      const handle = newOfferHandle();
      keep(localOffers, handle, { offer, quantity: 1, category: asked.category ?? "", shipTo, currency });
      return shopOfferView(handle, offer);
    });
    const { hidden } = filtered;
    const rules = filtered.rules.join(", ");
    const hiddenNote = hidden === 0 ? "" : ` ${String(hidden)} more hidden by the gateway policy (${rules}).`;
    const hiddenBlocked = hidden === 0 ? [] : [`${String(hidden)} offer${hidden === 1 ? "" : "s"} (${rules})`];
    return {
      status: "shop_offers",
      offers: shown,
      hidden,
      message:
        `${String(shown.length)} offer${shown.length === 1 ? "" : "s"} from Shop search, made by this gateway; nothing was sent to Intent Cloud for it. ` +
        `Shipping is shown at checkout.${hiddenNote}`,
      summary: summary(fromSeq, hiddenBlocked),
    };
  }

  // ---- create cart ----------------------------------------------------------------------------------------------

  async function createCart(raw: unknown): Promise<CreateCartResult> {
    started();
    const fromSeq = head();
    // A pause stops every cart before anything is built or sent (ADR-0023); the refusal is chained under the lease.
    if (pausedIn(store.entries()) && (await refuseForPause(store, { step: "create_cart", source: "gateway" }))) {
      return { status: "refused", message: pausedRefusalWords(pauseState(store.entries())), summary: summary(fromSeq) };
    }
    const identity = await identityRefusal("createCart", raw, fromSeq);
    if (identity !== null) return identity;
    const parsed = CreateCartInput.safeParse(raw);
    if (!parsed.success) return { status: "invalid", message: `Not sent: ${z.prettifyError(parsed.error)}`, summary: summary(fromSeq) };
    const quantity = parsed.data.quantity ?? 1;
    const offerHandle = parsed.data.offer_handle;
    // The same offer again while its approval is open: the same pending purchase, never a second approval.
    // The postcode of the search the handle is remembered from now: a later search to another ZIP is another cart.
    const postcode = (localOffers.get(offerHandle) ?? offers.get(offerHandle))?.shipTo.coarse;
    const same = samePending(offerHandle, quantity, postcode, fromSeq);
    if (same !== null) return same;
    const made = await newCart(offerHandle, quantity, fromSeq);
    if (made.status === "approval_needed") askedFor.set(offerHandle, { approval: made.approval_handle, quantity, postcode });
    return made;
  }

  async function newCart(offerHandle: string, quantity: number, fromSeq: number): Promise<CreateCartResult> {
    const local = localOffers.get(offerHandle);
    if (local !== undefined) return submitShopCheckout(local, quantity, fromSeq);
    const known = offers.get(offerHandle);
    if (known === undefined) {
      return {
        status: "invalid",
        message: "Not sent: this gateway has no such offer (it keeps offers only while it runs). Call find_offers again and use an offer_handle from that result.",
        summary: summary(fromSeq),
      };
    }

    // The policy on the offer as searched, with the spend so far from the chain.
    const domain = known.offer.merchant.domain;
    const before = spendCheck(policyOffer(domain, known.category, known.offer.price, known.offer.shipping, quantity));
    const request: Omit<CloudCartRequest, "completer_keyid" | "completion_accepts"> = { offer_handle: known.offer.offer_handle, quantity, ship_to: { country: "US", postal_code: known.shipTo.coarse } };
    if (before.length > 0) {
      return block("createCart", inputFields(request), before.map((b) => `${b.rule} at ${b.path}`), fromSeq, "blocked",
        `Not sent: the gateway policy refuses this cart (${policyWords(before).join("; ")}).`,
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
    const accepts = completionAccepts(known.offer.myshopify_domain);
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
    const cartCall = await call(() => cloud.createCart(request), fromSeq, NEXT.cartTo(request.ship_to.postal_code));
    if (!cartCall.ok) {
      if (cartCall.paused === true) await pausedByCloud("create_cart", "createCart", fromSeq);
      return cartCall.refused;
    }
    // The submit went through: a resume the developer confirmed at a terminal is confirmed by Intent Cloud's answer.
    if (pauseState(store.entries()).unconfirmedResume !== null) await noteSubmitAnswer(store, { paused: false, disclosureSeq: cartCall.seq });
    const cart = cartCall.body;
    await store.append("observed", observeCart(cartCall.seq, cart));
    const mode = cart.completion_mode;
    const cartProblems = [
      ...(cart.merchant.domain === domain ? [] : ["merchant differs from the offer"]),
      ...(cart.quantity === quantity ? [] : ["quantity differs from the request"]),
      ...cartV16Problems(cart, known.offer, request.completion_accepts),
    ];
    if (cartProblems.length > 0) {
      return block("createCart", ["cart"], cartProblems.map((p) => `cart: ${p}`), fromSeq, "refused",
        `Refused: the cart Intent Cloud created does not match what was asked (${cartProblems.join("; ")}). No approval was requested.`);
    }
    // The cart's total is the first quoted one (shipping and tax included): it can be over a limit the offer fitted.
    const overQuoted = spendCheck(policyOffer(cart.merchant.domain, known.category, cart.total, null, cart.quantity), mode);
    if (overQuoted.length > 0) {
      return block("createCart", ["cart"], overQuoted.map((b) => `cart: ${b.reason}`), fromSeq, "refused",
        `Refused: the gateway policy refuses this cart (${policyWords(overQuoted, { totalMinor: cart.total.amount_minor, currency: "USD" }).join("; ")}). No approval was requested. Pick a cheaper offer or a smaller quantity.`);
    }

    // What step 7 matches the snapshot to, now and when the approval is accepted (chained below). Checked against its
    // schema before the approval request, so a `sent` that step 7 could not read never reaches the buyer's passkey.
    const sent = readSent({
      contract_version: CONTRACT_VERSION,
      cart_request: request,
      offer: {
        variant_ref: known.offer.variant_ref,
        merchant: known.offer.merchant,
        ...(known.offer.myshopify_domain === undefined ? {} : { myshopify_domain: known.offer.myshopify_domain }),
      },
      cart: {
        merchant_origin: cart.merchant_origin,
        variant_ref: cart.variant_ref,
        total: cart.total,
        expires_at: cart.expires_at,
        ...(cart.myshopify_domain === undefined ? {} : { myshopify_domain: cart.myshopify_domain }),
      },
    });
    if (sent === null) {
      return block("createCart", ["cart"], ["cart: not what step 7 can check (sent)"], fromSeq, "refused",
        "Refused: the cart and offer do not give what the approval is checked against (Appendix E step 7). No approval was requested.");
    }

    // A pause chained while the cart was being made stops the purchase at its next outward step (ADR-0023).
    if (pausedIn(store.entries()) && (await refuseForPause(store, { step: "create_approval", source: "gateway" }))) {
      return { status: "refused", message: pausedRefusalWords(pauseState(store.entries())), summary: summary(fromSeq) };
    }
    const approvalCall = await call(() => cloud.createApproval(cart.cart_handle), fromSeq, NEXT.approval);
    if (!approvalCall.ok) {
      if (approvalCall.paused === true) await pausedByCloud("create_approval", "createApproval", fromSeq);
      return approvalCall.refused;
    }
    const served = approvalCall.body;
    await store.append("observed", observeApproval(approvalCall.seq, served));
    // A cart's approval carries a v3 snapshot (1.7.0 keeps v3 for carts); a v4 one belongs to a submitted checkout.
    if (served.snapshot.v !== 3) {
      return block("createApproval", ["snapshot"], [`snapshot: ${SENT_WORDS.v}`], fromSeq, "refused",
        `Refused: the purchase snapshot does not match the cart (${SENT_WORDS.v}). Do not approve it.`);
    }
    const created = { ...served, snapshot: served.snapshot };
    const snapshotProblems = [
      ...checkSnapshot(created, cart, sent),
      ...policyWords(
        spendCheck(policyOffer(created.snapshot.merchant.domain, known.category, created.snapshot.total, null, created.snapshot.quantity), mode),
        { totalMinor: created.snapshot.total.amount_minor, currency: "USD" },
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
      const over = policyWords(spendCheck(reserved, mode));
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
      // The link and the check code are in the result's own fields (approval_url, check_code), said once.
      message:
        options.demo === undefined
          ? `Ask the buyer to open the approval link (or scan the QR code), check that the page shows the check code, and approve with their passkey. ` +
            "Then call get_approval_status."
          : `Demo: ask the user to open the approval link, check that the page shows the check code, and click "${approveLabel(created.snapshot.total.amount_minor)}" ` +
            "(enter the demo code: the page shows the command that prints it). Then call get_approval_status.",
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
    return evaluate(policy, { kind: "cart", offer, ...completion }, spendHistory(chain, at), at, ceilings()).blocked;
  }

  /**
   * The policy's refusals in the agent's words. The daily and weekly limits say that carts waiting for approval count
   * toward them (spendHistory). With `quoted` (a total the merchant or Shop quoted, shipping and tax included), the
   * per-order refusal names that total and the limit, so a cart the offer's price fitted is not left unexplained.
   */
  function policyWords(blocked: readonly Blocked[], quoted?: { readonly totalMinor: number; readonly currency: string }): string[] {
    return blocked.map((b) => {
      if (b.rule === "spend.per_day_usd" || b.rule === "spend.per_week_usd") return `${b.reason} (carts waiting for approval count toward it)`;
      if (b.rule !== "spend.per_order_usd" || quoted === undefined) return b.reason;
      const cap = capsIn(meet(policy, CLOUD_BASELINE).spend, quoted.currency, ceilings())?.per_order_usd;
      if (cap === undefined) return b.reason;
      return `the total with shipping and tax, ${formatMinor(quoted.totalMinor, quoted.currency)}, is over the ${formatMinor(cap, quoted.currency)} per-order limit`;
    });
  }

  /**
   * `completion_accepts` for a cart (contract 1.6.0 §3): the modes the policy, met with Intent Cloud's baseline,
   * allows and this gateway can complete, gateway wallets first and `handoff` last.
   */
  function completionAccepts(myshopifyDomain: string | undefined): CloudCompletionMode[] {
    const allowed = meet(policy, CLOUD_BASELINE).completion.map((m) => CONTRACT_MODE[m]);
    // The wallet's mode only for a Shopify store Intent Cloud names (1.6.1: the offer's myshopify_domain, which the
    // passkey then signs): otherwise the purchase is handed off from the start, rather than refused after the tap.
    const storeKnown = myshopifyDomain !== undefined && isMyshopifyDomain(myshopifyDomain);
    const usable = [...(options.walletModes?.() ?? []), ...(wallet === null || !storeKnown ? [] : (["shop_agent"] as const))];
    const wallets = usable.filter((m) => m !== "handoff" && allowed.includes(m));
    return [...new Set(wallets), ...(allowed.includes("handoff") ? ["handoff" as const] : [])];
  }

  // ---- submitted Shop checkout (contract 1.7.0, G6) ----------------------------------------------------------------

  /**
   * An offer from Shop search: the gateway creates the Shop checkout (line items only: Shop fills delivery from the
   * account), reads it back, checks it here, and submits what the buyer will pay to `POST /v1/checkouts` for the
   * passkey approval (ADR-0024). Every send is logged first (invariant 2); only the country and the coarse postcode
   * leave for Intent Cloud, never the full postcode or any buyer identity (invariant 3). A checkout that goes no
   * further is forgotten (its id released). After the passkey, get_approval_status redeems it under the one-tap rules.
   */
  async function submitShopCheckout(local: LocalOffer, quantity: number, fromSeq: number): Promise<CreateCartResult> {
    const offer = local.offer;
    const endpoint = "createCheckout";
    const refuse = (blocked: string, message: string, status: Refused["status"] = "refused", held: Readonly<Record<string, unknown>> = {}): Promise<Refused> =>
      block(endpoint, ["checkout"], [blocked], fromSeq, status, message, held);

    // The policy on the offer as searched, in the search's currency (the caps scaled to it; prices never converted).
    const { currency: searched } = local;
    if (offer.price.currency !== searched) {
      return refuse(`currency ${offer.price.currency}`, `Not sent: the offer is priced in ${offer.price.currency}, not the ${searched} the search was in; the gateway never converts.`);
    }
    const before = spendCheck({ merchant: offer.storeDomain, category: local.category, price_usd: offer.price.amountMinor / 100, quantity, currency: searched });
    if (before.length > 0) {
      return block(endpoint, ["checkout"], before.map((b) => `${b.rule} at ${b.path}`), fromSeq, "blocked",
        `Not sent: the gateway policy refuses this purchase (${policyWords(before).join("; ")}).`, { title: offer.title, quantity });
    }
    if (wallet === null) return refuse("wallet: none", "Not sent: no usable Shop wallet is linked, so the gateway cannot prepare this Shop checkout.", "error");
    const table = currencyTable;
    if (table === null) {
      return refuse("currency_table: none", NO_CURRENCY_TABLE, "error");
    }
    let account: AccountKeyPort;
    try {
      const read = await options.accountKey?.();
      if (read === undefined) throw new Error("no account key is configured");
      account = read;
    } catch (error) {
      return refuse("account_key: none", `Not sent: the account key could not be read (${(error as Error).message}). Run \`${INTENT} init\`.`, "error");
    }
    const fresh = await currentKeys(fromSeq);
    if (!fresh.ok) return fresh.refused;

    // 1. Create the Shop checkout (line items only), then read it back: what Shop will charge is what is submitted.
    const purchase = `pc_${randomBytes(12).toString("base64url")}`;
    let created: WalletCheckout;
    try {
      created = await wallet.createCheckout({ purchase, storeDomain: offer.storeDomain, lines: [{ variantRef: offer.variantRef, quantity }], shipToPostalCode: local.shipTo.coarse });
    } catch (error) {
      return { status: providerFailure(error), message: checkoutFailureMessage(error), summary: summary(fromSeq) };
    }
    const forget = (c: WalletCheckout): Promise<void> => wallet.release({ storeDomain: c.storeDomain, checkoutRef: c.checkoutRef }).catch(() => undefined);
    let checkout: WalletCheckout;
    try {
      checkout = await wallet.getCheckout({ storeDomain: created.storeDomain, checkoutRef: created.checkoutRef }, purchase);
    } catch (error) {
      await forget(created);
      return { status: providerFailure(error), message: checkoutFailureMessage(error), summary: summary(fromSeq) };
    }

    // 2. The checkout must be the offer, in the search's currency (one Intent Cloud supports), shipping to the country
    //    and coarse postcode the user gave.
    const problem = shopCheckoutProblem(checkout, created, offer, quantity, local, table);
    if (problem !== null) {
      await forget(checkout);
      return refuse(problem.rule, `Not sent: ${problem.words}. Nothing was submitted for approval and nothing was bought.`, "refused",
        problem.rule.startsWith("currency_unsupported") ? { currency: checkout.total?.currency ?? "", currency_table: table.version } : {});
    }
    const totals = checkout.totals as NonNullable<WalletCheckout["totals"]>;
    const area = checkout.shipToArea as NonNullable<WalletCheckout["shipToArea"]>;
    const currency = (checkout.total as NonNullable<WalletCheckout["total"]>).currency;

    // 3. The completion mode: one tap when the policy allows it and Shop can pay this checkout from the agent budget
    //    now; otherwise Shop's own checkout page (decision 28), when the policy allows the hand-off.
    const allowed = meet(policy, CLOUD_BASELINE).completion;
    let budgetCovers: boolean;
    try {
      const acct = await wallet.account();
      budgetCovers = acct.connected && acct.budgetRemaining !== null && acct.budgetRemaining.currency === currency && acct.budgetRemaining.amountMinor >= totals.total;
    } catch {
      budgetCovers = false;
    }
    const oneTapReady = allowed.includes("one_tap") && checkout.status === "open" && checkout.budgetOffered && budgetCovers;
    // A real DNS name only (1.7.0 StoreSite): a storefront origin that is an IP literal, one label or ends in a number
    // is refused here, before anything reaches Intent Cloud, as Intent Cloud would refuse it (400).
    const storeSite = offer.storefrontOrigin ?? `https://${offer.storeDomain}`;
    if (!StoreSite.safeParse(storeSite).success) {
      await forget(checkout);
      return refuse("store_site", "Not sent: the store's site is not a DNS name the contract allows (an IP address, a single label or a numeric ending).");
    }
    let mode: CloudCompletionMode;
    let continueUrl: string | undefined;
    if (oneTapReady) {
      mode = "shop_agent";
    } else if (allowed.includes("handoff") && checkout.continueUrl != null && continueUrlAllowed(checkout.continueUrl, { myshopify_domain: offer.storeDomain, store_site: storeSite })) {
      mode = "handoff";
      continueUrl = checkout.continueUrl;
    } else {
      await forget(checkout);
      const why = !allowed.includes("one_tap")
        ? "the gateway policy does not allow one tap, and Shop gave no checkout page on the store's own hosts to hand off to"
        : !budgetCovers || !checkout.budgetOffered
          ? 'Shop agent payments do not cover this checkout (turn on "Allow agent to pay" with a budget in the Shop app), and no hand-off page is allowed'
          : "Shop asks the buyer to finish this checkout, and gave no checkout page on the store's own hosts to hand off to";
      return refuse("completion: none", `Not sent: ${why}.`, "blocked");
    }
    const spend = spendCheck({ merchant: offer.storeDomain, category: local.category, price_usd: totals.total / 100 / quantity, quantity, currency }, mode);
    if (spend.length > 0) {
      await forget(checkout);
      return block(endpoint, ["checkout"], spend.map((b) => `${b.rule} at ${b.path}`), fromSeq, "blocked",
        `Not sent: the gateway policy refuses this checkout (${policyWords(spend, { totalMinor: totals.total, currency }).join("; ")}). Pick a cheaper offer or a smaller quantity.`, { title: offer.title, quantity });
    }

    // 4. The completer key, on disk before the request names it (ADR-0016), then the submit, logged before it is sent.
    let completer: Session;
    try {
      const earlier = new Set(store.entries().flatMap((e) => (e.kind === "approval_pending" ? [bodyOf(e).completer_keyid] : [])));
      completer = await completerKeys.create((keyid) => !earlier.has(keyid) && findIdentity({ completer_keyid: keyid }).length === 0);
    } catch (error) {
      await forget(checkout);
      return { status: "error", message: `Not sent: the completer key could not be saved (${(error as Error).message}).`, summary: summary(fromSeq) };
    }
    const lineTitle = checkout.lines[0]?.title ?? "";
    const request: CheckoutRequest = {
      checkout: {
        checkout_ref_hash: checkout.checkoutRef,
        myshopify_domain: checkout.storeDomain,
        store_site: storeSite,
        store_name: storeNameOf(offer),
        variant_ref: offer.variantRef,
        title: (lineTitle !== "" ? lineTitle : offer.title !== "" ? offer.title : "(untitled)").slice(0, 120),
        quantity,
        currency,
        totals: { subtotal: totals.subtotal, shipping: totals.shipping, tax: totals.tax, total: totals.total },
        ship_to: { country: area.country as CoarseCountry, postal_code: area.postalCodeCoarse as string },
        ...(continueUrl === undefined ? {} : { continue_url: continueUrl }),
      },
      completion_mode: mode,
      completer_keyid: completer.keyid,
      account_key: { kty: "OKP", crv: "Ed25519", x: account.publicJwk.x },
    };
    // What step 7 checks, chained: the request without its continue_url (a credential, never chained), and its hash.
    const sent = sentCheckoutOf(request, table.version);
    let keep = false;
    try {
      const outcome = await submitAndCheck(request, sent, checkout, fresh.keys.confirmOrigin, fromSeq);
      keep = outcome.status === "approval_needed";
      return outcome;
    } finally {
      if (!keep) {
        await dropKey(completer.keyid);
        await forget(checkout);
      }
    }
  }

  /** The submit, the checks of the approval it returns (Appendix E step 7 before the passkey), and the pending entry. */
  async function submitAndCheck(
    request: CheckoutRequest,
    sent: SentCheckout,
    checkout: WalletCheckout,
    confirmOrigin: string,
    fromSeq: number,
  ): Promise<CreateCartResult> {
    // A pause chained since create_cart began (another process, the panel) stops the submit too (ADR-0023).
    if (pausedIn(store.entries()) && (await refuseForPause(store, { step: "create_cart", source: "gateway" }))) {
      return { status: "refused", message: pausedRefusalWords(pauseState(store.entries())), summary: summary(fromSeq) };
    }
    const submitted = await call(() => cloud.createCheckout(request), fromSeq, NEXT.cart);
    if (!submitted.ok) {
      if (submitted.paused === true) await pausedByCloud("create_cart", "createCheckout", fromSeq);
      return submitted.refused;
    }
    // The submit went through: a resume the developer confirmed at a terminal is confirmed by Intent Cloud's answer.
    if (pauseState(store.entries()).unconfirmedResume !== null) await noteSubmitAnswer(store, { paused: false, disclosureSeq: submitted.seq });
    const created = submitted.body;
    await store.append("observed", observeApproval(submitted.seq, created));
    const s = created.snapshot;
    const parsedSent = readSentCheckout(sent);
    const problems: string[] = [];
    if (parsedSent === null) problems.push("the request is not what step 7 can check");
    if (sha256Hex(canonicalize(s)) !== created.snapshot_hash) problems.push("snapshot_hash is not the snapshot's hash");
    if (created.check_code !== created.snapshot_hash.slice(0, 8)) problems.push("check_code is not the start of snapshot_hash");
    if (s.approval !== created.approval_handle) problems.push("snapshot is for another approval");
    if (created.state !== "pending") problems.push(`approval is ${created.state}, not pending`);
    const own = snapshotV4Problem(s);
    if (own !== null) problems.push(`snapshot breaks the v4 rules (${own})`);
    if (parsedSent !== null) problems.push(...sentCheckoutProblems(s, parsedSent).map((r) => SENT_CHECKOUT_WORDS[r]));
    if (problems.length > 0 || s.v !== 4) {
      return block("createCheckout", ["snapshot"], problems.map((p) => `snapshot: ${p}`), fromSeq, "refused",
        `Refused: the purchase snapshot is not the checkout this gateway submitted (${problems.join("; ")}). Do not approve it.`);
    }
    const approvalUrl = (options.demo?.confirmBaseUrl ?? confirmOrigin) + created.approval_link_path;
    const mode = s.completion_mode;
    const reserved = { merchant: s.myshopify_domain, category: "", price_usd: s.totals.total / 100 / s.quantity, quantity: s.quantity, currency: s.currency };
    try {
      await store.appendUnless(
        "approval_pending",
        {
          handle: created.approval_handle,
          approval_url: approvalUrl,
          snapshot_hash: created.snapshot_hash,
          total_minor: s.totals.total,
          // The spend history counts it in this currency only (an entry without one is a USD cart).
          currency: s.currency,
          expires_at: s.expires_at,
          completion_mode: mode,
          completer_keyid: request.completer_keyid,
          checkout_ref: s.checkout_ref_hash,
          sent,
        },
        (chain) => spendCheck(reserved, mode, chain).length > 0,
      );
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      const over = policyWords(spendCheck(reserved, mode));
      return block("createCheckout", ["snapshot"], over.map((p) => `snapshot: ${p}`), fromSeq, "refused",
        `Refused: another purchase took the room under the gateway policy's limits meanwhile (${over.join("; ")}). Do not approve it.`);
    }
    createdHere.add(created.approval_handle);
    const how = mode === "shop_agent" ? "approving pays at once through the buyer's Shop agent payments" : "after approving, the buyer pays on Shop's checkout page";
    return {
      status: "approval_needed",
      approval_handle: created.approval_handle,
      approval_url: approvalUrl,
      check_code: created.check_code,
      qr: approvalQr(approvalUrl),
      checkout: {
        store: s.store_name,
        title: s.title,
        quantity: s.quantity,
        totals: s.totals,
        currency: s.currency,
        ship_to: s.ship_to,
        completion_mode: mode,
      },
      message:
        options.demo === undefined
          ? `Ask the buyer to open the approval link (or scan the QR code), check that the page shows the check code, and approve with their passkey; ${how}. ` +
            "Then call get_approval_status."
          : `Demo: ask the user to open the approval link, check that the page shows the check code, and click "${approveLabel(s.totals.total, s.currency)}" ` +
            `(enter the demo code: the page shows the command that prints it); ${how}. Then call get_approval_status.`,
      summary: summary(fromSeq),
    };
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
    const pending = handle === undefined ? undefined : chain.findLast((e) => e.kind === "approval_pending" && bodyOf(e).handle === handle);
    if (handle === undefined || pending === undefined) {
      // A new agent session has no handle: the purchases still waiting, from the local log only (nothing is sent).
      // Never "Waiting for": the prompt polls on those words, and this is no status of any purchase.
      const said =
        handle === undefined
          ? "No approval_handle was given."
          : "That approval_handle is not known: this gateway did not ask for that approval, so it cannot report on it.";
      return { status: "unknown", message: `${said} ${waitingWords(chain)}`, summary: summary(fromSeq) };
    }
    const chained = chain.find((e) => e.kind === "approval" && bodyOf(e).handle === handle);
    // Contract 1.7.0: a later submit of the same checkout in the same mode supersedes this approval (Intent Cloud
    // expires it), so it is dead here too, whatever is read for it: only the newest one can be approved.
    if (chained === undefined && supersededIn(chain, pending)) {
      return { status: "expired", message: "This approval was replaced by a newer one for the same Shop checkout; use the newest approval link.", summary: summary(fromSeq) };
    }

    const fresh = await currentKeys(fromSeq);
    if (!fresh.ok) return fresh.refused;
    const keys = fresh.keys;
    const signer = await readSigner(handle, bodyOf(pending));
    const fetched = await call(() => cloud.getApproval(handle, signer), fromSeq, NEXT.status);
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
            : `Waiting for the user to click "${approveLabel(bodyOf(pending).total_minor, bodyOf(pending).currency)}" on the approval link (with the demo code: the page shows the command that prints it).`
          : status.state === "rejected"
            ? "The buyer rejected this purchase."
            : "This approval expired. Create a new cart to try again.";
      return { status: status.state === "pending" ? "pending" : status.state === "rejected" ? "rejected" : "expired", message, summary: summary(fromSeq) };
    }

    // A live approval is a 1.6.x one, chained with step 7's `sent`. A pending entry without it (written by a 1.5.0
    // gateway) is refused here, so the released 1.5.0 proof form is accepted only by `intent verify` on old chains.
    if (readSent(bodyOf(pending).sent) === null && readSentCheckout(bodyOf(pending).sent) === null) {
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
      logger.warn(`intent: pinned the first approving passkey. Fingerprint: ${check.fingerprint}`);
    }
    const shown = await recordOutcome(handle, status, verified.snapshot, verified.snapshotHash, keys);
    const parsedProof = BindableApprovalProof.safeParse(status.proof);
    const completion = mode === "shop_agent" && parsedProof.success ? await complete(handle, pending, parsedProof.data, keys) : null;
    return approved(check.fingerprint, status, mode, shown, fromSeq, completion);
  }

  /**
   * The purchases waiting for approval as this gateway's log shows them, newest first, for an agent that lost the
   * handle: asked for, not expired, not replaced by a newer submit, no approval chained, and no status read since
   * that says otherwise. Each with its item, total, age and handle, from the gateway's own entries; no status is
   * claimed for any of them beyond that, and the agent reads one with its handle.
   */
  function waitingWords(chain: readonly Entry[]): string {
    const at = now();
    const shown = new Map<unknown, { title?: unknown; merchant?: unknown }>();
    for (const e of chain) {
      if (e.kind !== "observed") continue;
      const b = bodyOf(e);
      if (b.endpoint === "createApproval" || b.endpoint === "createCheckout") shown.set(b.approval_handle, { title: b.title, merchant: b.merchant });
    }
    const waiting = openPending(chain).reverse().slice(0, MAX_WAITING_LISTED);
    if (waiting.length === 0) return "This gateway's log has no purchase still open.";
    const lines = waiting.map((e) => {
      const b = bodyOf(e);
      const item = shown.get(b.handle);
      const title = typeof item?.title === "string" && item.title !== "" ? item.title : "(item not recorded)";
      const from = typeof item?.merchant === "string" && item.merchant !== "" ? ` from ${item.merchant}` : "";
      const total = typeof b.total_minor === "number" ? `, total ${formatMinor(b.total_minor, typeof b.currency === "string" ? b.currency : "USD")}` : "";
      // The link and the check code as chained when the approval was asked for: read from the log, never fetched.
      const link = typeof b.approval_url === "string" ? `\n  Approval link: ${b.approval_url}` : "";
      const code = typeof b.snapshot_hash === "string" ? `\n  Check code: ${b.snapshot_hash.slice(0, 8)}` : "";
      return `- ${title}${from}${total}, asked for ${ageText(at - Date.parse(e.ts))} ago. approval_handle: ${String(b.handle)}${link}${code}`;
    });
    return (
      `Purchases with no approval chained in this gateway's log, newest first:\n${lines.join("\n")}\n` +
      "The buyer can still open a link above and approve with their passkey. Call get_approval_status with one of these approval_handles " +
      "to read its status; do not create a new cart for them."
    );
  }

  /**
   * The approvals this gateway's log shows as still open, oldest first: asked for, not expired, not replaced by a
   * newer submit, no approval chained, and no status read since that says otherwise. From the local log only.
   */
  function openPending(chain: readonly Entry[]): Entry[] {
    const at = now();
    const approved = new Set(chain.flatMap((e) => (e.kind === "approval" ? [bodyOf(e).handle] : [])));
    const lastRead = new Map<unknown, unknown>();
    for (const e of chain) {
      if (e.kind === "observed" && bodyOf(e).endpoint === "getApproval") lastRead.set(bodyOf(e).approval_handle, bodyOf(e).state);
    }
    return chain.filter((e) => {
      if (e.kind !== "approval_pending") return false;
      const b = bodyOf(e);
      const expires = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : Number.NaN;
      const read = lastRead.get(b.handle);
      return !approved.has(b.handle) && expires > at && (read === undefined || read === "pending") && !supersededIn(chain, e);
    });
  }

  /**
   * The open approval this process asked for with the same offer handle, quantity and postcode, as an approval_needed
   * result that sends nothing and makes no new approval: the same link and check code, which still need the buyer's passkey
   * (invariant 4). Null when there is none, or it is no longer open in the log.
   */
  function samePending(offerHandle: string, quantity: number, postcode: string | undefined, fromSeq: number): CreateCartResult | null {
    const earlier = askedFor.get(offerHandle);
    if (earlier === undefined || earlier.quantity !== quantity || postcode === undefined || earlier.postcode !== postcode) return null;
    const pending = openPending(store.entries()).find((e) => bodyOf(e).handle === earlier.approval);
    if (pending === undefined) return null;
    const b = bodyOf(pending);
    if (typeof b.approval_url !== "string" || typeof b.snapshot_hash !== "string") return null;
    const total = typeof b.total_minor === "number" ? ` (total ${formatMinor(b.total_minor, typeof b.currency === "string" ? b.currency : "USD")})` : "";
    return {
      status: "approval_needed",
      approval_handle: earlier.approval,
      approval_url: b.approval_url,
      check_code: b.snapshot_hash.slice(0, 8),
      qr: approvalQr(b.approval_url),
      message:
        `This is the same pending purchase${total}, asked for ${ageText(now() - Date.parse(pending.ts))} ago: no new cart was made. ` +
        "Its status in this gateway's log: waiting for the buyer's passkey. Ask the buyer to open the same approval link (or scan the QR code), " +
        "check that the page shows the check code, and approve with their passkey. Then call get_approval_status.",
      summary: summary(fromSeq),
    };
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
    const proof = BindableApprovalProof.safeParse(bodyOf(chained).proof);
    if (!proof.success) return { status: "not_verified", message: `The chained approval is malformed; run ${INTENT} verify.`, summary: summary(fromSeq) };
    const handle = String(bodyOf(chained).handle);
    const shown = await recordOutcome(handle, status, proof.data.snapshot, proof.data.snapshot_hash, keys);
    // After a restart every resume comes through here (plan G7b step 6, resume rule).
    const completion = mode === "shop_agent" ? await complete(handle, pending, proof.data, keys) : null;
    return approved(approverFingerprint(proof.data.credential_public_key), status, mode, shown, fromSeq, completion);
  }

  /** Advances a verified `shop_agent` purchase (complete.ts), every Intent Cloud call signed with its completer key. */
  async function complete(handle: string, pending: Entry, proof: BindableApprovalProof, keys: KeySet): Promise<CompletionView> {
    const keyid = bodyOf(pending).completer_keyid;
    let signer: Session | undefined;
    try {
      signer = typeof keyid === "string" ? ((await completerKeys.load(keyid)) ?? undefined) : undefined;
    } catch {
      signer = undefined;
    }
    const met = meet(policy, CLOUD_BASELINE);
    const cap = paymentCapMinor(met.spend, proof.snapshot, ceilings());
    const oneTap = options.oneTap;
    return advanceCompletion(
      {
        store,
        cloud,
        wallet,
        storefront,
        oneTapAllowed: met.completion.includes("one_tap"),
        overCap: (chain) => {
          // This purchase counted once: its own approval and pending entries left out, then evaluated as a new cart.
          const others = chain.filter((e) => !((e.kind === "approval" || e.kind === "approval_pending") && bodyOf(e).handle === handle));
          return spendCheck(paymentOffer(proof.snapshot), "shop_agent", others).some(
            (b) => b.rule.startsWith("spend.") || b.rule === "history_invalid",
          );
        },
        perOrderCapMinor: cap,
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
    const held = statement !== undefined && findIdentity(statement, { orderRefAt: ORDER_REF_AT.statement }).length === 0;
    if (statement !== undefined && !held) check = { ok: false, refused_by: "identity", signed: false };
    const approvedTotal = snapshotTotal(snapshot);
    const reading = readCloudOutcome(stated, approvedTotal.amount_minor, check, { currency: approvedTotal.currency, rule: bindingRuleFor(snapshot) });
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
        `intent: Intent Cloud reported outcome ${cloud.state} for ${handle} after it reported the final outcome ${adopted.cloud.state} (Appendix G R5a); the gateway keeps the earlier one.`,
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
      logger.warn(`intent: Intent Cloud reported an approval state and an outcome that disagree (${inconsistent}); the gateway does not repeat them.`);
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
    sendPause: (request, unless) => {
      started();
      return cloud.pause(request, unless);
    },
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
  currency = "USD",
): PolicyOffer {
  const totalMinor = shipping === null ? price.amount_minor : price.amount_minor * quantity + shipping.amount_minor;
  return { merchant, category, price_usd: totalMinor / 100 / quantity, quantity, ...(currency === "USD" ? {} : { currency }) };
}

/**
 * The policy's per-order cap at payment, in the approved currency's minor units (a v4 snapshot's `currency`; USD before
 * v4), scaled by Intent Cloud's ceilings; null when the policy sets none. A cap that cannot be put in that currency is
 * 0, so nothing is paid: never no cap.
 */
export function paymentCapMinor(spend: Policy["spend"], snapshot: AnySnapshot, ceilings: CurrencyTable["currencies"] | null): number | null {
  if (spend.per_order_usd === undefined) return null;
  return capsIn(spend, snapshotTotal(snapshot).currency, ceilings)?.per_order_usd ?? 0;
}

/** An approved purchase in the policy's terms at payment: its total, in its own currency, counted as one new cart. */
export function paymentOffer(s: AnySnapshot): PolicyOffer {
  const total = snapshotTotal(s);
  return s.v === 4 ? policyOffer(s.myshopify_domain, "", total, null, s.quantity, total.currency) : policyOffer(s.merchant.domain, "", total, null, s.quantity);
}

/**
 * An answer with an error status and no refusal code, in words and without the status number (that is in
 * `intent log`): what kind of answer it was, then Intent Cloud's own message when it gave one.
 */
function answerWords(status: number, message: string | null): string {
  const said = message === null || message === "" ? "" : `: ${message}`;
  if (status >= 500) return `Intent Cloud answered with an error on its side${said}.`;
  if (status === 429) return `Intent Cloud answered that it is limiting requests from this gateway for now${said}.`;
  if (status === 404) return `Intent Cloud answered that it does not know this handle${said}.`;
  if (status === 410) return `Intent Cloud answered that this has expired${said}.`;
  return `Intent Cloud answered with a refusal${said}.`;
}

/** What the agent is told when Intent Cloud answered `paused`. */
const PAUSED_BY_CLOUD = "A `paused` answer was received from Intent Cloud for this account. Nothing is bought until the developer resumes with their passkey; do not retry.";

/** The policy's completion mode for a contract mode; an unknown one maps to itself, which the policy refuses. */
function policyMode(mode: CloudCompletionMode): PolicyCompletionMode {
  const found = (Object.keys(CONTRACT_MODE) as PolicyCompletionMode[]).find((m) => CONTRACT_MODE[m] === mode);
  return found ?? (mode as PolicyCompletionMode);
}

/**
 * The 1.6.x checks of a cart against the offer and the request, before any approval is requested (contract 1.6.1
 * §3, offer = cart = snapshot): every 1.6.0 field present, a completion mode the gateway offered, the offer's
 * variant, the origin `https://` + the merchant's domain, lowercased and ASCII only (Appendix G check 1), and (1.6.1)
 * the offer's myshopify_domain: a Shopify store's cart must name the same one, and a cart may not name one the offer
 * did not (Appendix E step 7 then holds the snapshot to it).
 */
function cartV16Problems(cart: Cart, offer: CloudOffer, accepts: readonly CloudCompletionMode[]): string[] {
  const missing = (["completion_mode", "merchant_origin", "variant_ref", "total_estimated"] as const).filter((k) => cart[k] === undefined);
  if (missing.length > 0) return [`cart lacks ${missing.join(", ")}, which a 1.6.x host sends`];
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
  if (offer.myshopify_domain !== undefined && cart.myshopify_domain === undefined) problems.push("myshopify_domain is missing, and the offer names a Shopify store");
  else if (cart.myshopify_domain !== offer.myshopify_domain) problems.push("myshopify_domain differs from the offer");
  return problems;
}

/**
 * The snapshot must be the cart under the hash Intent Cloud gave (Appendix A) and, from a 1.6.1 host, a v3 snapshot
 * that passes Appendix E step 7 against what was sent and received (`sent`, trust's sentProblems): the same check
 * the approval must pass again when it is accepted.
 */
function checkSnapshot(created: ApprovalCreated & { readonly snapshot: SnapshotV3 }, cart: Cart, sent: SentPurchase): string[] {
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
  // The schema admits only v3 from a 1.6.1 host; another version that got past it fails step 7 below (`v`).
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
      if (c.reason === "paused") return `Purchases are paused (\`${INTENT} pause\`): the gateway did not complete this purchase. It goes on only after the developer resumes.`;
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
        : // These refusals say what to do next themselves, and a hand-off would meet the same ceiling or country check.
          `The gateway did not send the purchase to Shop (${c.reason ?? "refused"}): no complete_checkout was sent.${refusalWords(c.reason)}${OWN_NEXT_STEP.has(c.reason ?? "") ? "" : " Create a new cart to hand the purchase off to the merchant's checkout."}`;
  }
}

/** Shop's tool-level error codes (S1) that an indeterminate outcome may carry as its reason, and that are named to the developer. */
const SHOP_ERROR_CODES: ReadonlySet<string> = new Set(["checkout_completion_ineligible", "invalid_checkout_id"]);

/** Refusals of the redemption whose words already name the next step (a hand-off would not get past them). */
const OWN_NEXT_STEP: ReadonlySet<string> = new Set(["redeem_refused", "redeem_refused:ceiling_order", "redeem_refused:ceiling_week", "redeem_refused:currency_unsupported"]);

/**
 * Why nothing ships when the currency table at start is missing or does not check (contract 1.7.1). The table is read
 * only at start, so the fix is a restart (Claude Code restarts intent), or a newer intent.
 */
const NO_TABLE_AT_START = "the answer Intent Cloud returns at start has no currency table intent can check, so no search or purchase can be sent; restart Claude Code later (it restarts intent), or update intent.";
const NO_CURRENCY_TABLE = `Not sent: ${NO_TABLE_AT_START}`;

/**
 * How the developer links a Shop wallet, as a command that works today: Shop does not accept the gateway's own client
 * yet, so the link names Shop's public client for a shopper's own agent (the wallet keeps it). Linking waits for the
 * developer in Shop, and the gateway reads the wallet when it starts.
 */
const LINK_COMMAND = `INTENT_SHOP_CLIENT_ID=${SHOP_PUBLIC_CLIENT_ID} ${INTENT} wallet link shop`;
const LINK_SHOP = `To link one, the developer runs \`${LINK_COMMAND}\` in a terminal, then restarts Claude Code (it restarts intent).`;

/** What the developer can do about a one-tap refusal the gateway made before paying (complete.ts reasons). */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  budget_unknown: 'Shop shows no budget for this connection: turn on "Allow agent to pay" with a budget in the Shop app.',
  no_budget_instrument: 'Shop offered no agent payments to pay this checkout with, and the gateway never pays with the card: turn on "Allow agent to pay" with a budget in the Shop app.',
  wallet_disconnected: `Shop answered that this connection can no longer read the account (as when it is removed in the Shop app): the developer runs \`${INTENT} wallet unlink shop\`, then \`${LINK_COMMAND}\`, in a terminal.`,
  create_unconfirmed: "Shop gave no usable answer to the checkout request, and the gateway never sends it twice.",
  // A refusal of the completing report that names no code the gateway knows.
  redeem_refused: "Intent Cloud returns a refusal for this purchase before it was paid, so nothing was bought. Ask the agent to search again for a new purchase.",
};

/**
 * Intent Cloud's refusal codes (contract 1.7.0, Appendix A "Refusals" and Appendix H), each as one clear line: what
 * Intent Cloud answered and what the developer or the buyer can do. Nothing was bought in any of them.
 */
export const REFUSAL_CODE_WORDS: Readonly<Record<RefusalCode, string>> = {
  one_tap_off: "Intent Cloud answered that one tap is off for this account, so it refused a purchase paid by the gateway's wallet. Nothing was bought.",
  currency_unsupported:
    "Intent Cloud answered that it does not take orders in this checkout's currency for its ship-to country (the countries it ships to may have changed since the search). Nothing was bought. Search again.",
  store_blocked: "Intent Cloud answered that this store is on its block list. Nothing was bought; choose another store.",
  category_excluded: "Intent Cloud answered that this item is in a category it excludes (health and medical, age-restricted, financial or digital goods). Nothing was bought.",
  ceiling_order: "Intent Cloud answered that this order is above its per-order ceiling for the currency. Nothing was bought. Pick a cheaper offer or a smaller quantity.",
  ceiling_week: "Intent Cloud answered that this order would pass the buyer's weekly ceiling for the currency. Nothing was bought. Try a cheaper offer, or wait until a week has passed since your earlier orders.",
  // Contract 1.7.0 final: there is no unpin; the developer's recovery is a new account key. `intent init` never replaces
  // a key (ADR-0022), so the key file is moved away first.
  account_key_other_buyer:
    `Intent Cloud answered that this gateway's account key is pinned to another buyer (the first buyer who approved with it), and Intent Cloud has no unpin. Nothing was bought. To recover, make a new account key: move account-key.json out of the gateway's data directory, then run \`${INTENT} init\`, which makes a new one.`,
  paused: "Intent Cloud answered that the buyer paused purchases for this account key; the buyer resumes with their passkey on the confirm page. Nothing was bought.",
};

function refusalWords(reason: string | undefined): string {
  const code = reason?.startsWith("redeem_refused:") === true ? reason.slice("redeem_refused:".length) : undefined;
  if (code !== undefined && code in REFUSAL_CODE_WORDS) return ` ${REFUSAL_CODE_WORDS[code as RefusalCode]}`;
  if (reason?.startsWith("store_pair:") === true) {
    return " The merchant's storefront (its /meta.json) did not confirm the Shopify store in the approved snapshot, so the gateway paid nothing.";
  }
  const words = reason === undefined ? undefined : REFUSAL_WORDS[reason];
  return words === undefined ? "" : ` ${words}`;
}

/** An age for a sentence: "2 minutes", "3 hours", "1 day"; under a minute is "less than a minute". */
function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "less than a minute";
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}

/** A Retry-After for a sentence: seconds under a minute, else whole minutes, rounded up so the wait is long enough. */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.ceil(seconds / 60);
  return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
}

function approveLabel(totalMinor: unknown, currency: unknown = "USD"): string {
  if (typeof totalMinor !== "number" || !Number.isSafeInteger(totalMinor) || totalMinor < 0) return "Approve with demo passkey";
  return `Approve ${formatMinor(totalMinor, typeof currency === "string" ? currency : "USD")} with demo passkey`;
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

/** Puts `value` last in an insertion-ordered map and drops the oldest past MAX_REMEMBERED_OFFERS. */
function keep<T>(map: Map<string, T>, handle: string, value: T): void {
  map.delete(handle);
  map.set(handle, value);
  while (map.size > MAX_REMEMBERED_OFFERS) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/** What the agent sees of a searched offer: no provider, myshopify pairing or variant id. */
function shopOfferView(handle: string, offer: SearchOffer): ShopOfferView {
  const storefront = offer.storefrontOrigin === null ? null : new URL(offer.storefrontOrigin).host;
  return {
    offer_handle: handle,
    title: offer.title === "" ? "(untitled)" : offer.title,
    variant: offer.variantTitle === "" ? "Default" : offer.variantTitle,
    store: storefront ?? offer.storeDomain,
    price: { amount_minor: offer.price.amountMinor, currency: offer.price.currency },
    availability: "in_stock",
    ...(offer.imageUrl === null ? {} : { image_url: offer.imageUrl }),
    ...(offer.productUrl === null ? {} : { product_url: offer.productUrl }),
  };
}

/**
 * Why a Shop checkout read back cannot be submitted, or null (contract 1.7.0, G6 and G7). Each rule is local, so a
 * refusal sends nothing to Intent Cloud. `rule` goes into the block entry (no value), `words` to the agent.
 */
function shopCheckoutProblem(
  checkout: WalletCheckout,
  created: WalletCheckout,
  offer: SearchOffer,
  quantity: number,
  searched: { readonly shipTo: ShipTo; readonly currency: string },
  table: CurrencyTable,
): { rule: string; words: string } | null {
  // The checkout read back is the one created, at the store the offer named: the store a checkout actually lives at is
  // what the passkey will sign (as binding check 1 holds a shop_agent purchase to it), never a storefront Shop paired.
  if (checkout.checkoutRef !== created.checkoutRef) return { rule: "checkout: another checkout", words: "Shop read back another checkout than it created" };
  if (checkout.storeDomain !== offer.storeDomain) return { rule: "checkout: another store", words: "Shop's checkout lives at another store than the offer's" };
  if (checkout.status !== "open" && checkout.status !== "buyer_review") return { rule: `checkout: ${checkout.status}`, words: `Shop's checkout is ${checkout.status.replace("_", " ")}, not open` };
  const line = checkout.lines[0];
  if (checkout.lines.length !== 1 || line?.variantRef !== offer.variantRef || line.quantity !== quantity) {
    return { rule: "checkout: lines", words: "Shop's checkout does not hold exactly the offered item and quantity" };
  }
  const total = checkout.total;
  if (total === null) return { rule: "checkout: no total", words: "Shop's checkout shows no total" };
  // G7: a currency Intent Cloud's table does not list is refused here, naming the table version it was checked against.
  if (table.currencies[total.currency] === undefined) {
    return { rule: `currency_unsupported: ${total.currency} (${table.version})`, words: `Shop's checkout is in ${total.currency}, a currency intent cannot take orders in now` };
  }
  // The policy's limits were put in the search's currency, and an amount is never converted.
  if (total.currency !== searched.currency) {
    return { rule: `currency: ${total.currency}`, words: `Shop's checkout is in ${total.currency}, but orders shipping to ${shipCountry(searched.shipTo.country)?.name ?? searched.shipTo.country} must be in ${searched.currency}` };
  }
  const totals = checkout.totals ?? null;
  if (totals === null || !totalsAddUp(totals) || totals.total !== total.amountMinor) {
    return { rule: "checkout: totals", words: "Shop's checkout totals do not add up to its total (a discount or a fee the gateway does not submit)" };
  }
  const area = checkout.shipToArea ?? null;
  if (area === null || area.postalCodeCoarse === null || !(COARSE_COUNTRIES as readonly string[]).includes(area.country)) {
    return { rule: "checkout: ship_to", words: `Shop's checkout ships to no single destination in ${namesText(COARSE_COUNTRIES)}` };
  }
  // Only the country and the coarse postcode leave the gateway; both must be the ones the user gave for the search.
  const { shipTo } = searched;
  if (area.country !== shipTo.country || area.postalCodeCoarse !== shipTo.coarse) {
    return {
      rule: "checkout: ship_to differs",
      words: "Shop's saved address ships to another country or postcode area than the one given for the search; set the preferred address in the Shop app, or search with its postcode",
    };
  }
  // 1.7.1: a checkout must be in its ship-to country's currency (the table's `countries`), or Intent Cloud refuses it.
  if (table.countries?.[area.country] !== total.currency) {
    const place = shipCountry(area.country)?.name ?? area.country;
    const due = table.countries?.[area.country];
    return {
      rule: `currency_unsupported: ${total.currency} (${table.version})`,
      words: due === undefined ? `Shop's checkout ships to ${place}, where intent does not ship now` : `Shop's checkout is in ${total.currency}, but orders shipping to ${place} must be in ${due}`,
    };
  }
  return null;
}

/** Whether a later `approval_pending` submitted the same Shop checkout in the same mode (1.7.0 supersession). */
function supersededIn(chain: readonly Entry[], pending: Entry): boolean {
  const mine = readSentCheckout(bodyOf(pending).sent);
  if (mine === null) return false;
  const key = (s: NonNullable<typeof mine>): string => `${s.checkout_request.checkout.checkout_ref_hash} ${s.checkout_request.completion_mode}`;
  return chain.some((e) => {
    if (e.kind !== "approval_pending" || e.seq <= pending.seq || bodyOf(e).handle === bodyOf(pending).handle) return false;
    const other = readSentCheckout(bodyOf(e).sent);
    return other !== null && key(other) === key(mine);
  });
}

/** The store name the snapshot carries: the storefront host, else the myshopify domain (what the agent was shown). */
function storeNameOf(offer: SearchOffer): string {
  const host = offer.storefrontOrigin === null ? null : new URL(offer.storefrontOrigin).host;
  return (host ?? offer.storeDomain).slice(0, 80);
}

/** An amount for a sentence: `$12.34` in USD, `CAD 12.34` otherwise. */
function formatMinor(minor: number, currency: string): string {
  const text = `${Math.floor(minor / 100).toLocaleString("en-US")}.${String(minor % 100).padStart(2, "0")}`;
  return currency === "USD" ? `$${text}` : `${currency} ${text}`;
}

/** A failed Shop checkout create or read, in the gateway's words: never Shop's own message, which can carry identity. */
function checkoutFailureMessage(error: unknown): string {
  if (error instanceof DisclosureBlockedError) return "Not sent: the checkout request looked like buyer identity.";
  if (error instanceof DisclosureRefusedError) return `Not sent: ${error.reasons.join("; ")}.`;
  if (error instanceof DisclosureStoppedError) return `Not sent: ${error.message}. The developer must restart the gateway.`;
  if (error instanceof AddressFieldsRequiredError) return "Not sent: Shop asked for the buyer's address fields, which the gateway never sends. Set a preferred address in the Shop app.";
  if (error instanceof CheckoutUnconfirmedError) return "Shop gave no usable answer to the checkout request; the gateway does not send it again. Nothing was submitted for approval.";
  if (error instanceof WalletRailError) return `Shop could not prepare the checkout: ${error.label}.`;
  if (error instanceof Error && error.name === "ShopTransportError") return `Shop could not be reached for the checkout: ${error.message}.`;
  throw error;
}

function providerFailure(error: unknown): "blocked" | "error" {
  return error instanceof DisclosureBlockedError || error instanceof DisclosureRefusedError ? "blocked" : "error";
}

/** A failed provider search in the gateway's words: never the provider's own message, which can carry identity. */
function searchFailureMessage(error: unknown): string {
  if (error instanceof DisclosureBlockedError) return "Not sent: the search looked like buyer identity.";
  if (error instanceof DisclosureRefusedError) return `Not sent: ${error.reasons.join("; ")}.`;
  if (error instanceof DisclosureStoppedError) return `Not sent: ${error.message}. The developer must restart the gateway.`;
  if (error instanceof WalletRailError) return `Shop could not search: ${error.label}.`;
  // ShopTransportError's message names the host and a failure in plain words, no content.
  if (error instanceof Error && error.name === "ShopTransportError") return `Shop could not be reached for the search: ${error.message}.`;
  throw error;
}
