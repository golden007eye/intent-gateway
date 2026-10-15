<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/intent-logo-dark.svg">
  <img alt="intent" src=".github/assets/intent-logo-light.svg" width="160">
</picture>

**intent-gateway** is a self-hosted Docker gateway that gives AI agents real shopping under a privacy policy the developer controls. It is the open-source developer channel of [intent](https://intentai.shop), which finds products and prepares carts that a person approves with a passkey before paying on the merchant's own checkout.

[Docs](https://docs.intentai.shop) · [intentai.shop/developers](https://intentai.shop/developers) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

[![licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![ci](https://github.com/golden007eye/intent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/golden007eye/intent-gateway/actions/workflows/ci.yml)
<!-- Release and image-signature (cosign) badges are added once a first release exists. -->

**Pre-alpha: in development, not usable yet.** Everything marked *planned* does not exist yet. Today the repository holds the project's harness and CI only: no gateway code, no Docker image, no `intent` CLI and no releases. Watch the repository or open an issue to follow along.

## Quickstart (planned)

None of these commands works yet. They show the intended shape of a first run.

```console
# 1 · run the gateway next to your agent (planned image)
$ docker run -d -p 8787:8787 -v intent-data:/data \
    ghcr.io/golden007eye/intent-gateway:0.1

# 2 · connect Claude Code over MCP (planned endpoint)
$ claude mcp add intent --transport http http://localhost:8787/mcp

# 3 · ask your agent for something
> "Find a 1 L stainless water bottle under $40"
```

The agent searches and builds carts within your gateway policy. When the buyer wants to purchase, they approve it with a passkey on their phone, on intent's confirm page, then pay on the merchant's checkout.

## How privacy is verified (planned)

The gateway is designed so that you can check what left your machine, instead of taking our word for it.

- **Disclosure log.** Before each request to Intent Cloud, the gateway appends every field it is about to send to a local hash chain. A send whose log append fails does not happen.
- **Disclosure receipts.** Intent Cloud returns a signed statement of what it received, which the gateway matches against the log.
- **`intent verify`** (planned) checks the local hash chain, matches every receipt to its log entry, and checks the Docker image signature and SBOM.

What this does **not** cover: `intent verify` proves what the gateway sent and what Intent Cloud acknowledged receiving. It cannot show what Intent Cloud does with that data afterwards.

## What it does not do

- It does not store or forward the buyer's name, postal address or card. The buyer gives those to the merchant at checkout.
- It holds no money: no custody, no crypto wallet.
- It cannot buy without a person. Every purchase needs one passkey-signed Approval, and a policy that turns approval off is rejected at load time.
- It ships to US addresses only.

## Gateway policy and policy library (planned)

A gateway policy is a YAML file that decides what may leave the gateway and how much may be spent. It can only narrow Intent Cloud's rules, never loosen them. The format below is a draft and may change.

```yaml
# policy.yaml · can only narrow Intent Cloud's rules (draft format)
version: 1
share:
  ship_to: postcode_only   # never street or name
  history: false
spend:
  per_order_usd: 60
  per_week_usd: 150
merchants:
  block: ["dropship.example"]
approval: passkey          # required; "off" is rejected
```

The policy library is a planned public, signed collection of shared gateway policies, reviewed by pull request. You would add one with `intent policy add` (planned) and check it against sample requests with `intent policy test` (planned).

## Security and threat model

The threat model will be published before the gateway is usable. To report a vulnerability, see [SECURITY.md](SECURITY.md). The rules this code is held to are listed in [CLAUDE.md](CLAUDE.md), and settled design decisions are in [docs/adr/](docs/adr/).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
