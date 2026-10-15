# Security

!!! planned "Planned"
    The threat model is not published yet; it will be before the gateway is usable. There is no release to attack yet.

## Reporting a vulnerability

See [`SECURITY.md`](https://github.com/golden007eye/intent-gateway/blob/main/SECURITY.md) in the repository.

## Rules the code is held to

These are invariants in the repository's agent guide; each change that touches one carries a test that fails if it breaks, including an attack case.

1. **The policy can only narrow.** A gateway policy never loosens a rule Intent Cloud enforces.
2. **Log before send.** Every field sent to Intent Cloud is appended to the local hash chain before the request leaves.
3. **No buyer identity in the gateway.** The gateway never stores or forwards the buyer's name, postal address or card.
4. **One human approval per purchase.** A purchase proceeds only with a passkey-signed Approval the gateway has verified and chained.
5. **Claim only what was sent.** Docs, logs and CLI output describe what the gateway sent, never what Intent Cloud does afterwards.

## Planned supply-chain checks

- Signed Docker images and an SBOM per release, checked by [`intent verify`](verify.md).
