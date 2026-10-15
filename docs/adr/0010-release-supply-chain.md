# ADR-0010: Release supply chain

Status: accepted · 2026-10-15

## Context

The gateway holds a developer's disclosure log and decides what leaves their machine, so a tampered build would defeat its purpose. Developers need to check that the package and image they run were built from this repository's source by its CI, with tools that do not take the gateway's word for it. A check the gateway runs on itself cannot prove the gateway was not tampered with.

## Decision

- **npm trusted publishing with provenance.** The release workflow publishes from GitHub Actions through npm trusted publishing (OIDC, no long-lived npm token), with a provenance attestation linking the package to the commit and the workflow run.
- **Keyless cosign signatures and a CycloneDX SBOM.** The image is signed with cosign keyless signing. The signing identity is the release workflow at the release tag, issued by GitHub's OIDC provider. A CycloneDX SBOM is attached as a signed attestation.
- **A reproducible image.** Two builds of the same commit give the same image digest. The release job rebuilds after publishing and fails if the digest differs.
- **Post-publish checks in CI.** After publishing, the release workflow checks the npm provenance, the `next` dist-tag, `cosign verify` against the expected identity and issuer, and `cosign verify-attestation --type cyclonedx`.
- **`intent verify` is a self-check.** Its artifact check reads the npm provenance and the image signature, and labels its output "self-check", because a tampered gateway could report anything. The docs name the outside checks developers run with their own tools: `npm audit signatures`, `cosign verify` and `cosign verify-attestation`.

## Consequences

No publishing secret is stored in the repository or its CI. Anyone can check where a build came from with standard tools, and the docs say which checks are independent of the gateway. The build must stay deterministic: a change that breaks reproducibility fails the release. Releases depend on GitHub Actions, npm and the public Sigstore services being available.
