<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/golden007eye/intent-gateway/main/.github/assets/intent-logo-dark.svg">
  <img alt="intent" src="https://raw.githubusercontent.com/golden007eye/intent-gateway/main/.github/assets/intent-logo-light.svg" width="160">
</picture>

**intent-gateway** is a self-hosted gateway, run with npx or Docker, that gives AI agents real shopping under a privacy policy the developer controls. It is the open-source developer channel of [intent](https://intentai.shop): the agent searches and prepares a checkout, a person approves each purchase with a passkey, and the developer's own Shop account pays.

<!-- Docs: switch to https://docs.intentai.shop once the docs site is live. -->
[Developers](https://intentai.shop/developers) · [Docs](https://github.com/golden007eye/intent-gateway/blob/main/docs/index.md) · [Security](https://github.com/golden007eye/intent-gateway/blob/main/SECURITY.md) · [Contributing](https://github.com/golden007eye/intent-gateway/blob/main/CONTRIBUTING.md)

[![licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](https://github.com/golden007eye/intent-gateway/blob/main/LICENSE)
[![ci](https://github.com/golden007eye/intent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/golden007eye/intent-gateway/actions/workflows/ci.yml)
[![npm next](https://img.shields.io/npm/v/intent-gateway/next)](https://www.npmjs.com/package/intent-gateway)

**Pre-alpha preview.** Preview releases are on npm (`intent-gateway@next`) and GHCR (`ghcr.io/golden007eye/intent-gateway`). The demo runs on your machine and needs nothing: no invite, no account. Real purchases need an invite: they go through the Intent Cloud host this preview uses by default, where approving needs an Intent Cloud passkey made at an invite-gated sign-up ([Real purchases](#real-purchases-with-an-invite)).

## Quickstart: the demo

The demo runs the whole flow on your machine with no setup: a demo Intent Cloud on `127.0.0.1` with a sample catalog and the published test keys, and a local confirm page that stands in for the passkey step. Every tool result says `DEMO: test keys, sample catalog, nothing can be bought.`

You need Node 22 LTS (22.22.2 or later), 24 LTS (24.15 or later) or 26+ and [Claude Code](https://claude.com/claude-code). Any MCP client works the same way. Node 23 and 25 are not supported; [Docker](#with-docker) needs no Node.

**1 · Add the demo gateway to Claude Code:**

```console
$ claude mcp add intent -- npx -y intent-gateway@next demo
```

If Claude Code already has an MCP server named `intent` (for example a connector added in your Claude account), use another name, `claude mcp add intent-demo -- …`, so the agent cannot pick the wrong one.

**2 · Ask for something.** Start `claude` and ask:

```text
> Find stickers to ZIP 94107 in the US, under $20, and prepare a cart for the cheapest.
```

The agent calls `find_offers`, which the gateway answers by searching the demo Shop itself, then `create_cart`, which creates the Shop checkout and submits it for approval, and shows an approval link such as `http://127.0.0.1:8788/confirm/c/…`. Open it, check the item and total, enter the demo code and click **Approve $<total> with demo passkey**. The code is six digits, new on every start and never shown to the agent; the page shows the command that reads it (`cat <data dir>/demo/approval-code`). Then ask the agent to check the approval status: it reports the purchase as approved, with the approver passkey's fingerprint, and the gateway pays it at once from the demo Shop's agent budget (one tap), so the status reads `ordered (read from Shop)`. Keep the Claude Code session open until then: the confirm page runs inside the gateway it started.

Working on a remote machine over SSH? Forward the confirm page to your laptop's browser with `ssh -L 8788:127.0.0.1:8788 <host>`. If port 8788 is taken, the demo uses another one and says so on startup; `INTENT_DEMO_CONFIRM_PORT` chooses it ([demo page](https://github.com/golden007eye/intent-gateway/blob/main/docs/demo.md#the-confirm-pages-port)).

**3 · Check what was sent:**

```console
$ npx -y intent-gateway@next verify --demo
```

It re-checks the local hash chain, every receipt Intent Cloud returns, the approval and the order, and ends with `verify: ok`. `npx -y intent-gateway@next log --demo` shows each action with the values it sent and its outcome; add `-v` for every entry, or `--json` for one action per line ([the log](https://github.com/golden007eye/intent-gateway/blob/main/docs/log.md)). The [demo page](https://github.com/golden007eye/intent-gateway/blob/main/docs/demo.md) has the details, and `npx -y intent-gateway@next demo --http` serves the demo over HTTP instead, printing the line to connect with and the demo code.

### From a clone

To run the code on `main` instead of the preview release, build the package (this needs pnpm: `corepack enable`) and use it in place of `intent-gateway@next`:

```console
$ git clone https://github.com/golden007eye/intent-gateway.git
$ cd intent-gateway
$ pnpm install && pnpm build && npm pack && mv intent-gateway-*.tgz intent-gateway.tgz
$ claude mcp add intent -- npx -y "file:$PWD/intent-gateway.tgz" demo
$ npx -y ./intent-gateway.tgz verify --demo
```

### With Docker

The image runs the same package and serves MCP over HTTP. Pull the preview from GHCR and name it `intent-gateway`, the name the commands below and the gateway's own hints use (or build it from a clone: `docker build -t intent-gateway .`):

```console
$ docker pull ghcr.io/golden007eye/intent-gateway:0.1.0-preview.6
$ docker tag ghcr.io/golden007eye/intent-gateway:0.1.0-preview.6 intent-gateway
$ docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 \
    -e INTENT_DEMO=1 -v intent-data:/data intent-gateway
$ docker logs intent
```

On its first start the container makes an HTTP token and saves it in `/data/http-token`; once the gateway is serving it prints the token once, inside the line to paste (a start that fails prints no line). That line is also kept in the container's log (`docker logs`); add `-e INTENT_QUIET_TOKEN=1` to never print it.

```console
$ claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

Later starts reuse the token without printing it; read it with `docker exec intent cat /data/http-token`. Port 8788 is the demo's confirm page and must be published on the same host port, as above. Over SSH, `ssh -L 8788:127.0.0.1:8788 <host>` is the only forward you need: the agent runs on the server and connects to 8787 there. The demo code is in `docker logs intent`, or read it with `docker exec intent cat /data/demo/approval-code`. Check what was sent with `docker exec intent intent verify --demo`.

Always publish ports as `-p 127.0.0.1:…`, never a bare `-p 8787:8787`. For a bind mount instead of a volume, add `--user "$(id -u):$(id -g)"`. Without `INTENT_DEMO=1` the container talks to the Intent Cloud host this preview uses by default, whose root key this build pins; when it cannot reach that host, it exits with a line saying so and how to re-run it in demo mode.

## Real purchases, with an invite

Real purchases go through the Intent Cloud host this preview uses by default, and they need an invite: approving needs an Intent Cloud passkey, and the sign-up that makes one is invite-gated. An invite comes with the onboarding prompt (`onboarding/claude-code.md`), which sets up each step below with you in Claude Code. The demo needs no invite and no account.

What a real purchase needs:

1. **Your Intent Cloud passkey**, made at the invite-gated sign-up. You approve every purchase with it on intent's confirm page.
2. **Your own Shop account, linked.** Shop does not accept the gateway's own client yet (a formal registration is pending), so linking needs `INTENT_SHOP_CLIENT_ID` set explicitly to a client Shop accepts, such as Shop's public client for your own agent: `INTENT_SHOP_CLIENT_ID=<client id> intent wallet link shop` (from an agent's shell, which shows output only when a command ends: `--start`, then `--finish`; see [one tap](https://github.com/golden007eye/intent-gateway/blob/main/docs/one-tap.md#linking-from-an-agents-shell)). Shop holds the card, the addresses and the budget; the gateway keeps only an encrypted token.
3. **An agent budget in the Shop app** ("Allow agent to pay", with a limit). One tap pays from that budget only.
4. **The account key**, which `intent init` makes once (`<data dir>/account-key.json`). There is one per developer: your first passkey approval pins it to you. To replace it today, move `account-key.json` aside and run `intent init` again.

What happens in one purchase:

- **Search.** With Shop linked, `find_offers` runs in the gateway, through Shop. Nothing is sent to Intent Cloud for a search.
- **Checkout.** `create_cart` creates the Shop checkout, reads it back, checks it, and submits it to Intent Cloud for passkey approval (contract 1.7.1). What leaves the gateway on that submit: the store, the item, the quantity, the totals and currency, the country and coarse postcode, a checkout reference hash, the completion mode, and two public keys (the account key and the purchase's completer key). A hand-off submit also carries Shop's checkout page link, which the log keeps only as its sha256.
- **Approval.** You check the item, total and check code on the confirm page and approve with your passkey.
- **Payment.** One tap pays from the Shop budget at once. When one tap cannot pay (the store refuses agent payment, or the budget is too low), the purchase goes to Shop's checkout page instead, and that hand-off needs a second approval: a new cart, approved again, then you pay on Shop's page.

**Limits in the preview.** Intent Cloud enforces a ceiling of $50 per order and $100 per week, and one for each other currency it lists. Suggested caps for your policy are $20 per order and $40 per week (`intent policy add per-order-20`, `intent policy add weekly-40`). Your policy can only lower the ceiling, never raise it.

**Where it ships.** The US, Canada, Australia, the UK, Ireland and the euro countries (Germany, France, the Netherlands, Spain, Italy, Belgium, Austria, Portugal and Finland), each in the currency the table Intent Cloud returns gives it. Outside the US, search needs the linked Shop wallet. Your policy stays in US dollars, and the gateway scales each limit by Intent Cloud's ceilings: $20 is CAD 28, AUD 30, GBP 16 or EUR 20. Shop agent payments outside the US are not yet checked, so a first order there may go to Shop's checkout page instead.

**The Shop budget is the only hard stop.** Any program running as you, your agent included, can read the Shop token and pay Shop directly, around the passkey, your policy, the ceiling and Pause. Keep the budget small; turning it off in the Shop app stops every agent payment.

See [One-tap purchases](https://github.com/golden007eye/intent-gateway/blob/main/docs/one-tap.md) for each step and what Shop holds.

## How privacy is verified

You can check what left your machine instead of taking our word for it.

- **Disclosure log.** The gateway appends every field it is about to send to a local hash chain before each request leaves for Intent Cloud, or for a linked Shop wallet. A send whose log append fails does not happen. Credentials, such as the Shop token, are logged only as their sha256.
- **Disclosure receipts.** Intent Cloud returns a signed receipt over the digest of the bytes it received, which the gateway matches against the log. Shop signs no receipt: the log records the status Shop returned and a sha256 and size of its answer.
- **`intent verify`** re-checks the hash chain, every receipt and every approval offline, and self-checks the installed package. Independent checks with your own tools (`npm audit signatures`, `cosign verify`) are listed in [Verify](https://github.com/golden007eye/intent-gateway/blob/main/docs/verify.md).
- **`intent evidence <approval handle>`** writes one purchase's [evidence pack](https://github.com/golden007eye/intent-gateway/blob/main/docs/evidence.md): the requests sent, their receipts, the passkey-signed approval and the outcome statements, which anyone can check offline with `intent verify --evidence <file>`.

What this does **not** cover: `intent verify` proves what the gateway sent, what Intent Cloud acknowledged receiving and what Shop returned. It makes no claim about what happens to that data afterwards. An evidence pack cannot prove offline that it holds every entry of its purchase; see the [known risks](https://github.com/golden007eye/intent-gateway/blob/main/docs/threat-model.md#known-risks).

## Stopping purchases

`intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app.

The pause holds on your machine at once, then goes to Intent Cloud through the disclosure log. `intent status` says since when purchases are paused and which ones it stopped; the panel has the same Pause button and banner. `intent resume` sends you to the confirm page's `/account`, where you resume with your passkey. Pause cannot stop a program that reads the Shop token and pays Shop directly; only turning off agent payments in the Shop app can.

## What it does not do

- It does not store or forward the buyer's name, postal address or card. Shop holds them in the buyer's Shop account; on a hand-off the buyer enters or confirms them on Shop's checkout page.
- It holds no money: no custody, no crypto wallet. With one tap, the gateway sends no payment details; Shop charges the account's agent budget.
- It cannot buy without a person. Every purchase needs one passkey-signed Approval, and a policy that turns approval off is rejected at load time.
- It does not convert currencies. A purchase is in the ship-to country's currency, and its limits are scaled, never its prices.

## Gateway policy and policy library

A gateway policy is a YAML file that decides what may leave the gateway and how much may be spent. It can only narrow the rules Intent Cloud enforces, never loosen them, including the preview ceiling of $50 per order and $100 per week. With no policy file, the bundled `zip-only` policy applies: the only ship-to detail that leaves is the country and a coarse postcode (in the US, the 5-digit ZIP).

```yaml
# policy.yaml · can only narrow the rules Intent Cloud enforces
version: 1
approval: passkey          # required; anything else is rejected
share:
  ship_to: postcode_only   # a coarse postcode (a 5-digit ZIP), never a street or name
spend:
  per_order_usd: 20        # suggested for the preview
  per_week_usd: 40
merchants:
  block: [dropship.example]
```

The policy library holds thirteen reviewed policies, bundled with the gateway. `intent policy add <name>` narrows your policy with one and shows the change as a diff first; `intent policy test <cases.yaml>` runs test cases against it. See [Gateway policy](https://github.com/golden007eye/intent-gateway/blob/main/docs/policy.md) and [Policy library](https://github.com/golden007eye/intent-gateway/blob/main/docs/policy-library.md).

## Security and threat model

The [threat model](https://github.com/golden007eye/intent-gateway/blob/main/docs/threat-model.md) lists what the gateway protects, where its trust boundaries are, and what is out of scope. To report a vulnerability, see [SECURITY.md](https://github.com/golden007eye/intent-gateway/blob/main/SECURITY.md). The rules this code is held to are listed in [CLAUDE.md](https://github.com/golden007eye/intent-gateway/blob/main/CLAUDE.md), and settled design decisions are in [docs/adr/](https://github.com/golden007eye/intent-gateway/tree/main/docs/adr/).

## Licence

Apache-2.0. See [LICENSE](https://github.com/golden007eye/intent-gateway/blob/main/LICENSE) and [NOTICE](https://github.com/golden007eye/intent-gateway/blob/main/NOTICE).
