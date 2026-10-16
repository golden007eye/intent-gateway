# Releasing

A release is a version tag. Pushing `v<version>` runs [`.github/workflows/release.yml`](https://github.com/golden007eye/intent-gateway/blob/main/.github/workflows/release.yml), which publishes the npm package and the Docker image and then checks both the way a developer would ([ADR-0010](adr/0010-release-supply-chain.md)). Nothing else publishes: there is no npm token and no registry password in the repository or its CI.

## What the workflow does

| Job | What it checks or makes |
|---|---|
| gate | The tag is `v` + the `package.json` version, the tagged commit is on `main`, `pnpm check` passes and the tree stays clean. A prerelease such as `0.1.0-preview.1` gets the npm dist-tag `next`; only a plain version becomes `latest`. |
| npm | Builds, checks that `dist/build-info.json` names the tagged commit, then runs `npm publish --provenance` through npm trusted publishing (the job's GitHub OIDC token, no `NPM_TOKEN`). |
| image | Builds the image with the reproducible flags of the CI package job into an OCI archive, pushes that archive byte for byte to `ghcr.io/golden007eye/intent-gateway` as the version tag, signs the digest with `cosign sign` (keyless) and attaches a CycloneDX SBOM made by syft with `cosign attest --type cyclonedx`. |
| post-publish | `npm view intent-gateway@<v> dist.attestations.provenance`, `npm dist-tag ls`, `npm audit signatures`, `cosign verify` and `cosign verify-attestation --type cyclonedx` against the release identity, then the gateway's own self-check: `npx -y intent-gateway@<v> verify --demo --install npm` and `--image <ref> --version <v>` must each print `ok`. |
| rebuild | A fresh runner rebuilds the image from the tag and fails unless it gets the published digest. |

The signing identity, for npm provenance and for the image, is the workflow at the tag:

```text
https://github.com/golden007eye/intent-gateway/.github/workflows/release.yml@refs/tags/v<version>
```

issued by `https://token.actions.githubusercontent.com`. `intent verify` checks exactly this identity, so the workflow file keeps its name and releases come only from version tags.

The SBOM is made with [syft](https://github.com/anchore/syft) (Apache-2.0) from the pushed OCI archive, so it describes the signed digest. BuildKit's own SBOM option is not used: it writes SPDX, not CycloneDX, and it adds an attestation manifest to the image, which changes the digest a rebuild must reproduce.

## Before the first release (maintainer)

These steps need the maintainer's accounts. The workflow cannot succeed until they are done.

1. **K2: npm trusted publisher.** On npmjs.com, in the settings of the `intent-gateway` package, add a trusted publisher: GitHub Actions, owner `golden007eye`, repository `intent-gateway`, workflow `release.yml`, environment `release`. Then set publishing access to require two-factor authentication and disallow tokens. If npm offers trusted publishers only for a package that already exists, the name must be created first; ask before publishing anything by hand, because a hand-published version has no provenance.
2. **K3: the `release` environment and the image package.**
    - In the repository settings, create the environment `release`. Limit its deployments to tags matching `v*` and add the maintainer as a required reviewer, so every release waits for a human approval.
    - Add a tag ruleset so that only the maintainer can create or delete `v*` tags.
    - The first release creates the GHCR package `intent-gateway`. GHCR may create it private. If the post-publish job fails on the anonymous `cosign verify` or the image self-check, make the package public in its settings (and link it to this repository), then re-run the failed jobs. Do not re-tag.
3. **K11: the offline root key.** Intent Cloud's `cloud-root-1` root key signs the key statement every gateway checks. It is made and kept offline. Only its public JWK (`{"kty":"OKP","crv":"Ed25519","x":"…"}`) comes to this repository.

    The key is pinned (R3-8) in `PINNED_HOSTS` in `src/config/index.ts`, as `{ kid: "cloud-root-1", jwk: { kty: "OKP", crv: "Ed25519", x: "…" } }`; the shape test in `src/config/config.test.ts` refuses private fields, any other kid and the published test root. `pnpm release` refuses to release while the pin is empty.

## Release with `pnpm release`

Before `pnpm release`, the [outsider e2e](https://github.com/golden007eye/intent-gateway/blob/main/CONTRIBUTING.md#outsider-e2e) must pass on the release commit: `scripts/e2e-outsider.sh --tarball` and `scripts/e2e-outsider.sh --docker`. It needs a logged-in Claude Code, so a maintainer runs it; CI does not.

From a clean, up-to-date `main` checkout, with Node 24 and `gh` logged in:

```console
$ pnpm release --dry-run
$ pnpm release
```

`--dry-run` runs every read-only check and prints each command a real run would run; it changes nothing. A real run goes through five steps, prints a status line for each, and stops with a message that names the fix when a step fails:

1. **Preflight.** On `main`, a clean tree, local `main` equal to `origin/main`, the latest CI run on `main` green for that commit, `gh auth status` ok, Node 24.15+ or 26+, the `release` environment exists with a required reviewer, and a root key is pinned in `src/config/index.ts`.
2. **Version.** By default, the version in `package.json` while its tag `v<version>` is not on origin, else the next preview (`0.1.0-preview.1` → `0.1.0-preview.2`). `--version <v>` picks another one: it must be greater than the last tag, and a prerelease unless `--stable` is given too. A version the npm registry already lists is refused.
3. **Bump.** Only when the version is not the one in `package.json`: a branch `release/<v>` that changes only the version, a pull request, its CI, a squash merge, then `main` fast-forwarded and its CI awaited.
4. **Tag.** An annotated `v<v>` on that commit, signed when git signs tags by default (`tag.gpgSign`), pushed with `git push origin refs/tags/v<v>`. It asks `push tag v<v>? [y/N]` first; `--yes` skips the question, and without a terminal it refuses unless `--yes` is given.
5. **Watch.** It prints the release run's URL with "Approve the `release` deployment in GitHub: <url>" and follows the run. Your Approve is the only human step. At the end it prints the `npx -y intent-gateway@<dist-tag>` command, the npm dist-tags and the image reference with its digest, or, on a failure, the failed jobs and the tail of their logs.

A failed release is fixed with a new version (`0.1.0-preview.2`), never by moving a tag: npm versions cannot be republished, and the signatures name the tag. Run `pnpm release` again; it bumps to the next preview.

### By hand

When the script cannot run: change `version` in `package.json` by pull request (edit the file; the repository's hooks block `npm version`), merge it, then from an up-to-date `main`:

```console
$ git tag -a v0.1.0-preview.2 -m "intent-gateway 0.1.0-preview.2" && git push origin refs/tags/v0.1.0-preview.2
```

Approve the `release` deployment when GitHub asks.

## After the first release

- After each release, run the outsider e2e against what was published: `scripts/e2e-outsider.sh --npm next` and `scripts/e2e-outsider.sh --image ghcr.io/golden007eye/intent-gateway:<version>`.
- Record real fixtures for `src/supplychain` from the published package and image. Its tests use the Sigstore bundle format cosign is documented to write; the first release is the first real one.
- Set the repository variable `STAGING_HOST_LIVE` to `true` once the staging host is live. That turns on the daily `staging-contract` and `statement-expiry` runs. `statement-expiry` fails, with an annotation, when the key statement the staging host serves has fewer than 14 days left or does not verify against the pinned root.

## What the dry run before the first tag covered

The workflow was checked with actionlint and shellcheck. Its build steps were run locally: two image builds with the release flags gave one digest, skopeo kept that digest when copying the archive, syft wrote a CycloneDX SBOM from it, and `npm publish --dry-run` packed the package. Nothing was signed or pushed. The keyless signing, trusted publishing, the GHCR push and the post-publish checks first run on the first tag. One open risk: the image SBOM is about 1.3 MB, and the transparency log may refuse an attestation that large. If `cosign attest` fails on size, the fix is a smaller SBOM (for example, syft limited to the app's own packages), not a skipped attestation.
