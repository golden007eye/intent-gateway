# intent-gateway

intent-gateway is a self-hosted Docker gateway that gives AI agents real shopping under a privacy policy the developer controls. It is the developer channel of [intent](https://intentai.shop): the agent searches and builds carts, a person approves each purchase with a passkey, and the buyer pays on the merchant's own checkout.

!!! planned "Pre-alpha: in development, not usable yet"
    Everything marked *planned* on these pages does not exist yet. The repository holds the project's harness and CI only: there is no gateway code, Docker image, `intent` CLI or release. Commands are shown to describe the intended design, not as working instructions. Follow progress on [GitHub](https://github.com/golden007eye/intent-gateway).

## How it fits together

| Part | What it is |
|---|---|
| Gateway (`intent-gateway`) | The Docker container you run. It talks to your agent over MCP and to Intent Cloud for offers and carts. |
| Intent Cloud | The hosted service behind the gateway: product discovery, merchants, offers and carts. |
| Gateway policy (`policy.yaml`) | Your YAML rules for what may leave the gateway and how much may be spent. It can only narrow Intent Cloud's rules. |
| Approval | A buyer's passkey signature over one purchase. One per purchase; it cannot be turned off. |
| Hand-off (`continue_url`) | The buyer leaves the confirm page for the merchant's checkout and pays there. |

## What it does not do

- It does not store or forward the buyer's name, postal address or card.
- It holds no money: no custody, no crypto wallet.
- It cannot buy without a person: every purchase needs one passkey-signed Approval.
- It ships to US addresses only.

## Where to go next

- [Quickstart](quickstart.md): the planned first run, in three commands.
- [Gateway policy](policy.md): what you can restrict.
- [Verify](verify.md): how you check what left your machine.
- [Security](security.md): the threat model and how to report a vulnerability.
