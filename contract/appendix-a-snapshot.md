# Appendix A: Approval snapshot (normative)

Contract version 1.6.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/a1-snapshot.json`, `vectors/a2-snapshot-unicode.json` (non-ASCII text), `vectors/j1-jcs.json` (JCS edge cases) and `vectors/a3-snapshot-v2.json` (snapshot v2).

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
| `merchant_origin` | `"https://" + merchant.domain`, lowercased: ASCII only (punycode `xn--` labels allowed), no port, no path |
| `variant_ref` | 1 to 128 characters of `[A-Za-z0-9:/._-]`, the merchant's variant (Shopify: `gid://shopify/ProductVariant/<n>`); the same value is on the offer and the cart |
| `checkout_ref_hash` | `"sha256:" + hex(SHA-256(utf8(checkout_id)))` of the merchant checkout. `handoff`: the checkout the buyer will pay. `shop_agent`: Intent Cloud's quote checkout, kept for a later manual hand-off only |
| `completion_mode` | `"handoff"` or `"shop_agent"`: how payment happens |
| `completer_keyid` | a gateway keyid (`gw-` + base64url of a raw Ed25519 public key, Appendix C): the per-approval key that may read and report this approval (Appendix G) |
| `total_estimated` | boolean, `true` when the total came from a quote without the merchant's tax. The confirm page then labels it "Estimated total: the final total can be lower, never higher" |

The other fields keep their v1 rules. `snapshot_hash`, `challenge` and `check_code` are derived exactly as for v1, and the hand-off invariant is unchanged. Vector: `vectors/a3-snapshot-v2.json` (one `handoff` and one `shop_agent` snapshot).
