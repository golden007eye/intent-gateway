# Appendix G: Outcomes (normative)

Contract version 1.7.1. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/o1-binding.json`, `vectors/o2-outcome-statement.json`, `vectors/o3-status-state.json`, `vectors/o4-report-transitions.json`, `vectors/o5-store-pair.json`.

## Purpose
What happened after an approval, stated only from evidence the stating service checked itself. Intent Cloud compares every observed order with the snapshot the passkey signed (binding-v1), states the outcome with its source and assurance, and signs that statement with its approval key. Served to callers that send `Intent-Contract-Version: 1.6.0` or `1.6.1`.

## Outcome states
| `outcome.state` | Mode | Meaning | Terminal |
|---|---|---|---|
| `handed_off` | handoff | The buyer was sent to the merchant checkout; the honest end when no order signal arrives | no |
| `completing` | shop_agent | The completer chained its redemption and told Intent Cloud | no |
| `ordered` | both | A verified order with `binding.result = ok` | yes |
| `mismatch` | both | A verified order with `binding.result = mismatch` | yes |
| `failed` | shop_agent | No order: the completer refused before sending `complete_checkout` (source `gateway_precheck`, see Completer precheck), or read Shop's terminal not-completed status (source `shop_api`) | yes |
| `checkout_expired` | handoff | The merchant checkout expired, as read from `get_checkout` or the merchant API | yes |
| `indeterminate` | shop_agent | `complete_checkout` was sent and its result is not yet known | no |
| `reported` | both | Someone told the service of an order it could not verify (a gateway report at Intent Cloud; an unsigned checkout-page event) | no |

- **O1.** `state = ordered` implies `assurance = verified` and `binding.result = ok`. Intent Cloud enforces O1 when it writes an outcome; a gateway enforces it when it reads one.
- **O2.** Each service states assurance from what it verified itself. Intent Cloud stores a gateway's report as `reported`. A gateway records Intent Cloud's `ordered` as Intent Cloud's report, beside its own binding result.
- **O3.** A reader branches on `outcome.state`, never on `ApprovalStatus.state` alone: in `shop_agent` mode, `state` stays `approved` for redeemed, failed and mismatched approvals (table below).

## Sources and assurance
| `source` | Read by | Assurance at the reader | Carries a ship-to (`ship_to_optional`) |
|---|---|---|---|
| `shop_api` | the gateway, over TLS from Shop ("read from Shop") | `verified` | yes (`false`): S1, 2026-10-18 |
| `gateway_precheck` | the gateway, its own refusal before `complete_checkout` | `verified` (the gateway knows it did not send) | n/a (`failed` only) |
| `merchant_api` | Intent Cloud, UCP `get_checkout` on its own checkout id (`status: completed` with an `order`), or `get_order` | `verified` | yes (`false`): S2, 2026-10-17 |
| `signed_webhook` | Intent Cloud, an RFC 9421-signed UCP order webhook | `verified` | yes (`false`) |
| `staging_webhook` | Intent Cloud, a Shopify HMAC webhook from Intent Cloud's own store | `verified` | yes (`false`) |
| `checkout_page` | Intent Cloud, an unsigned event | `reported` at most | n/a |
| `gateway_report` | Intent Cloud, a report from a gateway | `reported` | n/a |

A source's assurance column is a cap: an outcome from `checkout_page` or `gateway_report` is `reported` at most, so O1 never lets it be `ordered`; `gateway_precheck` gives `failed` only.

Intent Cloud states outcomes only from the sources it reads itself: `merchant_api`, `signed_webhook`, `staging_webhook`, `checkout_page` and `gateway_report`. An Intent Cloud outcome naming `shop_api` or `gateway_precheck` is invalid. `staging_webhook` comes only from Intent Cloud's own staging store and never appears on a production host; a gateway refuses it from any other host.

The live tests answered both ship-to cells. S2 (2026-10-17): a completed merchant checkout read with `get_checkout` carries the destination ZIP. S1 (2026-10-18): Shop's `get_checkout` carries the 5-digit ship-to ZIP before and after completion. So no source has `ship_to_optional = true`: an outcome without a ZIP is `incomplete`, never `ordered`.

## Binding check `binding-v1`
**Inputs**
- the approved snapshot `S` (v2 or v3, Appendix A);
- an observed order `O = {merchant_origin?, checkout_ref?, lines: [{variant_ref, quantity}], ship_to_postal_code?, final_total: Money}`, where `checkout_ref` is the raw checkout id as the checking service observed it. It never leaves that service: what is sent or stored is its hash;
- a context `M = {mode, recorded_checkout_ref_hash?, ship_to_optional, bound_elsewhere?}`, where `ship_to_optional` comes from the sources table and `bound_elsewhere` is `true` when the observed order is already bound to another approval (Intent Cloud's store knows this; see check 2). A `mode` other than `handoff` or `shop_agent` is an error, not a check result.

Every reference (`merchant_origin`, `checkout_ref`, `recorded_checkout_ref_hash`, `variant_ref`, `ship_to_postal_code`) is a JSON string and every amount and quantity a JSON integer: a value of another type is `differs`, never converted. Inputs are parsed under the integer-only profile of Appendix A, so `1.0`, `"1"` and `true` are not the integer `1`. A parser that cannot tell `1.0` from `1` (such as plain `JSON.parse`) MUST reject non-integer number tokens before binding, which also gives `differs` for the o1 `1.0` case. Every pattern in this contract matches the whole value, as ECMA-262 does with `^…$`: a trailing newline never matches.

**Checkout ref hash.** `checkout_ref_hash(id) = "sha256:" + hex(SHA-256(utf8(p)))`, where `p` is `id` up to but excluding its first `?` (all of `id` when it has none). The query of a checkout id can carry a credential (Shopify: `?key=`) and can differ between reads; the part before it names the checkout. Shop's checkout `id` is `gid://shopify/Checkout/<token>?key=…`, so its checkout ref hash covers `gid://shopify/Checkout/<token>`; `create_checkout` and `get_checkout` return the same part before `?` (S1, 2026-10-18). An id whose part before `?` is empty has no checkout ref hash and gives `differs`. The snapshot's `checkout_ref_hash` (Appendix A) and every reported or recorded checkout ref use this one construction. A raw checkout id is never sent in a report, written to a ledger or log, or returned in an error.

