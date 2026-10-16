# Contributing to intent

intent is pre-alpha and built in the open. Issues, ideas and pull requests are welcome. Much of the code is written with AI coding agents, and so can yours: [CLAUDE.md](CLAUDE.md) (also read through [AGENTS.md](AGENTS.md)) holds the rules every contributor and agent follows.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report conduct problems to support@intentai.shop; report security issues as described in [SECURITY.md](SECURITY.md).

## Set up

1. Install Node (any recent release) and pnpm (`corepack enable`). The repo's pnpm scripts run on the Node 24 that `devEngines.runtime` in `package.json` pins: `pnpm install` downloads it into `node_modules` and `pnpm <script>` uses it, whatever `node` is first on your `PATH`. Calling `node` or `npx` yourself, outside `pnpm`, still uses your own Node.
2. `pnpm install`
3. `pre-commit install` (needs [pre-commit](https://pre-commit.com) and [gitleaks](https://github.com/gitleaks/gitleaks)).
4. `pnpm check` runs everything CI runs. Done when it passes.

## Make a change

1. Open an issue first for anything larger than a fix, so we can agree on the shape.
2. Branch, change, and add tests. A change that touches one of the invariants in `CLAUDE.md` must include a test that fails if the invariant breaks.
3. Use the words in [GLOSSARY.md](GLOSSARY.md); add a term there in the same PR if you introduce one.
4. Open a pull request and fill in the template. CI must be green; a maintainer then merges it.

A significant design decision gets a short record in `docs/adr/`.

## Outsider e2e

`scripts/e2e-outsider.sh` runs the gateway the way a stranger meets it: a fresh HOME, an empty folder outside the repository, only Node, npx, Docker and a logged-in [Claude Code](https://claude.com/claude-code) on `PATH`, and the commands from the README. A headless Claude Code finds offers and prepares a cart; the script approves it on the confirm page, then checks the refusals (no demo code, a blocked category), a tampered chain, a restart and a `kill -9` mid-request. Each scenario prints PASS or FAIL with its evidence, and every log stays in the folder printed at the end.

```console
$ scripts/e2e-outsider.sh --tarball          # the package built from this checkout (npm pack)
$ scripts/e2e-outsider.sh --docker           # the image built from this checkout
$ scripts/e2e-outsider.sh --npm next         # a published version, from the registry
$ scripts/e2e-outsider.sh --image ghcr.io/golden007eye/intent-gateway:<version>
```

It is run on demand on a maintainer's machine, never in CI, because it needs a logged-in Claude Code. Every `claude` call it makes sees only the gateway under test (`--strict-mcp-config`), and the run stops if Claude reports any other MCP server. The `e2e-tester` agent (`.claude/agents/e2e-tester.md`) runs it, finds the root cause of each failure, and fixes it by pull request.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the licence of this project.
