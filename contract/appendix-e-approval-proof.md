# Appendix E: Approval proof (normative)

Contract version 1.5.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/e1-approval-proof.json` (ES256), `vectors/e1-rs256-approval-proof.json` (RS256).

The buyer approves a purchase with a passkey on the confirm page. The proof carries that passkey assertion, the passkey's public key and Intent Cloud's signature, so the gateway can check the approval itself. `GET /v1/approvals/{approval_handle}` returns it as `proof` once the approval is `approved`, `handed_off` or `ordered`; it is absent while `pending` and after a rejection or expiry.

## Proof
`P = {v, approval_handle, snapshot, snapshot_hash, assertion, credential_public_key, ledger, issued_at, kid, cloud_signature}`, with exactly these fields (schema `ApprovalProof`):

| Field | Rule |
|---|---|
| `v` | integer, `1` |
| `approval_handle` | the approval |
| `snapshot` | the purchase snapshot S the buyer approved (Appendix A) |
| `snapshot_hash` | `hex(SHA-256(JCS(S)))` |
| `assertion` | `{credential_id, authenticator_data, client_data_json, signature}`: the WebAuthn assertion as the authenticator returned it, each base64url without padding. The user handle is not included |
| `credential_public_key` | the passkey's public key as a JWK: `{kty:"EC", crv:"P-256", x, y, alg:"ES256"}` or `{kty:"RSA", n, e, alg:"RS256"}`. No other algorithm and no other member |
| `ledger` | `{seq, entry_hash}` of the approval's `approved` entry in the approval ledger (Appendix B) |
| `issued_at` | when Intent Cloud made the proof, RFC 3339 UTC with seconds and `Z` |
| `kid` | the approval key, `cloud-approval-<yyyymm>`, listed in the key statement (Appendix F) |
| `cloud_signature` | the approval key's Ed25519 signature over `"intent-approval-v1\n" || JCS(P without cloud_signature)`, base64url without padding |

The proof never contains the buyer's account identifier, name, address or payment details.

## Verification (gateway)
A proof is valid for an approval the gateway created when all of these hold:
1. It matches the `ApprovalProof` schema, and `approval_handle` and `snapshot.approval` both equal the approval the gateway asked about.
2. `kid` is an approval key (`cloud-approval-` prefix) in a key statement that verifies under the pinned root key and has not expired (Appendix F), and `cloud_signature` verifies over `"intent-approval-v1\n" || JCS(P without cloud_signature)`.
3. S is a valid snapshot (Appendix A) and `snapshot_hash == hex(SHA-256(JCS(S)))`. When the gateway kept the snapshot from `POST /v1/carts/{cart_handle}/approvals`, the hashes are equal.
4. `clientDataJSON` (decoded) is a JSON object with `type == "webauthn.get"`, `challenge == challenge("approve", snapshot_hash)` (Appendix A; a reject challenge never passes), `origin ==` the statement's `confirm_origin`, and `crossOrigin` absent or `false`.
5. `authenticatorData` is at least 37 bytes; its first 32 bytes equal `SHA-256(utf8(rp_id))` for the statement's `rp_id`; flag bit 0 (user present) and bit 2 (user verified) are set.
6. The assertion signature verifies under `credential_public_key` over `authenticatorData || SHA-256(clientDataJSON)`: ES256 is ECDSA P-256 with SHA-256 and a DER-encoded signature; RS256 is RSASSA-PKCS1-v1_5 with SHA-256.

What the gateway then trusts the credential for (pinning the first approving passkey, flagging a different one) is the gateway's policy, not part of this contract.
