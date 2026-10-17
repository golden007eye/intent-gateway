// zod schemas for every `components.schemas` entry of contract/gateway-api.v1.yaml (Intent Cloud public contract
// 1.6.0), one export per spec name, each with its inferred type under the same name.
//
// Strictness follows the spec exactly: every object in 1.6.0 says `additionalProperties: false`, so every object here
// is a z.strictObject and rejects unknown keys. That includes the `x-provisional` schemas (RateLimited, GatewayLimits,
// DeliveryEstimate, Rating, ReturnsPolicy) and the provisional `Meta.enrol_origin`: "provisional" means a later minor
// version may change them, not that 1.6.0 allows extra keys. A changed provisional item arrives with a new vendored
// contract, and the parity test then fails until this file follows it.
//
// The 1.6.0 fields of Offer, CartRequest, Cart and ApprovalStatus are optional here because the spec, which describes
// both served versions, makes them optional. The gateway requires them where it relies on them, and refuses a v1
// snapshot from a 1.6 host (src/gateway).
//
// Integers use z.int(), which also caps them at ±(2^53−1): the JCS integer profile (Appendix A) rejects anything wider.
// Patterns are copied from the spec verbatim; schemas.test.ts compares this file with the spec keyword by keyword.
import { z } from "zod";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ---- Shared scalars -------------------------------------------------------------------------------------------

/** RFC 3339 UTC with seconds and `Z`. */
export const Timestamp = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
export type Timestamp = z.infer<typeof Timestamp>;

export const OfferHandle = z.string().regex(/^of_[A-Za-z0-9_-]{4,64}$/);
export type OfferHandle = z.infer<typeof OfferHandle>;

export const CartHandle = z.string().regex(/^ct_[A-Za-z0-9_-]{4,64}$/);
export type CartHandle = z.infer<typeof CartHandle>;

export const ApprovalHandle = z.string().regex(/^ap_[A-Za-z0-9_-]{4,64}$/);
export type ApprovalHandle = z.infer<typeof ApprovalHandle>;

/** Optional product image, https. Display only; not in the snapshot. */
export const ImageUrl = z
  .string()
  .max(512)
  .regex(/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~/-]*$/);
export type ImageUrl = z.infer<typeof ImageUrl>;

/** sha256 (64 lowercase hex) of the contract's `SHA256SUMS` file. */
export const ContractSums = z.string().regex(/^[0-9a-f]{64}$/);
export type ContractSums = z.infer<typeof ContractSums>;

/** Base64url without padding. */
export const Base64Url = z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/);
export type Base64Url = z.infer<typeof Base64Url>;

/** An Ed25519 signature (64 bytes), base64url without padding. */
export const Ed25519Signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
export type Ed25519Signature = z.infer<typeof Ed25519Signature>;

/** A session keyid: `gw-` + base64url (no padding) of the raw 32-byte Ed25519 public key (Appendix C). */
export const GatewayKeyId = z.string().regex(/^gw-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export type GatewayKeyId = z.infer<typeof GatewayKeyId>;

export const TotalKind = z.enum(["exact", "max"]);
export type TotalKind = z.infer<typeof TotalKind>;

/** How payment happens after the passkey approval (1.6.0, Appendix A v2). */
export const CompletionMode = z.enum(["handoff", "shop_agent"]);
export type CompletionMode = z.infer<typeof CompletionMode>;

/** `https://` + merchant.domain, lowercased: ASCII, no port, no path (1.6.0). */
export const MerchantOrigin = z.string().regex(/^https:\/\/[a-z0-9.-]{1,253}$/);
export type MerchantOrigin = z.infer<typeof MerchantOrigin>;

/** The merchant's variant reference, such as `gid://shopify/ProductVariant/<n>` (1.6.0). */
export const VariantRef = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:/._-]+$/);
export type VariantRef = z.infer<typeof VariantRef>;

