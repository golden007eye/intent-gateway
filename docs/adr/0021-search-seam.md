# ADR-0021: The search seam: the gateway searches Shop itself

Status: accepted · 2026-10-18 · Amends ADR-0017 (the Shop tool allow-list adds `search_catalog`)

## Context

Until now `find_offers` sent every search to Intent Cloud, which answered from its own catalog. The day-one plan changes the direction: Shop searches and pays, and the search runs in the developer's own gateway. The gateway goes on sending the passkey approval, the caps, Pause and the ledger to Intent Cloud, and sends no search to it. A search says a lot about a person (what they want, their budget, where it ships); the less of it reaches a service that also holds their passkey, the less there is to link.

Shop's catalog is reached with the developer's own Shop token, through the same adapter that completes one-tap purchases (ADR-0017). Its results carry no category vetted by Intent Cloud, so the excluded categories (health, age-restricted, financial and digital goods) have to be applied by the gateway itself, best effort for the invited preview.

## Decision

- **A search seam in `src/search`.** A provider interface in the gateway's own terms: the query (product text, must-haves, a budget in minor units and its currency, the country and the coarse postcode) and normalized offers (the store's myshopify domain and storefront origin, product and variant ids, titles, price in minor units and currency, availability, an image URL and a product URL). Offers from several providers are merged in provider order, with no store and variant twice. Shop is the only provider now; others plug in behind the same interface.
- **With a linked Shop wallet, nothing is sent to Intent Cloud for a search.** `find_offers` asks the Shop provider, which calls Shop's `search_catalog` through the linked wallet adapter. That request is logged before it is sent, like every Shop request (invariant 2, ADR-0014). It carries the query text, the country and the currency as context, a price ceiling and the ships-to country: the arguments S1 sent (step 5). The postcode is not sent. Without a linked wallet, `find_offers` keeps sending each search to Intent Cloud as before. Demo mode keeps the sample catalog for now (below).
- **Projection by allow-list.** `projectCatalog` copies out only the named fields of each variant. A title or URL that reads as buyer identity is dropped. URLs keep only their origin and path, so a query (a tracking id or a key) never comes through. Shop's answer is logged only as a status, a sha256 and a size (invariant 3).
- **The policy filter runs on what came back**, with the policy met with Intent Cloud's baseline, so it can only narrow (invariant 1). A store has two names: the block list drops an offer when either name matches, and the allow list keeps it only when one of them matches. The binding of a later checkout is to the myshopify domain, which a storefront host cannot change. The filter also applies the policy's blocked categories (on the searched category and on the product's own type and tags), the budget, and the per-order, daily and weekly caps. An offer not in USD is dropped, because policy v1 amounts are whole USD.
- **Excluded categories, best effort** (decision 38, answer 23). An offer is dropped when one of its category words falls under an excluded category, when a keyword list matches its title or category words (after NFKC folding, with zero-width characters removed), or when Shop says it ships nothing. This is weaker than a vetted catalog: a title that names none of the words slips through, and a harmless title that names one is dropped. A stronger check is due before any wider preview.
- **Opaque offer handles.** Each offer the agent sees gets a fresh random `of_…` handle. The gateway keeps the offer behind it, in memory: the store, the variant, quantity 1, the searched category and the ZIP. That is what the Shop checkout needs (G6). The agent sees only the title, the variant title, the storefront host, the price, availability, the image and the product page. Until G6 lands, `create_cart` refuses such a handle and sends nothing.
- **A country code under `address_country`.** Shop's search context names the country under `address_country`, a key the identity check bans by its word `address`. That one key is allowed while its value is exactly a two-letter upper-case code. Any other value, or any other key with `address` in it, is still a banned key.

## Consequences

- With a linked Shop wallet, a developer can search but cannot yet buy from a search result: a cart for a Shop offer comes with the submitted Shop checkout (G6). This is the order the plan sets (G5 before G6).
- Demo mode's linked fake Shop now answers `search_catalog` from a small catalog, so the seam runs offline in tests. The demo's `find_offers` stays on the sample catalog until G6, because the demo's carts still need offers from Intent Cloud.
- Shipping is not known at search time: an offer shows its item price, and the total appears at checkout.
- The disclosure summary of a Shop search reads `Sent: shop search_catalog (…; answered, unsigned)`, and `intent log` shows it as a `call` to Shop.
