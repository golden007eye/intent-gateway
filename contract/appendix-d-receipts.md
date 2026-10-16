# Appendix D: Receipts (normative)

Contract version 1.5.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vector: `vectors/d1-receipt.json`.

A receipt is Intent Cloud's signed statement of the request its edge received. It means "received at Intent Cloud's edge" and nothing more: not that the request was valid, stored or acted on.

## Receipt
`R = {v, kid, request, status, received_at}`, with exactly these fields (schema `Receipt`):

| Field | Rule |
|---|---|
| `v` | integer, `1` |
| `kid` | the receipt key, `cloud-receipt-<yyyymm>`, listed in the key statement (Appendix F) |
| `request.method` | the method received, upper case |
| `request.path` | the `@path` received, without query or fragment |
| `request.content_digest` | RFC 9530 `sha-256` Content-Digest that the **edge computed** over the body bytes it received (empty body included). Never copied from the request header |
| `request.keyid`, `request.nonce`, `request.created` | present together, exactly when the request's `Signature-Input` parses under the gateway profile (Appendix C) and the three values also match the `ReceiptRequest` schema, with the values as sent (`created` an integer); otherwise all three are absent. The signature itself may still be invalid: the status says so |
| `status` | the HTTP status of the response that carries this receipt |
| `received_at` | when the edge received the request, RFC 3339 UTC with seconds and `Z` |

JSON canonicalisation is JCS (RFC 8785) with the integer-only profile of Appendix A.

## Headers
Every response the edge returns carries, with `Intent-Contract-Version`:
- `Intent-Receipt`: base64url(JCS(R)), without padding;
- `Intent-Receipt-Signature`: the receipt key's Ed25519 signature over `"intent-receipt-v1\n" || JCS(R)`, base64url without padding (86 characters).

The signed bytes are the 18 ASCII bytes `intent-receipt-v1` and a line feed, followed by the exact bytes that `Intent-Receipt` encodes. This includes the 4xx and 429 responses the edge makes itself. A response made by the network in front of the edge carries neither the version header nor a receipt.

## Verification (gateway)
A receipt is valid for a request the gateway sent when all of these hold:
1. Both headers are present and decode as base64url.
2. The decoded bytes are UTF-8 JSON, and JCS of the parsed value equals those bytes (the receipt is canonical). It matches the `Receipt` schema.
3. `kid` is a receipt key (`cloud-receipt-` prefix) in a key statement that verifies under the pinned root key and has not expired (Appendix F), and the Ed25519 signature verifies over `"intent-receipt-v1\n" || bytes`.
4. `request.method`, `request.path` and `request.content_digest` equal what the gateway sent. For a signed request, `request.keyid`, `request.nonce` and `request.created` equal the values the gateway signed with.
5. `status` equals the status of the response that carried it.

`received_at` is informational; the gateway records it.

## Acknowledged, unacknowledged and discarded
- **Unacknowledged** only when there was no HTTP response, or a non-2xx response without `Intent-Contract-Version`. The send is reported as "sent, not acknowledged".
- **Discarded**: a 2xx response without a valid receipt. The gateway does not use its content and records it as discarded.
- **Invalid**: any response that carries `Intent-Contract-Version` without a valid receipt, and any receipt that fails a check above.
