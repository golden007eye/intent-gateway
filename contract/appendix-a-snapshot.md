# Appendix A: Approval snapshot (normative)

Contract version 1.6.1. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/a1-snapshot.json`, `vectors/a2-snapshot-unicode.json` (non-ASCII text), `vectors/j1-jcs.json` (JCS edge cases) and `vectors/a3-snapshot-v2.json` (snapshots v2 and v3).

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