export const ApprovalState = z.enum(["pending", "approved", "rejected", "expired", "handed_off", "ordered"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

// ---- Errors ---------------------------------------------------------------------------------------------------

/** The body of every 4xx except 429 (spec name `Error`, renamed so it does not shadow the global). */
export const ErrorBody = z.strictObject({
  error: z.enum(["bad_request", "digest_mismatch", "unauthorized", "forbidden", "not_found", "conflict", "gone", "too_large"]),
  message: z.string().max(200),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** The body of a 429. Provisional, still strict (see the header). */
export const RateLimited = z.strictObject({
  error: z.literal("rate_limited"),
  message: z.string().max(200),
  limit: z.enum(["requests", "carts", "approvals", "enrolments"]),
  retry_after_seconds: z.int().min(1),
});
export type RateLimited = z.infer<typeof RateLimited>;

// ---- Value objects --------------------------------------------------------------------------------------------

/** Integer minor units, USD only. */
export const Money = z.strictObject({
  amount_minor: z.int().min(0).max(MAX_SAFE),
  currency: z.literal("USD"),
});
export type Money = z.infer<typeof Money>;

/** A US destination; a non-US one is refused by the schema. */
export const ShipTo = z.strictObject({
  country: z.literal("US"),
  postal_code: z.string().regex(/^[0-9]{5}$/),
});
export type ShipTo = z.infer<typeof ShipTo>;

export const ShipToArea = z.strictObject({
  country: z.literal("US"),
  postal_prefix: z.string().regex(/^[0-9]{3}$/),
});
export type ShipToArea = z.infer<typeof ShipToArea>;

export const Merchant = z.strictObject({
  name: z.string().min(1).max(80),
  domain: z.string().min(1).max(253),
});
export type Merchant = z.infer<typeof Merchant>;

export const Item = z.strictObject({
  title: z.string().min(1).max(120),
  variant: z.string().min(1).max(80),
});
export type Item = z.infer<typeof Item>;

// ---- Meta and keys --------------------------------------------------------------------------------------------

/** Limits that apply to gateway sessions, for display; Intent Cloud enforces them. Provisional, still strict. */
export const GatewayLimits = z.strictObject({
  requests_per_minute: z.int().min(1),
  carts_per_hour: z.int().min(1),
  carts_per_hour_passkey: z.int().min(1),
  approvals_per_day: z.int().min(1),
});
export type GatewayLimits = z.infer<typeof GatewayLimits>;

/** `GET /v1/meta`. `limits` and `enrol_origin` are optional (and provisional); unknown keys are rejected. */
export const Meta = z.strictObject({
  contract_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  contract_sums_sha256: ContractSums,
  rule_versions: z.array(z.string().min(1)).min(1),
  limits: GatewayLimits.optional(),
  enrol_origin: z
    .string()
    .regex(/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/)
    .optional(),
});
export type Meta = z.infer<typeof Meta>;

export const Jwk = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  kid: z.string().min(1),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  use: z.literal("sig").optional(),
  alg: z.literal("EdDSA").optional(),
});
export type Jwk = z.infer<typeof Jwk>;

/** `GET /v1/signature-keys`: informational; the gateway trusts only keys a verified KeyStatement lists. */
export const Jwks = z.strictObject({ keys: z.array(Jwk) });
export type Jwks = z.infer<typeof Jwks>;

/** A receipt or approval key; its use is the kid's prefix. */
export const StatementKey = z.strictObject({
  kid: z.string().regex(/^cloud-(receipt|approval)-[0-9]{6}$/),
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type StatementKey = z.infer<typeof StatementKey>;

/**
 * The root-signed key statement (Appendix F), `GET /v1/key-statement`. The schema only; the lifetime, per-use key
 * counts, unique kids and the signature are checked by the trust module (Appendix F, verification).
 */
export const KeyStatement = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(/^cloud-root-[0-9]{1,4}$/),
  keys: z.array(StatementKey).min(2).max(4),
  confirm_origin: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/),
  rp_id: z.string().regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/),
  issued_at: Timestamp,
  expires_at: Timestamp,
  signature: Ed25519Signature,
});
export type KeyStatement = z.infer<typeof KeyStatement>;

