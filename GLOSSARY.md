---
documentLanguage: en
---

# Glossary

One entry per term: what it is, and its boundary. Vocabulary here is used as-is in code, docs and PRs. Record a new term in the same PR that introduces it.

| Term | Code name | What it is |
|---|---|---|
| **Gateway** | `intent-gateway` | The self-hosted Docker container a developer runs. It talks to the agent over MCP and to Intent Cloud for offers and carts. |
| **Intent Cloud** | — | The hosted service behind the gateway: product discovery, merchants, offers and carts. Reached only through its public API host. |
| **Gateway policy** | `policy.yaml` | The developer's YAML rules for what may leave the gateway and how much may be spent. It can only narrow Intent Cloud's rules, never loosen them. |
| **Cloud baseline** | `CLOUD_BASELINE` | The rules Intent Cloud enforces, held by the gateway as the loosest policy it will run: passkey approval, at most 3 items, US delivery, the excluded categories. Every policy is checked against it. |
| **Policy library** | `intent policy add` (planned) | The public, signed collection of shared gateway policies, reviewed by PR. |
| **Policy lock** | `policy.lock` | The file beside `policy.yaml` that `intent policy add` writes: the library policy's name, the commit it came from, its sha256, its source (`bundled` with the gateway, or `github` for `--commit`) and `policy_sha256`, the hash of the `policy.yaml` it wrote. It records what was applied, not the policy itself; a lock whose `policy_sha256` does not match `policy.yaml` is stale. |
| **Shopping session** | session key | A short-lived key for one anonymous run of searches and carts. The gateway sends no identifier that links it to other sessions. Not an account. |
| **Session keyid** | `gw-…`, `src/signing` | The shopping session's identity on the wire: `gw-` plus the base64url of its raw Ed25519 public key. Self-certifying: Intent Cloud reads the public key from it, with no registration. Every request carries it in its RFC 9421 signature (contract appendix C). |
| **Disclosure log** | — | The gateway's local hash chain of every field it sent to Intent Cloud, appended before each send. |
| **Disclosure receipt** | — | Intent Cloud's signed statement of what it received, matched against the disclosure log. |
| **Local audit trail** | — | The same local hash chain read as a whole: disclosure log entries plus each signed Approval the gateway verified. |
| **Fenced lease** | `audit.lock` | The expiring lock a writer of the local hash chain holds while it appends. Before each write the writer checks it still holds the lease and that the chain's tail has not moved; if either fails, that writer is refused for good. Liveness comes only from the expiry, never from a process id. |
| **Approval** | — | A buyer's passkey signature over one purchase snapshot, returned signed by Intent Cloud, verified by the gateway and appended to the local audit trail. One per purchase. |
| **Approver pin** | `approver_pin` | The passkey credential the gateway trusts for Approvals: the first one it verified, or one accepted later with `intent approver accept` at a terminal. Any other credential is flagged (ADR-0011). |
| **Approver fingerprint** | `approverFingerprint` | How a person compares passkeys: the SHA-256 of the canonical JSON of the passkey's public key (JWK), as 16 groups of 4 hex characters. The `approver_pin` and `approver_flag` entries carry it, the panel and stderr show it, and `intent approver accept` asks for it. |
| **Key statement** | `verifyStatement` | Intent Cloud's statement, signed by an offline root key pinned per host, listing its current and next receipt and approval keys. Valid 90 to 180 days (ADR-0006). |
| **Fake Cloud** | `startFakeCloud`, `src/cloud-fake` | A stand-in for Intent Cloud on 127.0.0.1 that follows the public contract and signs with its published test keys (vectors s1, d1, e1). Only tests and the local acceptance run use it; it is not in the package or the image. |
| **Soft passkey** | `SoftPasskey` | A passkey held in memory (ES256 or RS256) that answers the confirm page's WebAuthn request in tests, in place of the buyer's authenticator. |
| **Buyer identity** | `findIdentity` | Anything that identifies or pays as the buyer: name, postal address, card number, email, phone. The gateway refuses to send it; a ZIP code alone is not buyer identity. |
| **Hand-off** | `continue_url` | The step where the buyer leaves our confirm page for the merchant's checkout and pays there. The gateway never sees the buyer's name, address or payment. |
| **Verify command** | `intent verify` (planned) | Checks the local hash chain, matches receipts to the log, and checks the image signature and SBOM. |
| **Canonical JSON** | `jcs` | RFC 8785 JSON restricted to safe integers (no fractions, no NaN, no lone surrogates): the exact bytes the gateway hashes and verifies signatures over. |
| **Data directory** | `Config.dataDir` | Where the gateway keeps its state: `INTENT_DATA_DIR`, else `/data` in the image, else the platform's per-user data folder. Resolved only by `src/config`. |
| **Root key pin** | `PINNED_HOSTS` | The root public key (kid `cloud-root-1`) the gateway trusts for one Intent Cloud host. It holds only that key; everything else trusted comes from the statement the key signs. `--trust-keys` replaces it for an unpinned host. |
| **Self-check** | `label: "self-check"` | A provenance or signature check of the gateway's own npm package or image, run by the installed gateway code itself. A tampered install could tamper with it too, so it always names the outside checks (`npm audit signatures`, `cosign verify`) that settle the question. |
| **Panel** | `startPanel` | The read-only local web page on `127.0.0.1`: chain status, disclosures, pending approvals, the approver pin fingerprint and flags. GET only; it never writes the chain and loads nothing from outside the gateway. |
| **Public contract** | `contract/` | The Intent Cloud public contract: the gateway API spec, its normative appendices and test vectors, published under Apache-2.0. The gateway vendors it byte for byte; `contract/SOURCE.md` names the version and the sha256 of `SHA256SUMS`. |
| **Test vector** | `contract/vectors/*.json` | An input with the exact output Intent Cloud computed for it. Both sides must reproduce it byte for byte; formats are shared this way, never by sharing code. |
