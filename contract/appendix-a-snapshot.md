# Appendix A: Approval snapshot (normative)

Contract version 1.7.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/a1-snapshot.json`, `vectors/a2-snapshot-unicode.json` (non-ASCII text), `vectors/j1-jcs.json` (JCS edge cases) and `vectors/a3-snapshot-v2.json` (snapshots v2 and v3) and `vectors/a4-snapshot-v4.json` (snapshot v4).

## Purpose
What the buyer sees is what the passkey signs. The snapshot `S` is shown in full in the chat (confirm card) and on the confirm page. Its hash is bound into the WebAuthn challenge, and the hand-off only redirects to a URL whose hash is in `S`.

## Fields
`S` MUST contain exactly these fields, with no others:

| Field | Type and rule |
|---|---|
| `v` | integer, `1` |
| `approval` | string, opaque approval handle |
| `nonce` | 16 random bytes, base64url without padding (22 chars) |
| `merchant` | `{name, domain}`, non-empty strings |
| `item` | `{title, variant}`, non-empty strings |
| `quantity` | integer 1..3 |
| `unit_price`, `shipping`, `total` | Money `{amount_minor: integer ≥ 0, currency: "USD"}` |
| `total_kind` | `"exact"` or `"max"` |
| `ship_to` | `{country: "US", postal_prefix: 3 digits}` |
| `continue_url_hash` | `"sha256:" + 64 lowercase hex` |
| `rule_version` | string, for example `"recheck-v1"` |
| `expires_at` | RFC 3339 UTC with seconds and `Z`, for example `2026-10-03T12:15:00Z` |

All numbers are integers, and floats are invalid. The raw `continue_url` is **never** part of `S`; only its hash is.

## Derived values
- `continue_url_hash = "sha256:" + hex(SHA-256(utf8(url)))`
- `snapshot_hash = hex(SHA-256(JCS(S)))`, where JCS is RFC 8785 with the integer-only profile: floats and integers outside ±(2^53−1) are rejected.
- `challenge(action) = base64url(SHA-256(JCS({"action": action, "snapshot_hash": snapshot_hash})))`, where `action ∈ {"approve", "reject"}`.
- `check_code = snapshot_hash[0:8]`. A visual cross-check between card and page, **not** a cryptographic control.

## Hand-off invariant
Before redirecting, the confirm service MUST check `continue_url_hash(stored URL) == S.continue_url_hash`. If they differ, the approval moves to `expired` and there is no redirect.

## Snapshot v2 (1.6.0)
Callers that send `Intent-Contract-Version: 1.6.0` get v2 snapshots for every cart, hand-offs included. A v2 snapshot `S` MUST contain exactly the v1 fields, with `v` and `ship_to` changed, plus six new fields, with no others:

| Field | Type and rule |
|---|---|
| `v` | integer, `2` |
| `ship_to` | `{country: "US", postal_code: 5 digits}`, the 5-digit ZIP instead of the 3-digit prefix |
| `merchant_origin` | `"https://" + merchant.domain`. `merchant.domain` MUST already be ASCII lowercase (punycode `xn--` labels allowed) and is copied unchanged, never case-folded: a non-ASCII letter that folds to ASCII (such as U+212A KELVIN SIGN) is invalid. The host follows the Appendix G origin grammar: labels of `a-z`, `0-9` and `-`, not starting or ending with `-`, no empty label, no port, no path |
| `variant_ref` | 1 to 128 characters of `[A-Za-z0-9:/._-]`, the merchant's variant (Shopify: `gid://shopify/ProductVariant/<n>`); the same value is on the offer and the cart |
| `checkout_ref_hash` | the checkout ref hash of the merchant checkout (Appendix G: the id up to its first `?`, so a credential in the query is never hashed or stored). `handoff`: the checkout the buyer will pay. `shop_agent`: Intent Cloud's quote checkout. It is not a binding target in that mode, and it allows no hand-off (see below) |
| `completion_mode` | `"handoff"` or `"shop_agent"`: how payment happens |
| `completer_keyid` | a gateway keyid (`gw-` + base64url of a raw Ed25519 public key, Appendix C): the per-approval key that may read and report this approval (Appendix G) |
| `total_estimated` | boolean, `true` when the total came from a quote without the merchant's tax. The confirm page then labels it "Estimated total: the final total can be lower, never higher". The final total is never allowed above it (Appendix G) |

**Confirm page (v2).** Before the passkey prompt, the confirm page and the confirm card MUST show the merchant origin, the item and variant, the quantity, the 5-digit ZIP and the total. When `completion_mode = shop_agent`, they MUST also state that approving pays now with the buyer's Shop account, with no further review on the merchant's page.

**Hand-off of a `shop_agent` approval.** It is allowed only while no outcome of any kind exists for the approval and no outcome report was accepted. `ApprovalStatus.state` alone does not show this, since it stays `approved` in `shop_agent` mode (Appendix G O3). Otherwise the hand-off endpoint answers `409` and changes nothing. A failed hand-off never moves an approval out of `completing` or an outcome state.