**Checks.** Each yields `match`, `differs` or `unknown`.
1. **merchant_origin** (`handoff`).
   - Both sides must be ASCII. A non-ASCII value on either side is `differs` (IDNA2003 and UTS-46 implementations would otherwise disagree).
   - Each side, compared case-insensitively, must be exactly `"https://" host ["."] [":443"]`: the host is one or more labels joined by `.`, each label 1 to 63 of `a-z`, `0-9` and `-`, not starting or ending with `-`; no empty label; the host at most 253 characters. At most one trailing dot and the default port `:443` are dropped.
   - Anything else is `differs`: another port (`:0443` and `:8443` too), a path (even `/`), a query, a fragment, userinfo, a percent-escape (`%2E`), a backslash or a second trailing dot.
   - Then compare `"https://" + lowercase(host)` for equality. `unknown` only when `O.merchant_origin` is absent.
   - **`shop_agent` (1.6.1).** Shop reports the store's myshopify domain (`<store>.myshopify.com`), not its storefront domain (S1). With a v3 snapshot that carries `myshopify_domain` (Appendix A), the check is `match` when `O.merchant_origin` equals, by the rules above, either `S.merchant_origin` or `"https://" + S.myshopify_domain`: the two names of the one merchant the passkey signed, never another merchant's. With a v2 snapshot, or a v3 snapshot without `myshopify_domain`, only `S.merchant_origin` matches. In `handoff` mode only `S.merchant_origin` matches.
