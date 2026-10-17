# Security

The gateway is a pre-alpha preview: nothing can be bought with it yet, but its checks are real and open to review. The [threat model](threat-model.md) lists the assets, the trust boundaries, how each invariant is enforced, and what is out of scope.

## Reporting a vulnerability

See [`SECURITY.md`](https://github.com/golden007eye/intent-gateway/blob/main/SECURITY.md) in the repository.

## Rules the code is held to

These are invariants in the repository's agent guide; each change that touches one carries a test that fails if it breaks, including an attack case.

1. **The policy can only narrow.** A gateway policy never loosens a rule Intent Cloud enforces.
2. **Log before send.** Every field sent to Intent Cloud or any other outside destination is appended to the local hash chain before the request leaves, in exact bytes except credentials, which are kept only as their sha256.
3. **No buyer identity in the gateway.** The gateway never stores or forwards the buyer's name, postal address or card.
4. **One human approval per purchase.** A purchase proceeds only with a passkey-signed Approval the gateway has verified and chained.
5. **Claim only what was sent.** Docs, logs and CLI output describe what the gateway sent and what Intent Cloud acknowledged receiving, nothing more.

## What you can check yourself

- `intent verify` re-checks the local hash chain, every receipt and every approval offline. [Verify](verify.md) says what each check proves and what it does not.
- `intent log` and the [panel](panel.md) show every send field by field, and every block.
- `intent doctor` checks the data dir's permissions, the policy, the chain, the root key and the Intent Cloud host, and gives the fix for each problem.
- The release checks you run with your own tools, `npm audit signatures` and `cosign verify`, are on the [Verify](verify.md#self-check-and-outside-checks) page. They apply from the first preview release.
- The package installs nothing but itself: its runtime dependencies are compiled into `dist/` ([ADR-0013](adr/0013-bundled-dependencies.md)), so its provenance covers their code. `dist/sbom.cdx.json` lists each bundled package with the SHA-512 the lockfile pins, and `dist/THIRD_PARTY_LICENSES` carries their licences.
