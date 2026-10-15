# ADR-0008: A vendored copy of the public contract

Status: accepted · 2026-10-15

## Context

The gateway and Intent Cloud must agree byte for byte on request signing, receipts, approval proofs and canonical JSON. The gateway is Apache-2.0 and public, so anything it includes must be publishable under that licence. Tests run offline against a fake, so the fake must follow the same contract as the real service, and drift between the two must be caught by a test rather than found in use.

## Decision

- The gateway vendors a subset of the Intent Cloud public contract, published under Apache-2.0: the gateway API spec (`contract/gateway-api.v1.yaml`) and its test vectors (`contract/vectors/`).
- `contract/SHA256SUMS` lists the sha256 of every vendored file, with paths relative to its own directory. `contract/SOURCE.md` records the contract name, its version and the sha256 of `SHA256SUMS`. The source is described only as the Intent Cloud public contract; `SOURCE.md` holds no URL other than the public API host.
- Tests check that every file matches `SHA256SUMS`, that the spec's `info.version` equals the version in `SOURCE.md`, and that the sha256 of `SHA256SUMS` equals the one in `SOURCE.md`. Intent Cloud's `Meta` response reports `contract_sums_sha256`, and a contract test compares it with `SOURCE.md`, so drift between the copy and the live service shows as a red check.
- The vendored files change only by copying a newly published version together with its sums, never by editing them in place.

## Consequences

The wire format is the shared definition, as ADR-0002 intends: the gateway, its fake and Intent Cloud all reproduce the same vectors. The gateway builds and tests with nothing but this repository. A contract change on Intent Cloud's side reaches the gateway as a PR that updates the copy. Two copies of the public contract exist and must be kept in step, which the sums check enforces.