2. **checkout_ref.**
   - `handoff`: `checkout_ref_hash(O.checkout_ref) == S.checkout_ref_hash`.
   - `shop_agent`: `checkout_ref_hash(O.checkout_ref) == M.recorded_checkout_ref_hash`, the hash of the checkout the completer chained before completing. This proves **read-after-complete consistency only**: the Shop checkout is created by the completer after the approval, so the passkey does not bind it. The passkey binds the merchant, variant, quantity, ZIP and total, which checks 1, 3, 4 and 5 compare.
   - `unknown` when either checkout ref is absent.
   - **One order, one approval.** Intent Cloud binds each `(merchant_origin, order_ref)` and each checkout ref hash to at most one approval. When any source gave the canonical order id (Shopify: `gid://shopify/Order/<n>`, where `<n>` is 1 to 20 digits; Shop's are 14, S1), that id is the binding key, and every other form of the same order (such as `#1001`) is stored against the same approval. An observed order already bound to another approval (`M.bound_elsewhere`) gives check 2 `differs`, whatever else is present or absent. Intent Cloud never uses a gateway-reported reference to look up a verified source for another approval.
3. **line.** Exactly one line, with `variant_ref == S.variant_ref` and `quantity == S.quantity`, both compared as JSON values of the same type. Otherwise `differs`.
4. **ship_to.** The first 5 characters of `O.ship_to_postal_code` are 5 digits equal to `S.ship_to.postal_code` (a ZIP+4 matches on its first 5 digits). `unknown` when absent; an empty string is present and `differs`.
5. **total** (rule 25, `recheck-v1`). With `A = S.total.amount_minor` and `R = O.final_total.amount_minor`, the check is `match` iff `currency == "USD"`, `5·R ≥ 4·A` and `R ≤ A`: exactly `ceil(0.8·A) ≤ R ≤ A` for integer `R`. Any other currency is `differs`.

**Result**
- `ok` iff checks 1, 2, 3 and 5 are `match`, and check 4 is `match` (or `unknown` with `M.ship_to_optional`);
- `mismatch` iff any check is `differs`;
- `incomplete` otherwise.

**Output** `binding = {rule_version: "binding-v1", result, checks: {merchant_origin, checkout_ref, line, ship_to, total}}`. No observed value is copied in. Vector `vectors/o1-binding.json` gives each case's inputs, `ship_to_optional` included, and its expected binding: the 21 cases of the contract table, the cases that pin the origin grammar, the cases that pin types and the one-order rule, and the cases that pin check 1 for `shop_agent` with a v3 snapshot (the vector's description gives the counts).

**1.5.0 callers.** Their approvals carry v1 snapshots, which hold no origin, variant or 5-digit ZIP. Intent Cloud still runs binding-v1 for them, against its own stored quote, so that binding is against values the passkey did not sign. No outcome statement is ever issued for a v1 snapshot.

## Completer precheck (`shop_agent`)
The passkey binds the merchant, variant, quantity, ZIP and total, but the Shop checkout is created after the approval. So the completer checks that checkout before it pays:

1. Immediately before `complete_checkout`, in the same session and with no cached read, the completer MUST read the Shop checkout it will complete (`get_checkout`) and run binding-v1 with `O` = that checkout and `M.mode = shop_agent`. Check 2 is skipped: the checkout is the completer's own, and `M.recorded_checkout_ref_hash` is set from it here.
2. It MUST send `complete_checkout` only if all of these hold:
   - Intent Cloud accepted this completer's own `completing` report for this approval (`201` with `accepted: true`; a `409` or `410` is no acceptance);
   - that report's `checkout_ref_hash` equals the checkout ref hash of the checkout read in step 1;
   - checks 1, 3, 4 and 5 are `match` (check 4 may be `unknown` only when `ship_to_optional`);
   - the current time is before `S.expires_at`;
   - the Appendix E proof verifies for this approval, step 7 included;
   - (1.6.1) for a v3 snapshot that carries `myshopify_domain`, the store pair check below passed before the `completing` report and still passes.
3. Otherwise it sends nothing. After an accepted `completing`, it reports `failed` with source `gateway_precheck`. A refusal before Intent Cloud accepted `completing` is a local outcome only: nothing is reported, and the approval stays `approved` at Intent Cloud.

A final total above the approved total is always refused, `total_estimated` included: the buyer approved at most `S.total`. Check 1 for `shop_agent` accepts the storefront origin or the myshopify domain that the v3 snapshot signed, and nothing else (check 1 above); with a v2 snapshot it accepts the storefront origin only. The gateway's own spending cap and reservation are local policy and stay outside this contract: the precheck is a floor, not the only gate.

