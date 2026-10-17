# Appendix C: Gateway request signatures (normative)

Contract version 1.6.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vector: `vectors/c2-http-signature.json`.

Every gateway → Intent Cloud request is signed with HTTP Message Signatures (RFC 9421) and a session key. There is no bearer token and no account: the key is the caller's only identity.

## Session key and keyid
- The gateway makes a fresh Ed25519 key pair for each shopping session and keeps it in memory only.
- (1.6.0) A **completer key** is a separate Ed25519 key pair the gateway makes for one cart and names in `CartRequest.completer_keyid`, with the same keyid form. A gateway MAY persist a per-approval completer private key at rest, readable only by the gateway's user, and MUST delete it once Intent Cloud stops accepting it (Appendix G R7: `S.expires_at` + 48 h, or 48 h after a terminal outcome, whichever is later) at the latest. It MUST NOT appear in any log, request or response. The session signing key stays memory-only.
- (1.6.0) A 1.6.0 `CartRequest` without `completer_keyid`, or whose `completer_keyid` equals the request's signing keyid or the `completer_keyid` of any earlier approval, gets `400`.
- `keyid = "gw-" + base64url(raw 32-byte public key)`, without padding: `gw-` and 43 characters. The keyid is self-certifying: the verifier decodes the public key from it and needs no registration.
- A keyid that does not match `^gw-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`, or whose 32 bytes are not a valid Ed25519 public key, is refused.

## Signature profile (fixed)
- Label `sig1`. Covered components, in this order: `("@method" "@path" "content-digest")`.
- Parameters, in this order:
  - `created` (integer seconds);
  - `nonce` (base64 or base64url, **at least 16 bytes**);
  - `keyid` (the session keyid);
  - `alg="ed25519"`;
  - `tag="intent-gateway-v1"`.
- `Content-Digest` is RFC 9530 `sha-256`, required on every request, including an empty body (`sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:`).
- `@path` is the absolute path without query or fragment. No signed endpoint takes a query.
- The signature base is RFC 9421 §2.5 for these components:

  ```
  "@method": POST
  "@path": /v1/carts
  "content-digest": sha-256=:…:
  "@signature-params": ("@method" "@path" "content-digest");created=…;nonce="…";keyid="gw-…";alg="ed25519";tag="intent-gateway-v1"
  ```

  Headers: `Signature-Input: sig1=<signature-params>` and `Signature: sig1=:<base64 of the 64-byte signature>:`.

## Verification (Intent Cloud)

| Condition | Result |
|---|---|
| Missing or malformed `Content-Digest`, `Signature-Input` or `Signature`; any deviation from the profile, including another tag | 401 |
| `Content-Digest` does not match the body | **400** |
| `created` older than 60 s, or more than 5 s in the future | 401 |
| Nonce shorter than 128 bits, or not base64 | 401 |
| `keyid` malformed, or not a valid Ed25519 public key | 401 |
| Signature invalid | 401 |
| Nonce already seen | 401 |

- **Nonce retention:** 65 s (the 60 s maximum age plus the 5 s future skew), so every request that can still pass the age check is also caught by replay detection.
- **Nonce recording order:** a nonce is recorded only *after* the signature verifies, so forged requests cannot burn legitimate nonces.
- A `gw-` key is accepted only on the endpoints of `gateway-api.v1.yaml`, and on those endpoints only `gw-` keys are accepted.

## Ownership
- A cart, and every approval made from it, belongs to the session keyid that created the cart.
- A read or approval request for a handle owned by another keyid gets 404, exactly like an unknown handle. (1.6.0) The one exception is an approval's own completer key, which may read that approval and report its outcome within the limits of Appendix G (R1, R7).
- A new session (a new key) does not reset any rate limit or quota: limits are keyed per IPv4 address or IPv6 /64, never per key.

## Receipts
Every response to a signed request carries a receipt naming the `keyid`, `nonce` and `created` the edge parsed (Appendix D).
