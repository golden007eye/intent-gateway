# Contributing to intent

intent is pre-alpha and built in the open. Issues, ideas and pull requests are welcome. Much of the code is written with AI coding agents, and so can yours: [CLAUDE.md](CLAUDE.md) (also read through [AGENTS.md](AGENTS.md)) holds the rules every contributor and agent follows.

## Set up

1. Install Node 24 (see `.node-version`) and pnpm (`corepack enable`).
2. `pnpm install`
3. `pre-commit install` (needs [pre-commit](https://pre-commit.com) and [gitleaks](https://github.com/gitleaks/gitleaks)).
4. `pnpm check` runs everything CI runs. Done when it passes.

## Make a change

1. Open an issue first for anything larger than a fix, so we can agree on the shape.
2. Branch, change, and add tests. A change that touches one of the invariants in `CLAUDE.md` must include a test that fails if the invariant breaks.
3. Use the words in [GLOSSARY.md](GLOSSARY.md); add a term there in the same PR if you introduce one.
4. Open a pull request and fill in the template. CI must be green; a maintainer then merges it.

A significant design decision gets a short record in `docs/adr/`.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the licence of this project.