**Retries.** Shop does not deduplicate `create_checkout` on an idempotency key (S1, 2026-10-18): a replay with the same key creates a new checkout with a new id. A completer MUST NOT rely on that key to make a retry safe. The checkout it may complete is the one whose checkout ref hash its accepted `completing` report named (step 2).

**Store pair check (1.6.1).** Intent Cloud asserts that a v3 snapshot's `myshopify_domain` and `merchant_origin` name the same store. The passkey signs the pair but cannot judge it, since the buyer sees only the storefront origin. So for a v3 snapshot that carries `myshopify_domain`, the completer MUST verify the pair against the storefront itself, **before** its `completing` report:
1. **Request.** `GET <S.merchant_origin>/meta.json`, with `S.merchant_origin` exactly as signed. A `merchant_origin` that is not `https://` is a failure. A host that is an IP literal (IPv4 or IPv6), `localhost` or a `.localhost` name, a single label, or a name whose last label is numeric (a last label that is all digits, or 0x followed by hex digits, as the WHATWG URL standard reads a name that ends in a number) is a failure. So is a name that resolves to a loopback, private, link-local or otherwise non-public address: the completer's fetcher checks the resolved address before it connects. The request carries no cookies, no credentials, no `Authorization` header and no buyer data. This contract sets no expectation beyond that URL.
2. **Limits.** 5 s in total. At most 64 KiB of body, counted on the bytes read: more is a failure. Status `200` only: a `3xx` is a failure and is never followed. The media type is `application/json`, compared case-insensitively, parameters such as `charset` allowed. The body parses as a JSON object; a body that is empty, starts with a byte order mark or has a duplicate member name is a failure (parsers disagree on which duplicate wins, so the check fails closed).
3. **Match.** The object's top-level `myshopify_domain` is a string of ASCII characters only and, lowercased, equals `S.myshopify_domain` exactly: no trimming, no dropped dot. A non-ASCII value is a failure and is never normalised (as binding-v1's ASCII origin rule). A missing member or a value that is not a string is a failure, the same as a different value. The completer compares only against a valid `S.myshopify_domain` (Appendix A).
4. **Errors.** A network error or a timeout is a failure.
5. **Cache.** A completer MAY keep a passing result for at most 24 h, keyed by `(merchant_origin, myshopify_domain)`, so a store paired with another domain is checked again. A failure is never cached.

A failure before the `completing` report is local: nothing is reported, the approval stays `approved` and the buyer can still hand off. As a safety net, if the check does not pass at `complete_checkout` time (for example, a cached result expired and the new check fails), the completer sends nothing and reports `failed` with source `gateway_precheck`. Vector `vectors/o5-store-pair.json` gives each case, in the order the checks run.

## `ApprovalStatus.state` for every outcome
Before an outcome exists, `state` behaves as in 1.5.0. Afterwards:

| `outcome.state` | Mode | 1.6.0 and 1.6.1 `state` | 1.5.0 `state` |
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
`{report_id, completing_report_id?, state: completing|ordered|mismatch|failed|indeterminate, source: shop_api|gateway_precheck, checkout_ref_hash?, order_ref?, final_total?, binding?, observed_at}`. `checkout_ref_hash` (the checkout ref hash of the Shop checkout, never the raw id) is required for `completing`; `completing_report_id` for every other state; `order_ref`, `final_total` and `binding` for `ordered` and `mismatch`; `source: gateway_precheck` only with `failed`. The schema encodes these rules.

