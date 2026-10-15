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
| **Policy library** | `intent policy add` (planned) | The public, signed collection of shared gateway policies, reviewed by PR. |
| **Shopping session** | session key | A short-lived key for one anonymous run of searches and carts. The gateway sends no identifier that links it to other sessions. Not an account. |
| **Disclosure log** | — | The gateway's local hash chain of every field it sent to Intent Cloud, appended before each send. |
| **Disclosure receipt** | — | Intent Cloud's signed statement of what it received, matched against the disclosure log. |
| **Local audit trail** | — | The same local hash chain read as a whole: disclosure log entries plus each signed Approval the gateway verified. |
| **Approval** | — | A buyer's passkey signature over one purchase snapshot, returned signed by Intent Cloud, verified by the gateway and appended to the local audit trail. One per purchase. |
| **Hand-off** | `continue_url` | The step where the buyer leaves our confirm page for the merchant's checkout and pays there. The gateway never sees the buyer's name, address or payment. |
| **Verify command** | `intent verify` (planned) | Checks the local hash chain, matches receipts to the log, and checks the image signature and SBOM. |