// ---- Catalog --------------------------------------------------------------------------------------------------

export const SearchRequest = z.strictObject({
  category: z.string().min(1).max(60).optional(),
  product: z.string().min(1).max(200).optional(),
  must_haves: z.array(z.string().min(1).max(60)).max(8).optional(),
  budget_max: Money.optional(),
  ship_to: ShipTo,
});
export type SearchRequest = z.infer<typeof SearchRequest>;

/** Delivery window in calendar days. Provisional, still strict. */
export const DeliveryEstimate = z.strictObject({
  min_days: z.int().min(0).max(90),
  max_days: z.int().min(0).max(90),
});
export type DeliveryEstimate = z.infer<typeof DeliveryEstimate>;

/** Average stars × 10 and the review count. Provisional, still strict. */
export const Rating = z.strictObject({
  stars_x10: z.int().min(10).max(50),
  count: z.int().min(1).max(100000000),
});
export type Rating = z.infer<typeof Rating>;

/** Returns accepted within `days`; `free` means no return shipping. Provisional, still strict. */
export const ReturnsPolicy = z.strictObject({
  free: z.boolean(),
  days: z.int().min(1).max(365),
});
export type ReturnsPolicy = z.infer<typeof ReturnsPolicy>;

export const Offer = z.strictObject({
  offer_handle: OfferHandle,
  merchant: Merchant,
  title: z.string().min(1).max(120),
  variant: z.string().min(1).max(80),
  price: Money,
  shipping: Money,
  total_kind: TotalKind,
  availability: z.enum(["in_stock", "low_stock"]),
  image_url: ImageUrl.optional(),
  delivery: DeliveryEstimate.optional(),
  rating: Rating.optional(),
  returns: ReturnsPolicy.optional(),
  variant_ref: VariantRef.optional(),
});
export type Offer = z.infer<typeof Offer>;

export const SearchResponse = z.strictObject({ offers: z.array(Offer).max(20) });
export type SearchResponse = z.infer<typeof SearchResponse>;

// ---- Carts and approvals --------------------------------------------------------------------------------------

/** Usable completion modes in preference order (1.6.0): 1 or 2 distinct values. Absent means [handoff]. */
const CompletionAccepts = z
  .array(CompletionMode)
  .min(1)
  .max(2)
  .refine((modes) => new Set(modes).size === modes.length, "completion_accepts holds a mode twice")
  .meta({ uniqueItems: true });

export const CartRequest = z.strictObject({
  offer_handle: OfferHandle,
  quantity: z.int().min(1).max(3),
  ship_to: ShipTo,
  /** The per-approval completer key (1.6.0); a 1.6 gateway always sends it. */
  completer_keyid: GatewayKeyId.optional(),
  completion_accepts: CompletionAccepts.optional(),
});
export type CartRequest = z.infer<typeof CartRequest>;

export const Cart = z.strictObject({
  cart_handle: CartHandle,
  merchant: Merchant,
  item: Item,
  quantity: z.int().min(1).max(3),
  unit_price: Money,
  shipping: Money,
  total: Money,
  total_kind: TotalKind,
  expires_at: Timestamp,
  image_url: ImageUrl.optional(),
  completion_mode: CompletionMode.optional(),
  merchant_origin: MerchantOrigin.optional(),
  variant_ref: VariantRef.optional(),
  total_estimated: z.boolean().optional(),
});
export type Cart =z.infer<typeof Cart>;