- **R1.** The request is signed by `S.completer_keyid`, or by the session key that created the cart. Any other key gets `404`, exactly like an unknown handle (Appendix C ownership), so a stranger learns nothing about the approval. R1 runs first.
- **R0.** Then an approval whose snapshot has `completion_mode` other than `shop_agent` gets `409 not a shop_agent approval`.
- **R2.** The first accepted report must be `completing`. It moves the approval to `completing` atomically: this is the redemption. A report's body hash is `hex(SHA-256(JCS(body)))`. The same `report_id` with the same body hash replays the first answer; the same `report_id` with another body hash gets `409 conflict`. A second `completing` report with another `report_id` gets `409`. A retry MUST resend the byte-identical body of the first send, so a regenerated `observed_at` never burns the approval.
- **R3.** A first `completing` gets `410 gone` after `S.expires_at`, or when the approval was rejected or has expired. A `completing` after an accepted one gets R2's `409`, never `410`.
- **R4.** Every report after `completing` carries `completing_report_id`, equal to the `report_id` of the accepted `completing` report; otherwise `409`. `report_id` is never served, so a key that can only read cannot write a later report. It MUST carry at least 128 bits from a CSPRNG: `or_` + at least 22 base64url characters. The reported state moves only along these transitions; any other report gets `409`:

  | From | To |
  |---|---|
  | `approved` | `completing` |
  | `completing` | `indeterminate`, `ordered`, `mismatch`, `failed` |
  | `indeterminate` | `ordered`, `mismatch`, `failed` |

  `ordered`, `mismatch` and `failed` are terminal for reports, judged on the **reported** state even though Intent Cloud stores `ordered` and `mismatch` as `reported` (R5). Vector `vectors/o4-report-transitions.json` gives every pair.
- **R5.** A gateway's `ordered` or `mismatch` is stored as `{state: reported, source: gateway_report, assurance: reported, reported: {state, source, order_ref, final_total, binding}}`, with Intent Cloud's own binding-v1 re-run of the reported values beside it. In that re-run a check Intent Cloud cannot observe is `unknown`, never `match` or `differs`: check 2 (it never saw the Shop checkout), check 3 (a report carries no line) and checks 1 and 4 (a report carries no origin or ZIP). Only check 5 compares a reported value, so the re-run of a legitimate order is `incomplete`, never `mismatch`. A gateway records Intent Cloud's statement of it as Intent Cloud's report, never as a verdict (O2). An approval made by a 1.6.0 caller (a v2 snapshot) keeps the 1.6.0 re-run, whose check 3 is `differs`. A gateway's `failed` is stored as `failed`, and its `completing` and `indeterminate` as those states. Each has `source: gateway_report`, `assurance: reported` and `reported: {state, source}`.
- **R5a.** A `verified` outcome from a source Intent Cloud reads itself replaces any `reported` outcome, a gateway's `failed` included. A `reported` outcome never replaces a `verified` one, and replaces a `reported` one only from the same source. A terminal `verified` outcome is final: nothing replaces it.
- **R6.** Success answers `201` with the edge receipt and `{accepted: true, outcome}`.
- **R7.** `GET /v1/approvals/{approval_handle}` follows R1 too, so a restarted gateway reads its approval with the completer key. Completer-signed reads are accepted until `S.expires_at` + 48 h, or 48 h after a terminal outcome, whichever is later; after that they get `404`. Completer-signed reports end at a terminal state (R4).
- **R8.** An approval created by a 1.6.0 request is read and reported on only with `Intent-Contract-Version: 1.6.0`, and one created by a 1.6.1 request only with `1.6.1`; any other version, or none, gets `404`. So a 1.6.0 caller never sees a v3 snapshot or `myshopify_domain`. The `Intent-Contract-Version` response header names the version that was served, and a 1.6.x caller treats any other value as Invalid.

