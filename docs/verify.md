# Verify

The gateway is built so you can check what left your machine instead of taking our word for it. `intent verify` re-checks the local hash chain offline, against the root key pinned for your Intent Cloud host.

```console
$ intent verify --demo
chain: ok
  22 entries, every hash links
key statements: ok
  1 recorded, checked offline against the pinned root key
disclosures: ok
  sent: 6
  acknowledged by a receipt from the local demo Intent Cloud (demo chain, test keys): 6
  sent, not acknowledged: 0
  discarded: 0
  answers summarised locally (observed, never sent): 4
approvals: ok
  verified: 1
approver flags: ok
  flagged: 0
self-check: skipped on request (demo mode); npm provenance and the image signature were not checked
head: seq 21 hash 96e8d697…fa40
  Compare this head with a copy of the chain taken earlier, or with your receipts.
verify: ok
```

It exits 0 when every check passes, 1 when one fails, and 2 for a usage or configuration error. On a demo chain the receipts came from the local demo Intent Cloud, and the report says so; on a real chain the line reads "acknowledged by a receipt from Intent Cloud's public edge". Without `--demo` it reads the real chain and needs the host's root key, pinned in the build or given with `--trust-keys <file>`.

## How the log is kept

Before each request to Intent Cloud, the gateway appends the exact request to the chain: the endpoint, the field names, the body bytes and their digest, and the signature parameters. A send whose append fails does not happen, so a send cannot be missing from the log (invariant 2). What came back is appended after it, and each Approval the gateway verified is appended to the same chain. After an answer with a verified receipt, the gateway also appends an `observed` entry, a summary of what Intent Cloud returns (the offers, the cart, the approval state; the body is not covered by the receipt) kept on this machine for `intent log`; it is never sent and never stands in for a receipt ([what came back](log.md#what-came-back)). The file is `<data dir>/audit.jsonl`, one JSON entry per line, each holding the hash of the one before.

`intent log` prints it as one line per action with the values it sent and its outcome; `intent log -v` lists every entry of each action, and `intent log --json` prints one action per line ([the log](log.md)). The [panel](panel.md) shows the entries in a browser.

## What each check proves

| Check | What it proves | What it does not |
|---|---|---|
| `chain` | Every entry links to the one before by its hash: no entry inside the chain was changed, removed or reordered. | That entries were not dropped from the end (see below). |
| `key statements` | Each key statement recorded in the chain was signed by the pinned root key and was valid when it was recorded. | Anything about keys the chain never recorded. |
| `disclosures` | Each send has at most one follow-up, and a send with none is the last of its gateway session. Each receipt is signed by a receipt key from the statement and covers the digest of the bytes the log says were sent, with the same keyid, nonce and time. Each `observed` entry has the shape of an observation, holds no buyer identity, and names an earlier send of the same endpoint whose verified receipt, with a success status, came before it; no two name the same send. A `block` entry's held-back values hold no buyer identity. | What Intent Cloud did with the data after it received it. |
| `approvals` | Each Approval carries a passkey assertion over the purchase snapshot that was pending, signed by a key from the statement, from the pinned approver passkey. | That the person who holds the passkey meant to buy (see the [threat model](threat-model.md#phone-hand-off-and-self-approval)). |
| `approver flags` | Lists Approvals signed by a passkey other than the pinned approver; they were not counted as approved. | Flags do not fail verify; read them. |
| `self-check` | The installed npm package matches its published provenance file by file, or the image matches its signature and SBOM. The package's dependencies are compiled into its `dist/`, so the check covers their code too. | That the gateway is untampered: see below. |

### Sent, acknowledged, not acknowledged, discarded

- **Acknowledged:** a receipt Intent Cloud signs at its public edge, over the digest of the bytes it received. A receipt means "received at Intent Cloud's public edge" and nothing more.
- **Sent, not acknowledged:** the request went out and no receipt came back because there was no HTTP response, or an error page made by the network in front of Intent Cloud. Verify reports it and does not fail: the field was sent, and the log says so.
- **Discarded:** a response that should have carried a valid receipt did not. The gateway did not use its content, and verify fails.
- **No answer recorded:** the gateway logged the request, may have sent it, and stopped (killed, crashed, the machine lost power, or it could not append the answer and so stopped sending) before it recorded what came back, or it is still waiting for the answer. Verify lists it as "logged, maybe sent, no answer recorded" with its seq and does not fail: it is not counted as sent or as acknowledged. `intent log`, the panel and the tool result's summary label it the same way, never as sent.

  It is accepted only as the last request of its gateway session. Each start of the gateway writes a `session` entry with a random id, and each logged request carries that id, its number in the session and the numbers of the session's earlier requests still awaiting an answer. The id is local: it is in the chain, never in what is sent. A request with no answer is a failure when a later request of the same session counts it as answered, or when a number is missing from the session: its answer, or a whole request, was cut from the chain. A chain written before requests carried their session (before this check existed) has nothing to compare, and there a request with no answer is always listed apart.

  The chain is linked by plain sha256 hashes, with no key, so anyone who can write the file can cut an answer or a request and re-hash every entry after it; verify then passes if the cut leaves the request last in its session. Such a cut changes every later hash, and so the head: compare the head with a saved copy (below).

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

The package has no `dependencies`: its runtime dependencies are compiled into `dist/` ([ADR-0013](adr/0013-bundled-dependencies.md)). So `npm audit signatures` checks one package, `intent-gateway`, and its provenance covers the bundled code with the gateway's own. The bundled packages, their versions and the SHA-512 the lockfile pins for each are listed in `dist/sbom.cdx.json`, and their licences in `dist/THIRD_PARTY_LICENSES`; both files ship in the package and in the image, and the image's signed SBOM attestation includes the same packages.

Preview releases are published from GitHub Actions ([ADR-0010](adr/0010-release-supply-chain.md)): the npm package on the `next` dist-tag with npm provenance, the image on GHCR with a keyless cosign signature and a CycloneDX SBOM attestation. `intent verify --demo` skips the self-check unless you pass `--install npm` or `--image <ref> --version <v>`. On a build that is not published, from a clone or a packed tarball (no `build-info.json`, or the registry has no such version), there is nothing for the self-check to compare against: it reports `self-check: not run: this install is not a published release (<reason>)` and does not fail `intent verify`. Any other self-check failure still fails. `--skip-install-check` skips it for offline use, and the output says so.

To self-check an installed package or an image explicitly:

```console
$ intent verify --install npm [--pkg-dir <dir>]
$ intent verify --image ghcr.io/golden007eye/intent-gateway@sha256:<digest> --version <v>
```
