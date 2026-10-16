<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/intent-logo-dark.svg">
  <img alt="intent" src=".github/assets/intent-logo-light.svg" width="160">
</picture>

**intent-gateway** is a self-hosted gateway, run with npx or Docker, that gives AI agents real shopping under a privacy policy the developer controls. It is the open-source developer channel of [intent](https://intentai.shop), which finds products and prepares carts that a person approves with a passkey before paying on the merchant's own checkout.

<!-- Docs: switch to https://docs.intentai.shop once the docs site is live. -->
[Developers](https://intentai.shop/developers) · [Docs](docs/index.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

[![licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![ci](https://github.com/golden007eye/intent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/golden007eye/intent-gateway/actions/workflows/ci.yml)
<!-- Release and image-signature (cosign) badges are added once a first release exists. -->

**Pre-alpha preview.** The gateway, the `intent` CLI and a demo mode work today, built from this repository. There is no release on npm or GHCR yet, and nothing can be bought: the first preview is built for the Intent Cloud staging host, and real purchases wait for the [launch gate](docs/adr/0004-public-pre-alpha.md).

## Quickstart: the demo

The demo runs the whole flow on your machine with no setup: a demo Intent Cloud on `127.0.0.1` with a sample catalog and the published test keys, and a local confirm page that stands in for the passkey step. Every tool result says `DEMO: test keys, sample catalog, nothing can be bought.`

You need Node 24 LTS (24.15 or later) or Node 26+, pnpm (`corepack enable`) and [Claude Code](https://claude.com/claude-code). Any MCP client works the same way.

**1 · Build the package** (until the first preview release is on npm):

```console
$ git clone https://github.com/golden007eye/intent-gateway.git
$ cd intent-gateway
$ pnpm install && pnpm build && npm pack && mv intent-gateway-*.tgz intent-gateway.tgz
```

**2 · Add the demo gateway to Claude Code**, from the same folder:

```console
$ claude mcp add intent -- npx -y "file:$PWD/intent-gateway.tgz" demo
```

If Claude Code already has an MCP server named `intent` (for example a connector added in your Claude account), use another name, `claude mcp add intent-demo -- …`, so the agent cannot pick the wrong one.

**3 · Ask for something.** Start `claude` and ask:

```text
> Find running shoes to ZIP 94103, under $200, and prepare a cart for the cheapest.
```

The agent calls `find_offers`, then `create_cart`, and shows an approval link such as `http://127.0.0.1:8788/confirm/c/…`. Open it, check the item and total, enter the demo code and click **Approve with demo passkey**. The code is six digits, new on every start and never shown to the agent; the page shows the command that reads it (`cat <data dir>/demo/approval-code`). Then ask the agent to check the approval status: it reports the purchase as approved, with the approver passkey's fingerprint. Keep the Claude Code session open until then: the confirm page runs inside the gateway it started.

Working on a remote machine over SSH? Forward the confirm page to your laptop's browser with `ssh -L 8788:127.0.0.1:8788 <host>`. If port 8788 is taken, the demo uses another one and says so on startup; `INTENT_DEMO_CONFIRM_PORT` chooses it ([demo page](docs/demo.md#the-confirm-pages-port)).

**4 · Check what was sent**, in the cloned folder:

```console
$ npx -y ./intent-gateway.tgz verify --demo
```

It re-checks the local hash chain, every receipt Intent Cloud returns and the approval, and ends with `verify: ok`. `npx -y ./intent-gateway.tgz log --demo` lists each send field by field. The [demo page](docs/demo.md) has the details, and `npx -y ./intent-gateway.tgz demo --http` serves the demo over HTTP instead, printing the line to connect with and the demo code.

### From the first preview release

Once `0.1.0-preview.1` is published, the build step goes away:

```console
$ claude mcp add intent -- npx -y intent-gateway@next demo
$ npx -y intent-gateway@next verify --demo
```

### With Docker

The image runs the same package and serves MCP over HTTP. Until the first preview release puts it on GHCR, build it from the cloned folder:

```console
$ docker build --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" -t intent-gateway .   # the build-arg is optional: it records the commit
$ docker run -d --name intent -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 \
    -e INTENT_DEMO=1 -v intent-data:/data intent-gateway
$ docker logs intent
```

On its first start the container makes an HTTP token and saves it in `/data/http-token`; once the gateway is serving it prints the token once, inside the line to paste (a start that fails prints no line). That line is also kept in the container's log (`docker logs`); add `-e INTENT_QUIET_TOKEN=1` to never print it.

```console
$ claude mcp add intent --transport http http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

Later starts reuse the token without printing it; read it with `docker exec intent cat /data/http-token`. Port 8788 is the demo's confirm page and must be published on the same host port, as above. Over SSH, `ssh -L 8788:127.0.0.1:8788 <host>` is the only forward you need: the agent runs on the server and connects to 8787 there. The demo code is in `docker logs intent`, or read it with `docker exec intent cat /data/demo/approval-code`. Check what was sent with `docker exec intent intent verify --demo`.

Always publish ports as `-p 127.0.0.1:…`, never a bare `-p 8787:8787`. For a bind mount instead of a volume, add `--user "$(id -u):$(id -g)"`. Without `INTENT_DEMO=1` the container talks to the Intent Cloud staging host, whose root key this build pins; until that host is open, it exits with a line saying so and how to re-run it in demo mode.

## Real purchases

Not yet. The preview gateway talks to Intent Cloud staging and pins its root key, but the staging host is not open yet: `intent serve` without `--demo` stops with a line saying it cannot reach the host and the next step to take. Real purchases wait for the [launch gate](docs/adr/0004-public-pre-alpha.md). When they arrive, the buyer still approves each purchase with their own passkey on intent's confirm page and pays on the merchant's checkout.

## How privacy is verified

You can check what left your machine instead of taking our word for it.

- **Disclosure log.** The gateway appends every field it is about to send to a local hash chain before each request leaves for Intent Cloud. A send whose log append fails does not happen.
- **Disclosure receipts.** Intent Cloud returns a signed receipt over the digest of the bytes it received, which the gateway matches against the log.
- **`intent verify`** re-checks the hash chain, every receipt and every approval offline, and self-checks the installed package. Independent checks with your own tools (`npm audit signatures`, `cosign verify`) are listed in [Verify](docs/verify.md).

What this does **not** cover: `intent verify` proves what the gateway sent and what Intent Cloud acknowledged receiving. It makes no claim about what happens to that data afterwards.

## What it does not do

- It does not store or forward the buyer's name, postal address or card. The buyer gives those to the merchant at checkout.
- It holds no money: no custody, no crypto wallet.
- It cannot buy without a person. Every purchase needs one passkey-signed Approval, and a policy that turns approval off is rejected at load time.
- It ships to US addresses only.

## Gateway policy and policy library

A gateway policy is a YAML file that decides what may leave the gateway and how much may be spent. It can only narrow the rules Intent Cloud enforces, never loosen them. With no policy file, the bundled `zip-only` policy applies: the only ship-to detail that leaves is a 5-digit ZIP.

```yaml
# policy.yaml · can only narrow the rules Intent Cloud enforces
version: 1
approval: passkey          # required; anything else is rejected
share:
  ship_to: postcode_only   # a 5-digit ZIP, never a street or name
spend:
  per_order_usd: 60
  per_week_usd: 150
merchants:
  block: [dropship.example]
```

The policy library holds ten reviewed policies, bundled with the gateway. `intent policy add <name>` narrows your policy with one and shows the change as a diff first; `intent policy test <cases.yaml>` runs test cases against it. See [Gateway policy](docs/policy.md) and [Policy library](docs/policy-library.md).

## Security and threat model

The [threat model](docs/threat-model.md) lists what the gateway protects, where its trust boundaries are, and what is out of scope. To report a vulnerability, see [SECURITY.md](SECURITY.md). The rules this code is held to are listed in [CLAUDE.md](CLAUDE.md), and settled design decisions are in [docs/adr/](docs/adr/).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