The other fields keep their v1 rules. `snapshot_hash`, `challenge` and `check_code` are derived exactly as for v1, and the hand-off invariant is unchanged. Vector: `vectors/a3-snapshot-v2.json` (one `handoff` and one `shop_agent` snapshot).

## Snapshot v3 (1.6.1)
Callers that send `Intent-Contract-Version: 1.6.1` get v3 snapshots for every cart, hand-offs included. Only an explicit `1.6.1` header gets one: a 1.6.0 caller keeps getting v2 snapshots exactly as above and never receives `myshopify_domain`, on a snapshot, an offer or a cart. A v3 snapshot `S` MUST contain exactly these fields, with no others:

| Field | Present | Type and rule |
|---|---|---|
| `v` | always | integer, `3` |
| `approval`, `nonce`, `merchant`, `item`, `quantity`, `unit_price`, `shipping`, `total`, `total_kind`, `ship_to`, `continue_url_hash`, `rule_version`, `expires_at` | always | as in snapshot v2 (`ship_to` is the 5-digit ZIP) |
| `merchant_origin`, `variant_ref`, `checkout_ref_hash`, `completion_mode`, `completer_keyid`, `total_estimated` | always | as in snapshot v2 |
| `myshopify_domain` | exactly when the merchant is a Shopify store | the store's own host, the name Shop reports for it: ASCII, at most 253 characters, matching `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$`. It equals `myshopify_domain` on the `Offer` and the `Cart` the gateway received (Appendix E step 7) |

**Who vouches for the pair.** `merchant_origin` and `myshopify_domain` are the two names of one merchant, and Intent Cloud asserts that they belong together. Binding check 1 for `shop_agent` accepts either of them and nothing else (Appendix G), so the passkey signs both: once approved, the pair cannot change. The passkey does not show that the pair is right, since the buyer sees only the storefront origin: before paying, the completer verifies the pair against the storefront itself (Appendix G "Store pair check"). Intent Cloud lists each myshopify domain for at most one merchant.

**Confirm page (v3).** The v2 rules apply unchanged: the page and the card show the storefront origin (`merchant_origin`). `myshopify_domain` is not shown, since it names the same store; the gateway checks it against the offer the agent picked (Appendix E step 7).

`snapshot_hash`, `challenge` and `check_code` are derived exactly as for v1, and the hand-off invariant and the `shop_agent` hand-off rule are unchanged. Vector: `vectors/a3-snapshot-v2.json` (after the two v2 snapshots, one v3 `handoff` snapshot of a merchant that is not a Shopify store and one v3 `shop_agent` snapshot of a Shopify store).

## Snapshot v4 (1.7.0)
A 1.7.0 caller gets a v4 snapshot for every approval made from a submitted Shop checkout (`POST /v1/checkouts`); its carts keep v3 snapshots as above. The gateway creates the Shop checkout, reads it back and submits what the buyer will pay; Intent Cloud never sees the search. A v4 snapshot `S` MUST contain exactly these fields, with no others:

| Field | Present | Type and rule |
|---|---|---|
| `v` | always | integer, `4` |
| `approval`, `nonce`, `expires_at`, `rule_version` | always | as in snapshot v1 (`rule_version` is `recheck-v1`) |
| `store_name` | always | 1 to 80 characters, the store's name as Shop gives it |
| `store_site` | always | the store's storefront origin, `https://` + a host of the Appendix G grammar (the v2 `merchant_origin` rule: ASCII lowercase, no port, no path) with at least two labels and a top-level label of letters (or `xn--`): never an IP literal, a single label or a numeric last label |
| `myshopify_domain` | always | the store's own host, as in snapshot v3 |
| `variant_ref` | always | as in snapshot v2 |
| `title` | always | 1 to 120 characters, the line's title |
| `quantity` | always | integer 1..3 |
| `currency` | always | ISO 4217, a currency of the currency table (below); `USD` only in 1.7.0 |
| `totals` | always | `{subtotal, shipping, tax, total}`: integers in the currency's minor units, each 0 to 2^53−1, `total ≥ 1` and `total == subtotal + shipping + tax` |
| `ship_to` | always | `{country, postal_code_coarse}`: the country and the coarse postcode (below) |
| `checkout_ref_hash` | always | the checkout ref hash of the Shop checkout (Appendix G: its `id` up to the first `?`). Unlike v2 and v3, it is the checkout that will be paid in both modes, so binding check 2 is a real bound check |
| `completion_mode` | always | `"shop_agent"` or `"handoff"`: exactly one per approval. A hand-off after a one-tap approval is a new `POST /v1/checkouts` with `handoff`, a new approval and a new passkey decision |
| `completer_keyid` | always | as in snapshot v2 |
| `currency_table` | always | the version of the currency table the approval was checked against (below) |
| `account_key_thumbprint` | always | the RFC 7638 SHA-256 thumbprint of the gateway's Ed25519 account key (Appendix H), base64url without padding |
| `continue_url_hash` | exactly when `completion_mode = handoff` | `continue_url_hash` of the submitted `continue_url`: Shop's checkout page, `https://` + a host that is exactly `shop.app`, the checkout's `myshopify_domain` or the host of its `store_site` (compared as lowercase ASCII), then a path. No port (`:443` included), no userinfo, never another host. An ineligible checkout's page is on the myshopify domain (S1) |

