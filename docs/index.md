# intent-gateway

intent-gateway is a self-hosted gateway, run with npx or Docker, that gives AI agents real shopping under a privacy policy the developer controls. It is the developer channel of [intent](https://intentai.shop): the agent searches and prepares a checkout, a person approves each purchase with a passkey, and the developer's own Shop account pays.

!!! note "Pre-alpha preview"
    Preview releases are on npm (`intent-gateway@next`) and GHCR. [Demo mode](demo.md) needs nothing: no invite, no account. Real purchases go through the Intent Cloud host this preview uses by default and need an invite: approving needs an Intent Cloud passkey, made at an invite-gated sign-up. They also need your own Shop account, linked with `INTENT_SHOP_CLIENT_ID` set explicitly, because Shop does not accept the gateway's own client yet (a formal registration is pending). Intent Cloud enforces a ceiling of $50 per order and $100 per week, and one per other currency it lists. Purchases ship to the US, Canada and Australia, outside the US through the linked Shop wallet. Anything not built yet is marked *planned*.

## How it fits together

| Part | What it is |
|---|---|
| Gateway (`intent-gateway`) | What you run, with npx or Docker. It talks to your agent over MCP, searches through your linked Shop account, and submits each checkout to Intent Cloud for approval. |
| Intent Cloud | The hosted service behind the gateway: product discovery, merchants, offers and carts. |
| Gateway policy (`policy.yaml`) | Your YAML rules for what may leave the gateway and how much may be spent. It can only narrow the rules Intent Cloud enforces, including the preview ceiling ($50 per order, $100 per week); $20 and $40 are the suggested caps. |
| Approval | A buyer's passkey signature over one purchase. One per purchase; it cannot be turned off. |
| Local hash chain | Every field the gateway sent, every receipt that came back and every verified Approval, in one file you can check with `intent verify`. |
| Search | With Shop linked, `find_offers` runs in the gateway, through Shop. Nothing is sent to Intent Cloud for a search. |
| Submitted checkout | `create_cart` creates the Shop checkout and submits it for passkey approval: the store, the item, the quantity, the totals and currency, the country and coarse postcode, a checkout reference hash, the completion mode and two public keys. |
| One tap | After the passkey Approval, the gateway pays the checkout from the Shop agent budget. See [One-tap purchases](one-tap.md). |
| Hand-off | When one tap cannot pay, the buyer pays on Shop's checkout page instead. The hand-off needs a second approval. |
| Pause | `intent pause` stops every purchase that goes through intent and isn't paid yet. For a hard stop, also turn off agent payments in the Shop app. `intent status` shows the pause; `intent resume` needs your passkey ([ADR-0023](adr/0023-pause.md)). |
| Shop wallet | The developer's own Shop account, linked with `intent wallet link shop`. Shop holds the card, the saved addresses and the budget; the gateway keeps only an encrypted token. The Shop budget is the only hard stop, because any program running as you can read the Shop token. |
| Account key | One per developer, made once by `intent init` (`<data dir>/account-key.json`); your first approval pins it. To replace it today, move `account-key.json` aside and run `intent init` again. |

## What it does not do

- It does not store or forward the buyer's name, postal address or card, with one tap or without.
- It holds no money: no custody, no crypto wallet.
- It cannot buy without a person: every purchase needs one passkey-signed Approval.
- It does not convert currencies: a purchase is in the ship-to country's currency, and only the policy's limits are scaled to it.

## Where to go next

- [Quickstart](quickstart.md): the demo, end to end, in four steps.
- [Demo mode](demo.md): what the demo runs and what it does not prove.
- [One-tap purchases](one-tap.md): real purchases with an invite, how to link Shop, what Shop holds.
- [Gateway policy](policy.md) and [Policy library](policy-library.md): what you can restrict.
- [Verify](verify.md): how you check what left your machine.
- [Panel](panel.md): the local page, read-only but for its Pause button.
- [Threat model](threat-model.md), with its [known risks](threat-model.md#known-risks), and [Security](security.md).
