# Appendix G: Outcomes (normative)

Contract version 1.6.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/o1-binding.json`, `vectors/o2-outcome-statement.json`, `vectors/o3-status-state.json`.

## Purpose
What happened after an approval, stated only from evidence the stating service checked itself. Intent Cloud compares every observed order with the snapshot the passkey signed (binding-v1), states the outcome with its source and assurance, and signs that statement with its approval key. Served to callers that send `Intent-Contract-Version: 1.6.0`.

## Outcome states
| `outcome.state` | Mode | Meaning | Terminal |
|---|---|---|---|
| `handed_off` | handoff | The buyer was sent to the merchant checkout; the honest end when no order signal arrives | no |
| `completing` | shop_agent | The completer chained its redemption and told Intent Cloud | no |
| `ordered` | both | A verified order with `binding.result = ok` | yes |
| `mismatch` | both | A verified order with `binding.result = mismatch` | yes |
| `failed` | shop_agent | No order: the completer refused before sending `complete_checkout` (source `gateway_precheck`), or read Shop's terminal not-completed status (source `shop_api`) | yes |
| `checkout_expired` | handoff | The merchant checkout expired, as read from `get_checkout` or the merchant API | yes |
| `indeterminate` | shop_agent | `complete_checkout` was sent and its result is not yet known | no |
| `reported` | both | Someone told the service of an order it could not verify (a gateway report at Intent Cloud; an unsigned checkout-page event) | no |

- **O1.** `state = ordered` implies `assurance = verified` and `binding.result = ok`. Intent Cloud enforces O1 when it writes an outcome; a gateway enforces it when it reads one.
- **O2.** Each service states assurance from what it verified itself. Intent Cloud stores a gateway's report as `reported`. A gateway records Intent Cloud's `ordered` as Intent Cloud's report, beside its own binding result.

## Sources and assurance
| `source` | Read by | Assurance at the reader | Carries a ship-to (`ship_to_optional`) |
|---|---|---|---|
| `shop_api` | the gateway, over TLS from Shop ("read from Shop") | `verified` | **PENDING S1** |
| `gateway_precheck` | the gateway, its own refusal before `complete_checkout` | `verified` (the gateway knows it did not send) | n/a (`failed` only) |
| `merchant_api` | Intent Cloud, UCP `get_checkout` or `get_order` | `verified` | **PENDING S2** |
| `signed_webhook` | Intent Cloud, an RFC 9421-signed UCP order webhook | `verified` | yes (`false`) |
| `staging_webhook` | Intent Cloud, a Shopify HMAC webhook from Intent Cloud's own store | `verified` | yes (`false`) |
| `checkout_page` | Intent Cloud, an unsigned event | `reported` at most | n/a |
| `gateway_report` | Intent Cloud, a report from a gateway | `reported` | n/a |

A source's assurance column is a cap: an outcome from `checkout_page` or `gateway_report` is `reported` at most, so O1 never lets it be `ordered`; `gateway_precheck` gives `failed` only.

The two **PENDING** cells are filled from live tests (S1 for Shop, S2 for the merchant API) before this table is final. If a test is not answered by the fallback date Intent Cloud sets, that cell is published as `ship_to_optional = false`: an outcome from that source without a ZIP is then `incomplete`, never `ordered`. Strict is the safe side; a later 1.6.x may relax it, with a new frozen tree.

## Binding check `binding-v1`
**Inputs**
- the approved snapshot `S` (v2, Appendix A);
- an observed order `O = {merchant_origin?, checkout_ref?, lines: [{variant_ref, quantity}], ship_to_postal_code?, final_total: Money}`;
- a context `M = {mode, recorded_checkout_ref?, ship_to_optional}`, where `ship_to_optional` comes from the sources table. A `mode` other than `handoff` or `shop_agent` is an error, not a check result.

Every reference (`merchant_origin`, `checkout_ref`, `recorded_checkout_ref`, `variant_ref`, `ship_to_postal_code`) is a JSON string and every amount a JSON integer: a value of another type is `differs`, never converted.

**Checks.** Each yields `match`, `differs` or `unknown`.
1. **merchant_origin** (`handoff`).
   - Both sides must be ASCII. A non-ASCII value on either side is `differs` (IDNA2003 and UTS-46 implementations would otherwise disagree).
   - Each side, compared case-insensitively, must be exactly `"https://" host ["."] [":443"]`: the host is one or more labels joined by `.`, each label 1 to 63 of `a-z`, `0-9` and `-`, not starting or ending with `-`; no empty label; the host at most 253 characters. At most one trailing dot and the default port `:443` are dropped.
   - Anything else is `differs`: another port (`:0443` and `:8443` too), a path (even `/`), a query, a fragment, userinfo, a percent-escape (`%2E`), a backslash or a second trailing dot.
   - Then compare `"https://" + lowercase(host)` for equality. `unknown` only when `O.merchant_origin` is absent.
   - **`shop_agent`: PENDING S1.** Shop may report the store's myshopify domain rather than its storefront domain; the alias rule is decided after S1.
2. **checkout_ref.**
   - `handoff`: `"sha256:" + hex(SHA-256(utf8(O.checkout_ref))) == S.checkout_ref_hash`.
   - `shop_agent`: `O.checkout_ref == M.recorded_checkout_ref`, the checkout id the completer chained before completing. This proves **read-after-complete consistency only**: the Shop checkout is created by the completer after the approval, so the passkey does not bind it. The passkey binds the merchant, variant, quantity, ZIP and total, which checks 1, 3, 4 and 5 compare.
   - `unknown` when either checkout ref is absent.
3. **line.** Exactly one line, with `variant_ref == S.variant_ref` and `quantity == S.quantity`. Otherwise `differs`.
4. **ship_to.** The first 5 characters of `O.ship_to_postal_code` are 5 digits equal to `S.ship_to.postal_code` (a ZIP+4 matches on its first 5 digits). `unknown` when absent; an empty string is present and `differs`.
5. **total** (rule 25, `recheck-v1`). With `A = S.total.amount_minor` and `R = O.final_total.amount_minor`, the check is `match` iff `currency == "USD"`, `5·R ≥ 4·A` and `R ≤ A`: exactly `ceil(0.8·A) ≤ R ≤ A` for integer `R`. Any other currency is `differs`.

**Result**
- `ok` iff checks 1, 2, 3 and 5 are `match`, and check 4 is `match` (or `unknown` with `M.ship_to_optional`);
- `mismatch` iff any check is `differs`;
- `incomplete` otherwise.

**Output** `binding = {rule_version: "binding-v1", result, checks: {merchant_origin, checkout_ref, line, ship_to, total}}`. No observed value is copied in. Vector `vectors/o1-binding.json` gives each case's inputs, `ship_to_optional` included, and its expected binding: the 21 cases of the contract table and 9 that pin the origin grammar.

**1.5.0 callers.** Their approvals carry v1 snapshots, which hold no origin, variant or 5-digit ZIP. Intent Cloud still runs binding-v1 for them, against its own stored quote, so that binding is against values the passkey did not sign.

## `ApprovalStatus.state` for every outcome
Before an outcome exists, `state` behaves as in 1.5.0. Afterwards:

| `outcome.state` | Mode | 1.6.0 `state` | 1.5.0 `state` |
|---|---|---|---|
| `handed_off` | handoff | `handed_off` | `handed_off` |
| `checkout_expired` | handoff | `handed_off` | `handed_off` |
| `mismatch` | handoff | `handed_off` | `handed_off` |
| `reported` | handoff | `handed_off` | `handed_off` |
| `ordered` | handoff | `ordered` | `ordered` |
| `completing` | shop_agent | `approved` | not served (1.5.0 carts are `handoff`) |
| `indeterminate` | shop_agent | `approved` | not served |
| `failed` | shop_agent | `approved` | not served |
| `mismatch` | shop_agent | `approved` | not served |
| `reported` | shop_agent | `approved` | not served |
| `ordered` | shop_agent | `ordered` | not served |

- Every post-approval `state` is `approved`, `handed_off` or `ordered`, so the approval proof (Appendix E) is always present.
- `ordered` appears iff `outcome.state = ordered`: `state` never claims more than `outcome`.
- Vector `vectors/o3-status-state.json` has one row per line.

## Outcome report
`POST /v1/approvals/{approval_handle}/outcome-reports`, signed as in Appendix C, body `OutcomeReport`:
`{report_id, state: completing|ordered|mismatch|failed|indeterminate, source: shop_api|gateway_precheck, checkout_ref?, order_ref?, final_total?, binding?, observed_at}`. `checkout_ref` is required for `completing`; `order_ref`, `final_total` and `binding` for `ordered` and `mismatch`.

- **R1.** The request is signed by `S.completer_keyid`, or by the session key that created the cart. Anything else gets `403 forbidden`.
- **R2.** The first accepted report must be `completing`. It moves the approval to `completing` atomically: this is the redemption. The same `report_id` with the same body hash replays the first answer; the same `report_id` with another body hash gets `409 conflict`; another `report_id` while the approval is `completing` or terminal gets `409`.
- **R3.** `completing` gets `410 gone` after `S.expires_at`, or when the approval is not `approved`.
- **R4.** From `completing` the outcome may move to `indeterminate`, `ordered`, `mismatch` or `failed`. A terminal state is final; later reports get `409`.
- **R5.** A gateway's `ordered` or `mismatch` is stored as `{state: reported, source: gateway_report, assurance: reported, reported: {state, source, order_ref, final_total, binding}}`, with Intent Cloud's own binding-v1 re-run of the reported values beside it; its check 2 is `unknown`, because Intent Cloud never saw the Shop checkout. A gateway's `failed` is stored as `failed` with `assurance: reported`.
- **R6.** Success answers `201` with the edge receipt and `{accepted: true, outcome}`.
- **R7.** `GET /v1/approvals/{approval_handle}` follows R1 too, so a restarted gateway reads its approval with the completer key. Completer-signed reads are accepted until `S.expires_at` + 48 h, or 48 h after a terminal outcome, whichever is later; after that they get `404`. Completer-signed reports end at a terminal state (R4).

## Outcome statement
`ApprovalStatus` gains `outcome` (schema `Outcome`, present once the approval is past `approved`) and `outcome_statement`:

`OS = {v: 1, approval_handle, snapshot_hash, outcome, ledger, issued_at, kid, cloud_signature}`, with exactly these fields (schema `OutcomeStatement`):
- `ledger` is `{seq, entry_hash}` of the ledger entry that recorded the outcome (Appendix B);
- `kid` is an approval key `cloud-approval-<yyyymm>` listed in the key statement (Appendix F);
- `cloud_signature` is the approval key's Ed25519 signature over `"intent-outcome-v1\n" || JCS(OS without cloud_signature)`, base64url without padding: the Appendix E construction with its own prefix.

A statement is valid for an approval when it matches the schema and O1, `approval_handle` is that approval, `snapshot_hash` is the hash of the snapshot the passkey approved, `kid` is an approval key of a valid key statement (Appendix F), and `cloud_signature` verifies over the `intent-outcome-v1` input. Vector `vectors/o2-outcome-statement.json` has one valid statement, one with a changed outcome and one signed without the prefix: only the first verifies.