The passkey signs every field. `snapshot_hash`, `challenge` and `check_code` are derived exactly as for v1. The hand-off invariant holds for a `handoff` v4 snapshot unchanged: Intent Cloud redirects only to a stored URL whose hash is `continue_url_hash`, and only to one of those three hosts. A `shop_agent` v4 snapshot allows no hand-off at all: switching to the hand-off needs a new approval. The v1 to v3 fields `merchant`, `item`, `unit_price`, `shipping`, `total`, `total_kind`, `merchant_origin` and `total_estimated` came from Intent Cloud's catalog and are not in v4: the store's names, the title and the four totals come from the Shop checkout itself, and its totals are exact. Vector: `vectors/a4-snapshot-v4.json`.

**Coarse postcodes.** Only the country and a coarse postcode leave the gateway. The submitted `ship_to.postal_code` MUST already be coarse, and Intent Cloud refuses a finer one (400): US the 5-digit ZIP (`^[0-9]{5}$`), CA the first 3 characters, uppercase (`^[A-Z][0-9][A-Z]$`), AU the 4-digit postcode (`^[0-9]{4}$`). Any other country is refused (400) in 1.7.0. `coarse(country, code)` turns a full postcode into the coarse one: remove spaces and `-`, uppercase, then take the first 5 characters (US), the first 3 (CA) or all 4 (AU); the result must match the country's pattern, else there is no coarse code. Binding-v2 coarsens Shop's full postcode by this rule (Appendix G). Vector: `vectors/a4-snapshot-v4.json` (`coarse` cases).

**Currency table and ceiling.** For each supported currency the table gives `order`, the most one order may total, and `week`, the most the approved orders that are not released may total over a rolling 7 days, both in the currency's minor units. The week sums the orders of the approving buyer and, as well, those approved with the same account key, so another buyer's passkey cannot spend a gateway's week afresh. There is no conversion: each currency is summed on its own. Only currencies whose ISO 4217 minor unit is 2 may be listed (AUD, CAD, CHF, CZK, DKK, EUR, GBP, HKD, MXN, NOK, NZD, PLN, SEK, SGD, USD); Intent Cloud refuses a table with any other at start. `version = "ct-" + hex(SHA-256(JCS(currencies)))[0:16]`, so a change of any value is a new version. `GET /v1/meta` serves the table to 1.7.0 callers as `currency_table`. A ceiling of 0 refuses every checkout in that currency. An approval is released when its outcome shows no order was paid (`failed` or `checkout_expired`), or it was rejected or expired before approval. A gateway's own report of `failed` releases its hold too: Intent Cloud cannot see the Shop checkout, so the week ceiling assumes an honest gateway (and the Shop budget remains the only hard stop). Intent Cloud checks: `order` when the checkout is submitted; `order` and `week` at the passkey approval (the buyer is known only then); and both again at the `completing` redemption, so lowering the ceiling also stops approvals made before. The approval's ledger entries record the table version the approval was checked against.

**Refusals.** `POST /v1/checkouts` refuses a checkout whose account key is pinned to a paused buyer with 409 `{error: "conflict", message, code: "paused"}` (Appendix H). Otherwise it refuses with 403 `{error: "forbidden", message, code}` and one `code`, checked in this order: `one_tap_off` (`shop_agent` while one tap is off), `currency_unsupported` (a currency not in the table), `store_blocked` (the myshopify domain is on Intent Cloud's block list), `category_excluded` (the title names an excluded category: health and medical, age-restricted, financial or digital goods; best effort, on keywords), `ceiling_order` (`totals.total` above the order ceiling, or the ceiling is 0). At the passkey approval the confirm page refuses an approval over `ceiling_order` or `ceiling_week`, or while paused; the decline still works. **A gateway's account key binds to the first buyer who approves with it:** an approval whose `account_key_thumbprint` is pinned to another buyer is refused with 403 `{error: "forbidden", message, code: "account_key_other_buyer"}`, so every later approval of that gateway needs the same buyer's passkey, and a pause by the key pauses exactly that buyer (Appendix H). The pin and this check are one write, so two buyers cannot both pin one key. There is no unpin: if someone else wins a key's first approval, the developer's recovery is a new account key (`intent init`). A `shop_agent` v4 approval is not redeemed while one tap is off: the `completing` report gets 409 `one_tap_off`. A `completing` report over either ceiling, or while paused, is 409 `{error: "conflict", message, code}` with that `code` (`ceiling_order`, `ceiling_week` or `paused`), and the approval stays `approved`; so is a refused passkey approval.

**Confirm page (v4).** Before the passkey prompt, the confirm page MUST show the store name, its site (`store_site`) and its myshopify domain, the title, the quantity, the total with its currency, the country and coarse postcode, and the completion mode. For `shop_agent` it states that approving pays now with the buyer's Shop account; for `handoff`, that the buyer pays on the checkout page of the hand-off host (`shop.app` or the store's own host).