## Outcome statement
`ApprovalStatus` gains `outcome` (schema `Outcome`, present once the approval is past `approved`) and `outcome_statement`. In 1.6.0 and 1.6.1 they are both present or both absent (the schema's `dependentRequired` in 1.6.1), and `JCS(outcome) == JCS(outcome_statement.outcome)`. A reader acts only on the verified statement; a difference between the two is Invalid (Appendix D).

`OS = {v: 1, approval_handle, snapshot_hash, outcome, ledger, issued_at, kid, cloud_signature}`, with exactly these fields (schema `OutcomeStatement`):
- `ledger` is `{seq, entry_hash}` of the ledger entry that recorded the outcome (Appendix B);
- `kid` is an approval key `cloud-approval-<yyyymm>` listed in the key statement (Appendix F);
- `cloud_signature` is the approval key's Ed25519 signature over `"intent-outcome-v1\n" || JCS(OS without cloud_signature)`, base64url without padding: the Appendix E construction with its own prefix.

A statement is valid for an approval when all of these hold:
1. It matches the schema and O1. `approval_handle` is that approval and `snapshot_hash` is the hash of the v2 or v3 snapshot the passkey approved.
2. `kid` is an approval key of a valid key statement (Appendix F), and `cloud_signature` verifies over the `intent-outcome-v1` input.
3. Its outcome is consistent:
   - `outcome.binding.result` is what the binding-v1 result rule gives for `outcome.binding.checks`, with `ship_to_optional` from the sources table;
   - `ordered` and `mismatch` carry `order_ref`, `final_total` and `binding`, and `ordered` has `final_total.amount_minor ≤ S.total.amount_minor`;
   - `outcome.state` is a state of the snapshot's `completion_mode` (Outcome states table);
   - `outcome.source` is a source Intent Cloud reads itself, and `outcome.assurance` is within that source's cap (Sources and assurance).

Vector `vectors/o2-outcome-statement.json` has two valid statements (the second names a 14-digit Shopify order id) and invalid ones: a changed outcome, a signature without the prefix, a signature with the `intent-approval-v1` prefix, another snapshot, and correctly signed statements that break each rule of step 3, the assurance cap included. Only the first two are valid.

## Binding check `binding-v2` (1.7.0)
Every outcome of an approval with a v4 snapshot (Appendix A) is bound with `binding-v2`, by Intent Cloud and by the gateway; reports of such an approval carry `rule_version: "binding-v2"`. The inputs are binding-v1's, with the snapshot a v4 one and the observed order `O = {merchant_origin?, checkout_ref?, lines: [{variant_ref, quantity}], ship_to_country?, ship_to_postal_code?, final_total: Money}`. The type rules and the result rule are binding-v1's. The checks:
1. **merchant_origin** (both modes). By binding-v1's grammar and comparison, `match` when `O.merchant_origin` equals `S.store_site` or `"https://" + S.myshopify_domain`: the two names of the one store the passkey signed. `unknown` only when absent.
2. **checkout_ref** (both modes). `checkout_ref_hash(O.checkout_ref) == S.checkout_ref_hash`. The gateway created the checkout before the approval and the passkey signed its hash, so this is a bound check in `shop_agent` mode too: a completer that pays another checkout gets `differs`. `unknown` when absent. The one-order rule is binding-v1's.
3. **line.** As binding-v1, against `S.variant_ref` and `S.quantity`.
4. **ship_to.** `O.ship_to_country` equals `S.ship_to.country` (else `differs`), and `coarse(S.ship_to.country, O.ship_to_postal_code)` (Appendix A "Coarse postcodes", per country: GB the outward code, IE the routing key, the euro countries the first 2 digits in 1.7.1) exists and equals `S.ship_to.postal_code_coarse`. `coarse()` is Appendix A's exact rule (ASCII only, spaces and `-` removed, uppercased, the whole matching the country's full-postcode pattern) and is applied to the FULL postcode Shop observed: an already-coarse value has no coarse form, so GB `"SW1A"`, IE `"D6W"` and DE `"10"` are `differs`, as are trailing characters and non-ASCII look-alikes, while `"SW1A 1AA"` against `"SW1A"` is `match`. `unknown` when the country or the postcode is absent (the country is never assumed); an empty string, or a code with no coarse form, is `differs`.
5. **total** (rule 25, unchanged). With `A = S.totals.total` and `R = O.final_total.amount_minor`, `match` iff `O.final_total.currency == S.currency`, `5·R ≥ 4·A` and `R ≤ A`; any other currency is `differs`: amounts are compared only in one currency's minor units, never converted. In 1.7.1 an outcome's and a report's `final_total` is `TwoDecimalMoney`, any two-decimal ISO 4217 currency (up to 1.7.0, USD only: a CAD or AUD report was malformed).

Output `binding = {rule_version: "binding-v2", result, checks}` with binding-v1's five check names. A 1.6.x approval keeps binding-v1. The completer precheck of a v4 `shop_agent` snapshot runs binding-v2, and check 2 is not skipped: the checkout it reads must be the one the passkey signed. Vector: `vectors/o6-binding-v2.json`.
