# ADR-0013: Runtime dependencies compiled into the package

Status: accepted · 2026-10-16

## Context

`npx -y intent-gateway` installs the package and then every runtime dependency: about 100 packages and 35 MB before the gateway prints anything. On a Node outside the supported range (ADR-0012), npm prints an `EBADENGINE` block for the gateway and for each Sigstore package it depends on, 35 lines on Node 22.17.1, before the gateway's own one-line message. A developer sees a wall of warnings and a slow first run. The dependencies are pinned by the lockfile and checked by CI either way; installing them separately on the developer's machine buys nothing the gateway needs.

## Decision

- **The package is one bundle.** `pnpm build` compiles `src/` and the runtime dependencies with esbuild into `dist/` (`scripts/bundle.ts`): ESM for Node 22.22, unminified so it can be read and audited, no source maps. The published `package.json` has no `dependencies`; the packages it compiles in are `devDependencies`. `engines` stays as it is.
- **The Node check runs before any dependency code.** `dist/main.js` holds only `src/main.ts` and `src/runtime`; it loads the rest (`dist/cli/index.js` and its chunks) with a dynamic import after the check passes. A test reads esbuild's metafile and fails if anything else becomes reachable from `dist/main.js` before that import.
- **Licences travel with the code.** The build writes `dist/THIRD_PARTY_LICENSES`: every bundled package with its declared licence and the full text of its licence and notice files. `pnpm licence-check` reads the bundled packages from esbuild's metafile and refuses any licence that is not Apache-2.0 compatible, including a package that declares none.
- **The SBOM names the bundled packages.** The build writes `dist/sbom.cdx.json`, a CycloneDX 1.6 SBOM of the bundled packages with the SHA-512 the lockfile pins for each, and no timestamp, so a rebuild writes the same bytes. It ships in the npm package and in the image. syft's package catalogers see only `intent-gateway` in a bundle, so the release scans the image with `--select-catalogers +sbom-cataloger`, which reads `dist/sbom.cdx.json` into the attested SBOM; the release and the CI package job fail if the scan does not list a bundled package.
- **The image copies the package's files only.** The Dockerfile's app tree is `package.json`, `dist/`, `policies/`, `contract/`, `LICENSE`, `NOTICE` and `README.md`, with no `node_modules`. The reproducibility rules of ADR-0010 stay.

## Consequences

On an unsupported Node, npx prints npm's one block for `intent-gateway` and then the gateway's one line. The first `npx` run installs one package of about 3 MB. The npm provenance of the package now covers the dependency code too, and the `intent verify` self-check compares every installed file with the published tarball, bundled code included. In exchange, `npm audit signatures` and `npm audit` on an install see only `intent-gateway`: the dependencies are checked against the SHA-512 the lockfile pins when CI installs them to build, not on the developer's machine, and a dependency fix reaches developers only with a new gateway release. SBOM and licence tools that read `node_modules` must read `dist/sbom.cdx.json` and `dist/THIRD_PARTY_LICENSES` instead. Gateway code that finds `policies/`, `contract/` or `build-info.json` relative to its own file must stay two folders below the package root in the bundle, as it is in `src/`; a test checks the bundle's layout.
