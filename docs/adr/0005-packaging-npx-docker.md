# ADR-0005: npx first, Docker for teams

Status: accepted · 2026-10-15

## Context

Most developers who try the gateway run one MCP agent on their own machine and want it working in a minute, with no config beyond a policy file. Teams want one long-running gateway that several agents reach over the network. A gateway reachable from other machines must not accept calls from anyone who can reach its port. Until the launch criteria in ADR-0004 are met, nobody should install a build by accident and take it for a release.

## Decision

- **npx with stdio is the primary way to run the gateway.** `npx -y intent-gateway` speaks MCP over stdin and stdout. stdout carries only JSON-RPC; logs go to stderr.
- **Docker with HTTP MCP is for teams.** The image runs the same package and serves MCP over HTTP. The documented port mapping binds the host side to `127.0.0.1`.
- **A token is mandatory off loopback.** The HTTP transport refuses to start on a non-loopback address without a bearer token. The image generates one on first start and writes it to its data directory, so the user still needs nothing but a policy file. A request with a missing or wrong token gets 401; a request with a foreign `Host` or `Origin` gets 421.
- **One package, two ways to run it.** The npm package and the image are built from the same commit and contain the same `dist`; the image adds no gateway code of its own.
- **Preview channel until the launch gate.** Releases are versioned `0.1.0-preview.N` and published on the npm dist-tag `next`. Nothing is published as `latest` until the launch criteria hold.

## Consequences

The quickstart is one entry in the agent's MCP config. The HTTP transport carries an authentication path that stdio does not need, with its own tests (refusal to start without a token, 401, 421). Users opt in to the preview with `@next`, so a plain install gets nothing until the launch gate. The read-only panel binds to `127.0.0.1` inside the container, so Docker users read the log with `docker exec … intent log` instead.
