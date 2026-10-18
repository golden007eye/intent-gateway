# intent-gateway

intent-gateway is a self-hosted gateway, run with npx or Docker, that gives AI agents real shopping under a privacy policy the developer controls. It is the developer channel of [intent](https://intentai.shop): the agent searches and builds carts, a person approves each purchase with a passkey, and the buyer pays on the merchant's own checkout.

!!! note "Pre-alpha preview"
    The gateway, the `intent` CLI and [demo mode](demo.md) work today. Preview releases are on npm (`intent-gateway@next`) and GHCR. Nothing can be bought: the preview targets the Intent Cloud staging host, and real purchases wait for the launch criteria in [ADR-0004](adr/0004-public-pre-alpha.md). Approving outside the demo needs your Intent Cloud passkey (invite-only during preview); the demo needs no invite or account. One-tap purchases run in demo mode; with your own Shop account they wait for a registered Shop client. Anything not built yet is marked *planned*.

## How it fits together

| Part | What it is |
|---|---|
| Gateway (`intent-gateway`) | What you run, with npx or Docker. It talks to your agent over MCP and to Intent Cloud for offers and carts. |
| Intent Cloud | The hosted service behind the gateway: product discovery, merchants, offers and carts. |
| Gateway policy (`policy.yaml`) | Your YAML rules for what may leave the gateway and how much may be spent. It can only narrow the rules Intent Cloud enforces. |
| Approval | A buyer's passkey signature over one purchase. One per purchase; it cannot be turned off. |
| Local hash chain | Every field the gateway sent, every receipt that came back and every verified Approval, in one file you can check with `intent verify`. |
| Hand-off | The buyer leaves the confirm page for the merchant's checkout and pays there. |
| One tap | After the passkey Approval, the gateway completes the purchase with the developer's own Shop account. Demo mode only today; see [One-tap purchases](one-tap.md). |
| Shop wallet | The developer's own Shop account, linked with `intent wallet link shop`. Shop holds the card, the saved addresses and the budget; the gateway keeps only an encrypted token. |

## What it does not do

- It does not store or forward the buyer's name, postal address or card, with one tap or without.
- It holds no money: no custody, no crypto wallet.
- It cannot buy without a person: every purchase needs one passkey-signed Approval.
- It ships to US addresses only.

## Where to go next

- [Quickstart](quickstart.md): the demo, end to end, in four steps.
- [Demo mode](demo.md): what the demo runs and what it does not prove.
- [One-tap purchases](one-tap.md): what works today, how to turn it on, what Shop holds.
- [Gateway policy](policy.md) and [Policy library](policy-library.md): what you can restrict.
- [Verify](verify.md): how you check what left your machine.
- [Panel](panel.md): the read-only local page.
- [Threat model](threat-model.md), with its [known risks](threat-model.md#known-risks), and [Security](security.md).