/** The purchase snapshot S (Appendix A): exactly these fields. */
export const Snapshot = z.strictObject({
  v: z.literal(1),
  approval: z.string().min(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
  merchant: Merchant,
  item: Item,
  quantity: z.int().min(1).max(3),
  unit_price: Money,
  shipping: Money,
  total: Money,
  total_kind: TotalKind,
  ship_to: ShipToArea,
  continue_url_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  rule_version: z.string().min(1),
  expires_at: Timestamp,
});
export type Snapshot = z.infer<typeof Snapshot>;

/**
 * The purchase snapshot v2 (Appendix A "Snapshot v2", 1.6.0): every v1 fact with the 5-digit ZIP instead of the
 * 3-digit prefix, plus the merchant origin, variant, checkout hash, completion mode, completer key and estimated flag.
 */
export const SnapshotV2 = z.strictObject({
  v: z.literal(2),
  approval: z.string().min(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
  merchant: Merchant,
  item: Item,
  quantity: z.int().min(1).max(3),
  unit_price: Money,
  shipping: Money,
  total: Money,
  total_kind: TotalKind,
  ship_to: ShipTo,
  continue_url_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  rule_version: z.string().min(1),
  expires_at: Timestamp,
  merchant_origin: MerchantOrigin,
  variant_ref: VariantRef,
  checkout_ref_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  completion_mode: CompletionMode,
  completer_keyid: GatewayKeyId,
  total_estimated: z.boolean(),
});
export type SnapshotV2 = z.infer<typeof SnapshotV2>;

/** The spec's `oneOf` of the two snapshot versions; they differ in `v`, so exactly one can match. */
export const AnySnapshot = z.discriminatedUnion("v", [Snapshot, SnapshotV2]);
export type AnySnapshot = z.infer<typeof AnySnapshot>;

/** `POST /v1/carts/{cart_handle}/approvals` 201. */
export const ApprovalCreated = z.strictObject({
  approval_handle: ApprovalHandle,
  approval_link_path: z.string().regex(/^\/c\/[A-Za-z0-9_-]{16,64}$/),
  snapshot: AnySnapshot,
  snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
  check_code: z.string().regex(/^[0-9a-f]{8}$/),
  state: ApprovalState,
  expires_at: Timestamp,
});
export type ApprovalCreated = z.infer<typeof ApprovalCreated>;

export const ApprovalDisplay = z.strictObject({
  merchant: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  total: Money,
  image_url: ImageUrl.optional(),
});
export type ApprovalDisplay = z.infer<typeof ApprovalDisplay>;

/** The WebAuthn assertion as the authenticator returned it, base64url without padding. No user handle. */
export const WebAuthnAssertion = z.strictObject({
  credential_id: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/),
  authenticator_data: Base64Url,
  client_data_json: Base64Url,
  signature: Base64Url,
});
export type WebAuthnAssertion = z.infer<typeof WebAuthnAssertion>;

export const Es256Jwk = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  alg: z.literal("ES256"),
});
export type Es256Jwk = z.infer<typeof Es256Jwk>;

export const Rs256Jwk = z.strictObject({
  kty: z.literal("RSA"),
  n: z.string().regex(/^[A-Za-z0-9_-]{342,683}$/),
  e: z.string().regex(/^[A-Za-z0-9_-]{1,8}$/),
  alg: z.literal("RS256"),
});
export type Rs256Jwk = z.infer<typeof Rs256Jwk>;

/** The spec's `oneOf`; the two branches differ in `kty`, so exactly one can match. */
export const CredentialPublicKey = z.discriminatedUnion("kty", [Es256Jwk, Rs256Jwk]);
export type CredentialPublicKey = z.infer<typeof CredentialPublicKey>;

