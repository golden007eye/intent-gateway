# ADR-0012: The Node releases the gateway runs on

Status: accepted · 2026-10-16

## Context

Developers run `npx -y intent-gateway` on whatever Node they have, and ADR-0002 picked only the Node the repo builds on. On 2026-10-16 the Node lines still supported upstream are 22 (maintenance LTS until April 2027), 24 (LTS) and 26 (LTS from October 2026); 20 and 25 have reached end of life. The gateway's own code needs nothing newer than Node 22. `intent verify` checks Sigstore bundles with `@sigstore/bundle` 5, `@sigstore/tuf` 5 and `@sigstore/verify` 4, whose `engines` is `^22.22.2 || ^24.15.0 || >=26.0.0`; on any other Node, npm prints an `EBADENGINE` warning for each of them at install. Their previous majors accept Node 20.17 and 22.9, but they lack fixes made only in the current majors: transparency-log entries counted once toward the threshold (`@sigstore/verify` 4.1.1), hardened checkpoint parsing (4.1.2) and DSSE bundles with Rekor v2 entries (4.1.0).

## Decision

- **The supported range is `^22.22.2 || ^24.15.0 || >=26.0.0`**, the Sigstore floor, in package.json `engines`. We keep the current Sigstore majors rather than buy a lower floor with weaker verification.
- **Outside the range the gateway does not start.** `src/main.ts` checks the running Node before it loads anything else, prints one line naming the range and how to upgrade, and exits 1. `intent doctor` reports the same range.
- **The repo builds on Node 24** (`.node-version`, `devEngines.runtime`), and the package and image are built there. CI runs the tests and the packed tarball on 22.22.2, the latest 22, 24 and 26 (`node-compat`), and checks the one-line refusal on 22.17.1 (`node-floor`).

## Consequences

A developer on Node 22 older than 22.22.2, on 24 older than 24.15, or on 25 must upgrade first; the line they get says how. Node 25, an odd release past its end of life, is refused even though the gateway's code would run on it, because the Sigstore packages do not support it. When the Sigstore packages lower or raise their floor, `engines`, `src/runtime` and the CI matrix move with them.
