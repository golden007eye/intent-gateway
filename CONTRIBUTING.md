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

### Against Intent Cloud staging

Three scenarios run the gateway for real, with no demo: a fresh data dir and the pinned staging host. They work in every mode and run only when named in `--only`.

| Scenario | Runs | What it does |
|---|---|---|
| `s` | unattended | `doctor` (contract 1.6 and the key statement), `init --yes`, a search, a hand-off cart (completion mode `handoff`, a completer key, the merchant's origin and variant from the snapshot, an exact total), still pending, four refusals that disclose nothing, no evidence before an approval, `verify` ok. The cart expires unapproved. |
| `j` | manual, `E2E_STAGING=1` | The hand-off purchase (AC-J1), described below. |
| `j2` | manual, `E2E_ONETAP=1` | The one-tap skeleton (AC-J2). It also needs `INTENT_SHOP_CLIENT_ID`, `INTENT_WALLET_KEY_FILE`, a Shop account to link and a store one tap can reach. Staging has none of these today, so it skips. |

```console
$ scripts/e2e-outsider.sh --tarball --only s
$ E2E_STAGING=1 scripts/e2e-outsider.sh --docker --only j
```

The search defaults to a tee to ZIP 07093 under $20 (`E2E_STAGING_PRODUCT`, `E2E_STAGING_CATEGORY`, `E2E_STAGING_ZIP`, `E2E_STAGING_BUDGET`). The run reads the merchant from the snapshot. A package or image built from a checkout carries a released version number but not its files, so with `--tarball` and `--docker` the scenarios run `verify --skip-install-check`. With `--npm` and `--image` they run the full `verify`.

#### Hand-off on staging (`j`)

You need an intent account on staging with its passkey on this device or your phone, and about five minutes. Nothing is charged: the staging store uses its payment provider's test gateway.

1. Run `E2E_STAGING=1 scripts/e2e-outsider.sh --docker --only j` (or `--tarball`). The clock starts at `docker run`. The script runs `intent init --yes`, then a headless Claude Code calls `find_offers` and `create_cart`.
2. The script prints an **ACTION NEEDED** box with the approval link, the check code, the ZIP and the total. Open the link. Check that the confirm page shows the same check code, ZIP and total.
3. Click **Approve with passkey** and use your intent passkey.
4. Click **Continue to … checkout**. On the merchant's checkout, enter any email (`you@example.com`), any name, a street address in the ZIP shown, and card number `1` with any future expiry (`12/30`), any CVV (`123`) and any name on the card. Pay.
5. Do nothing else. The script calls `get_approval_status` every 15 s (`E2E_J_POLL`) for up to 20 minutes (`E2E_J_WAIT`). It stops when the status says Intent Cloud reported the order in a statement the gateway verified; the wait leaves room for that report to arrive late. `intent log -v` names the source Intent Cloud gave for it. It fails at once on a rejected or expired approval, an approval that does not verify, a mismatch or an expired checkout.
6. The script then asks Claude for the status, and checks that `intent log -v` shows the ordered outcome as served and that `intent verify` counts the approval and the ordered outcome. It prints the time from start to `verify: ok`, which must be at most 300 s (`E2E_J_BUDGET`). Then `intent evidence <approval handle>` writes the pack, and `intent verify --evidence` checks it with no chain: from a fresh HOME, or in a container with no network.

Keep the summary line (time, order number, outcome source) as the AC-J1 run record.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the licence of this project.
