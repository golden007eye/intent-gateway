# Appendix H: Account key and Pause (normative)

Contract version 1.7.1. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/h1-account-key.json` (thumbprints) and `vectors/h2-pause.json` (pause requests).

## Account key
`intent init` makes an Ed25519 **account key** on the developer's machine. Its public half is the JWK `K = {kty: "OKP", crv: "Ed25519", x}` (RFC 8037; `x` the raw 32-byte key, base64url without padding). It is used only to pause.
- `thumbprint(K) = base64url(SHA-256(utf8('{"crv":"Ed25519","kty":"OKP","x":"' + x + '"}')))`, the RFC 7638 thumbprint: the required members in lexicographic order, no whitespace; 43 characters.
- The gateway sends `K` as `account_key` with every `POST /v1/checkouts`, and the v4 snapshot signs `thumbprint(K)` (Appendix A).
- At the first passkey approval of a v4 snapshot that names it, Intent Cloud pins `thumbprint → buyer`, and the key belongs to that buyer from then on: an approval with it by another buyer is refused (`account_key_other_buyer`, Appendix A). One buyer may have several keys; a key has one buyer. A key that was never pinned is unknown.

## Pause
`POST /v1/pause` is signed with a gateway session key like every request (Appendix C), and in the body by the account key: `{account_key_thumbprint, counter, issued_at, signature}`, exactly these fields (any other is 400; `action` is never sent).
- `counter`: an integer 1 to 2^53−1, strictly greater than the last counter Intent Cloud accepted for the key, so a pause cannot be replayed after a resume.
- `issued_at`: RFC 3339 UTC with seconds and `Z`, within ±5 minutes of Intent Cloud's clock.
- `signature`: Ed25519 by the account key over `utf8("intent-pause-v1\n") || JCS({account_key_thumbprint, counter, issued_at, action: "pause"})`, base64url without padding. The key is the one pinned under `account_key_thumbprint`.

A 1.7.0 or 1.7.1 request is answered (a 1.7.1 gateway sends `Intent-Contract-Version: 1.7.1`); a 1.5.0 or 1.6.x one gets 404. Intent Cloud checks, in this order: the schema, strictly, with no extra field and no null (400 `bad_request`); 10 requests a minute per IP key, before the lookup (429, `limit: requests`); the key (404 `unknown account key`: not pinned, or the pinned key's thumbprint is not `account_key_thumbprint`); 10 pauses an hour per key, counting only pauses whose signature verified (429, `limit: pause`); the signature (401); `issued_at` within 300 s (400 `clock_skew`); the counter (409 `counter_replayed`, with `last_counter`). The counter is never reset, a resume included. The answer is `200 {state: "paused", account_key_thumbprint, counter, paused_at}`. A repeat pause with a new counter is also 200 and keeps the first `paused_at`.

The pause takes effect at once for the buyer the key is pinned to, until that buyer resumes. While a buyer is paused, each of these is refused with 409 `{error: "conflict", message, code: "paused"}` (`Error.code`, Appendix A "Refusals"): `POST /v1/checkouts` with a key pinned to that buyer; the passkey approval on the confirm page (the decline still works); the `completing` redemption. A buyer can also pause with the passkey from any device, on the confirm page's `/account`. **Resume is by passkey only**, on the confirm page; there is no gateway route. A gateway learns of a resume when its checkouts stop answering `paused`.

A pause stops purchases that go through Intent Cloud. It does not stop an agent that pays Shop directly with the Shop token: only the Shop budget does.