/** An entry in Intent Cloud's approval ledger (Appendix B), named by `seq` and `entry_hash`. */
export const LedgerRef = z.strictObject({
  seq: z.int().min(1).max(MAX_SAFE),
  entry_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type LedgerRef = z.infer<typeof LedgerRef>;

/** The approval proof P (Appendix E). Schema only; the trust module does the six verification steps. */
export const ApprovalProof = z.strictObject({
  v: z.literal(1),
  approval_handle: ApprovalHandle,
  snapshot: AnySnapshot,
  snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
  assertion: WebAuthnAssertion,
  credential_public_key: CredentialPublicKey,
  ledger: LedgerRef,
  issued_at: Timestamp,
  kid: z.string().regex(/^cloud-approval-[0-9]{6}$/),
  cloud_signature: Ed25519Signature,
});
export type ApprovalProof = z.infer<typeof ApprovalProof>;

// ---- Outcomes (1.6.0, Appendix G) ----------------------------------------------------------------------------

/** The merchant's order reference. Never an email or a name. */
export const OrderRef = z.string().regex(/^[A-Za-z0-9#-]{1,64}$/);
export type OrderRef = z.infer<typeof OrderRef>;

export const OutcomeState = z.enum(["handed_off", "completing", "ordered", "mismatch", "failed", "checkout_expired", "indeterminate", "reported"]);
export type OutcomeState = z.infer<typeof OutcomeState>;

export const OutcomeSource = z.enum(["shop_api", "gateway_precheck", "merchant_api", "signed_webhook", "staging_webhook", "checkout_page", "gateway_report"]);
export type OutcomeSource = z.infer<typeof OutcomeSource>;

export const BindingCheck = z.enum(["match", "differs", "unknown"]);
export type BindingCheck = z.infer<typeof BindingCheck>;

/** binding-v1: five checks of an observed order against the approved snapshot. No observed value is copied in. */
export const Binding = z.strictObject({
  rule_version: z.literal("binding-v1"),
  result: z.enum(["ok", "mismatch", "incomplete"]),
  checks: z.strictObject({
    merchant_origin: BindingCheck,
    checkout_ref: BindingCheck,
    line: BindingCheck,
    ship_to: BindingCheck,
    total: BindingCheck,
  }),
});
export type Binding = z.infer<typeof Binding>;

/** What a gateway reported and Intent Cloud could not verify (Appendix G R5). */
export const OutcomeReported = z.strictObject({
  state: z.enum(["ordered", "mismatch", "failed"]),
  source: OutcomeSource,
  order_ref: OrderRef.optional(),
  final_total: Money.optional(),
  binding: Binding.optional(),
});
export type OutcomeReported = z.infer<typeof OutcomeReported>;

/** What happened after the approval. Schema only; rule O1 is the reader's to enforce. */
export const Outcome = z.strictObject({
  state: OutcomeState,
  source: OutcomeSource,
  assurance: z.enum(["verified", "reported"]),
  order_ref: OrderRef.optional(),
  final_total: Money.optional(),
  binding: Binding.optional(),
  observed_at: Timestamp,
  reported: OutcomeReported.optional(),
});
export type Outcome = z.infer<typeof Outcome>;

/** Intent Cloud's signed statement of an outcome. Schema only; its signature is the trust module's to check. */
export const OutcomeStatement = z.strictObject({
  v: z.literal(1),
  approval_handle: ApprovalHandle,
  snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: Outcome,
  ledger: LedgerRef,
  issued_at: Timestamp,
  kid: z.string().regex(/^cloud-approval-[0-9]{6}$/),
  cloud_signature: Ed25519Signature,
});
export type OutcomeStatement = z.infer<typeof OutcomeStatement>;

/**
 * `POST /v1/approvals/{approval_handle}/outcome-reports`. Appendix G's prose adds that `checkout_ref` is required for
 * `completing`, and `order_ref`, `final_total` and `binding` for `ordered` and `mismatch`.
 */
export const OutcomeReport = z.strictObject({
  report_id: z.string().regex(/^or_[A-Za-z0-9_-]{16,32}$/),
  state: z.enum(["completing", "ordered", "mismatch", "failed", "indeterminate"]),
  source: z.enum(["shop_api", "gateway_precheck"]),
  checkout_ref: z.string().min(1).max(128).optional(),
  order_ref: OrderRef.optional(),
  final_total: Money.optional(),
  binding: Binding.optional(),
  observed_at: Timestamp,
});
export type OutcomeReport = z.infer<typeof OutcomeReport>;

export const OutcomeReportAccepted = z.strictObject({
  accepted: z.literal(true),
  outcome: Outcome,
});
export type OutcomeReportAccepted = z.infer<typeof OutcomeReportAccepted>;

/**
 * `GET /v1/approvals/{approval_handle}`. `proof` is optional in the schema, as in the spec; the spec's prose (present
 * once `approved`, `handed_off` or `ordered`) is a rule for the gateway use case to enforce, not a schema constraint.
 * `outcome` and `outcome_statement` are 1.6.0 (Appendix G).
 */
export const ApprovalStatus = z.strictObject({
  state: ApprovalState,
  display: ApprovalDisplay,
  order_number: z.string().min(1).max(40).optional(),
  proof: ApprovalProof.optional(),
  outcome: Outcome.optional(),
  outcome_statement: OutcomeStatement.optional(),
});
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

// ---- Receipts -------------------------------------------------------------------------------------------------

/**
 * The request as the edge received it (Appendix D). `keyid`, `nonce` and `created` are present together or not at
 * all; the spec states that in prose, and the refinement enforces it (it does not change the JSON Schema form).
 */
export const ReceiptRequest = z
  .strictObject({
    method: z.string().regex(/^[A-Z]{1,16}$/),
    path: z
      .string()
      .max(2048)
      .regex(/^\/[^?#\s]*$/),
    content_digest: z.string().regex(/^sha-256=:[A-Za-z0-9+/]{43}=:$/),
    keyid: GatewayKeyId.optional(),
    nonce: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9+/_=-]+$/)
      .optional(),
    created: z.int().min(0).max(999999999999).optional(),
  })
  .refine((r) => [r.keyid, r.nonce, r.created].every((v) => v === undefined) || [r.keyid, r.nonce, r.created].every((v) => v !== undefined), {
    message: "keyid, nonce and created are present together or not at all",
  });
export type ReceiptRequest = z.infer<typeof ReceiptRequest>;

/** The receipt R (Appendix D): what Intent Cloud's edge received. */
export const Receipt = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(/^cloud-receipt-[0-9]{6}$/),
  request: ReceiptRequest,
  status: z.int().min(100).max(599),
  received_at: Timestamp,
});
export type Receipt = z.infer<typeof Receipt>;

// ---- Registry -------------------------------------------------------------------------------------------------

/** Every schema above under its spec name in `components.schemas`; the parity test walks the spec against this. */
export const SCHEMAS = {
  Error: ErrorBody,
  RateLimited,
  Money,
  ShipTo,
  ShipToArea,
  Merchant,
  Item,
  TotalKind,
  ApprovalState,
  Timestamp,
  OfferHandle,
  CartHandle,
  ApprovalHandle,
  ImageUrl,
  ContractSums,
  Meta,
  GatewayLimits,
  Jwk,
  Jwks,
  SearchRequest,
  Offer,
  DeliveryEstimate,
  Rating,
  ReturnsPolicy,
  SearchResponse,
  CartRequest,
  Cart,
  Snapshot,
  SnapshotV2,
  CompletionMode,
  MerchantOrigin,
  VariantRef,
  OrderRef,
  OutcomeState,
  OutcomeSource,
  BindingCheck,
  Binding,
  OutcomeReported,
  Outcome,
  OutcomeStatement,
  OutcomeReport,
  OutcomeReportAccepted,
  ApprovalCreated,
  ApprovalDisplay,
  ApprovalStatus,
  Base64Url,
  Ed25519Signature,
  GatewayKeyId,
  Receipt,
  ReceiptRequest,
  ApprovalProof,
  WebAuthnAssertion,
  CredentialPublicKey,
  Es256Jwk,
  Rs256Jwk,
  LedgerRef,
  KeyStatement,
  StatementKey,
} as const satisfies Record<string, z.ZodType>;
