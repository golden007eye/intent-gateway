# Verify

The gateway is built so you can check what left your machine instead of taking our word for it. `intent verify` re-checks the local hash chain offline, against the root key pinned for your Intent Cloud host.

```console
$ intent verify --demo
chain: ok
  17 entries, every hash links
key statements: ok
  1 recorded, checked offline against the pinned root key
disclosures: ok
  sent: 6
  acknowledged by a receipt from the local demo Intent Cloud (demo chain, test keys): 6
  sent, not acknowledged: 0
  discarded: 0
approvals: ok
  verified: 1
approver flags: ok
  flagged: 0
self-check: skipped on request (demo mode); npm provenance and the image signature were not checked
head: seq 16 hash 96e8d697…fa40
  Compare this head with a copy of the chain taken earlier, or with your receipts.
verify: ok
```

It exits 0 when every check passes, 1 when one fails, and 2 for a usage or configuration error. On a demo chain the receipts came from the local demo Intent Cloud, and the report says so; on a real chain the line reads "acknowledged by a receipt from Intent Cloud's public edge". Without `--demo` it reads the real chain and needs the host's root key, pinned in the build or given with `--trust-keys <file>`.

## How the log is kept

Before each request to Intent Cloud, the gateway appends the exact request to the chain: the endpoint, the field names, the body bytes and their digest, and the signature parameters. A send whose append fails does not happen, so a send cannot be missing from the log (invariant 2). What came back is appended after it, and each Approval the gateway verified is appended to the same chain. The file is `<data dir>/audit.jsonl`, one JSON entry per line, each holding the hash of the one before.

`intent log` prints it one line per entry, field names only, never values. The [panel](panel.md) shows the same in a browser.

## What each check proves

| Check | What it proves | What it does not |
|---|---|---|
| `chain` | Every entry links to the one before by its hash: no entry inside the chain was changed, removed or reordered. | That entries were not dropped from the end (see below). |
| `key statements` | Each key statement recorded in the chain was signed by the pinned root key and was valid when it was recorded. | Anything about keys the chain never recorded. |
| `disclosures` | Each send has exactly one follow-up. Each receipt is signed by a receipt key from the statement and covers the digest of the bytes the log says were sent, with the same keyid, nonce and time. | What Intent Cloud did with the data after it received it. |
| `approvals` | Each Approval carries a passkey assertion over the purchase snapshot that was pending, signed by a key from the statement, from the pinned approver passkey. | That the person who holds the passkey meant to buy (see the [threat model](threat-model.md#phone-hand-off-and-self-approval)). |
| `approver flags` | Lists Approvals signed by a passkey other than the pinned approver; they were not counted as approved. | Flags do not fail verify; read them. |
| `self-check` | The installed npm package matches its published provenance, or the image matches its signature and SBOM. | That the gateway is untampered: see below. |

### Sent, acknowledged, not acknowledged, discarded

- **Acknowledged:** a receipt Intent Cloud signs at its public edge, over the digest of the bytes it received. A receipt means "received at Intent Cloud's public edge" and nothing more.
- **Sent, not acknowledged:** the request went out and no receipt came back because there was no HTTP response, or an error page made by the network in front of Intent Cloud. Verify reports it and does not fail: the field was sent, and the log says so.
- **Discarded:** a response that should have carried a valid receipt did not. The gateway did not use its content, and verify fails.

`intent verify` proves what the gateway sent and what Intent Cloud acknowledged receiving. It cannot show what happens to that data afterwards, and these docs do not claim otherwise.

## The head seq and hash

Dropping whole entries from the end of the file leaves a valid, shorter chain, so the file alone cannot show it. That needs evidence from outside the file:

- a copy of the head (`seq` and `hash`) you saved earlier: a later head must have a higher seq and a chain that still contains the old hash at the old seq;
- the receipts Intent Cloud returns, which carry the digest of each request they acknowledge, and the chained approval proofs: one with no matching entry shows the chain lost its tail.

A running gateway also refuses to append when the file is shorter than the head it last verified. Save the head line from time to time if you rely on this.

## Self-check and outside checks

The `self-check` runs inside the installed code it checks, so a tampered gateway could report anything; its output says so and names the outside checks. Run those with your own tools:

```console
$ npm audit signatures                     # in a project that installed intent-gateway
$ cosign verify \
    --certificate-identity https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v<version> \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    ghcr.io/golden007eye/intent-gateway@sha256:<digest>
$ cosign verify-attestation --type cyclonedx \
    --certificate-identity https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v<version> \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    ghcr.io/golden007eye/intent-gateway@sha256:<digest>
```

<!-- feature: signed-releases -->
!!! planned "Signed releases"
    No release has been published yet, so there is no provenance, image signature or SBOM to check. `intent verify --demo` skips the self-check unless you pass `--install npm` or `--image <ref> --version <v>`. On a build that is not published, from a clone or a packed tarball (no `build-info.json`, or the registry has no such version), there is nothing for the self-check to compare against: it reports `self-check: not run: this install is not a published release (<reason>)` and does not fail `intent verify`. Any other self-check failure still fails. `--skip-install-check` skips it for offline use, and the output says so. The first preview release ([ADR-0010](adr/0010-release-supply-chain.md)) is published with npm provenance, a keyless cosign signature and a CycloneDX SBOM.

To self-check an installed package or an image explicitly:

```console
$ intent verify --install npm [--pkg-dir <dir>]
$ intent verify --image ghcr.io/golden007eye/intent-gateway@sha256:<digest> --version <v>
```
