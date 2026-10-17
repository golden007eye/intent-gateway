# Appendix F: Key statement (normative)

Contract version 1.6.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vector: `vectors/s1-key-statement.json`.

Receipt keys (Appendix D) and approval keys (Appendix E) rotate monthly. Each public API host has a long-lived offline **root key** that signs a statement listing them. The gateway pins the root public key per host and learns every other key from the statement. The edge serves the current statement at `GET /v1/key-statement`.

## Statement
`St = {v, kid, keys, confirm_origin, rp_id, issued_at, expires_at, signature}`, with exactly these fields (schema `KeyStatement`):

| Field | Rule |
|---|---|
| `v` | integer, `1` |
| `kid` | the root key, `cloud-root-<n>`; the first is `cloud-root-1` |
| `keys` | 2 to 4 entries `{kid, kty:"OKP", crv:"Ed25519", x}`, `x` the raw public key in base64url without padding. A `kid` is `cloud-receipt-<yyyymm>` or `cloud-approval-<yyyymm>`, and its prefix names the key's use. An approval key signs approval proofs (prefix `intent-approval-v1\n`, Appendix E) and outcome statements (prefix `intent-outcome-v1\n`, Appendix G), and nothing else. Each use has 1 or 2 keys (the current one and the next); kids are unique |
| `confirm_origin` | the `https` origin of the confirm page, without path |
| `rp_id` | the WebAuthn relying-party id of the confirm page's passkeys |
| `issued_at`, `expires_at` | RFC 3339 UTC with seconds and `Z`; `expires_at` is at least 90 and at most 180 days after `issued_at` |
| `signature` | the root key's Ed25519 signature over `"intent-statement-v1\n" || JCS(St without signature)`, base64url without padding |

## Verification (gateway)
A statement is valid for a host when all of these hold:
1. It matches the `KeyStatement` schema and the rules above, including the 90 to 180 day lifetime.
2. `kid` names a root key pinned for this host, and `signature` verifies under that key over `"intent-statement-v1\n" || JCS(St without signature)`.
3. `issued_at` is not more than 5 minutes ahead of the gateway's clock, and the clock is before `expires_at`. After `expires_at` the gateway fails closed: it trusts no receipt or approval key of that host until it has a newer valid statement.

A receipt or proof is checked against a key in a valid statement with the matching prefix. The confirm origin and rp_id used to check a proof (Appendix E) are the statement's, never values from elsewhere.
