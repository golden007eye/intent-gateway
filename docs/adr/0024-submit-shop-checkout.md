# ADR-0024: Contract 1.7.0: the gateway submits the Shop checkout before the passkey

Status: accepted · 2026-10-18 · Amends ADR-0019 (where a one-tap checkout is created), ADR-0020 (contract version); relates to ADR-0021 (search seam), ADR-0022 (account key)

## Context

With the search seam (ADR-0021), a search sends nothing, so an offer from Shop search had no cart to approve: create_cart refused it. Under 1.6.1, a one-tap purchase created the Shop checkout only after the passkey (ADR-0019), so the passkey signed a cart, not the checkout that would be paid, and binding check 2 could not be a bound check in `shop_agent` mode.

Contract 1.7.0 (draft, `SHA256SUMS` sha256 `5767b726…decb5`) adds `POST /v1/checkouts`: the gateway submits a Shop checkout it created and read back, and the 201 Intent Cloud returns is a pending approval whose v4 snapshot is exactly that checkout, one completion mode per approval. 1.6.1 is frozen (`bc035ee3…10d8`) and still answered to callers that name it. A 1.7.0 gateway's carts keep v3 snapshots.

## Decision

- **The gateway speaks 1.7.0.** It vendors the tree byte for byte and sends `Intent-Contract-Version: 1.7.0` on every request; the 1.6.1 cart path is unchanged apart from the version it names.
- **create_cart for a Shop offer** creates the Shop checkout (line items only, as before), reads it back, checks it locally, then submits it, every send logged before it leaves (invariant 2). Checked locally, with nothing sent to Intent Cloud on a refusal: the checkout read back is the one created, at the offer's myshopify domain (the store it actually lives at, never a storefront Shop paired); exactly the offered variant and quantity; four totals that add up to the total (a discount or fee line is refused, never guessed); a currency the Meta currency table lists (G7, refused naming the table version), and USD, since the policy's limits are in USD and are never converted; one destination in the US, Canada or Australia whose coarse postcode is the coarse form of the ZIP the search used; the policy and its spend caps on the checkout's total.
- **Only the coarse postcode leaves.** The Shop adapter coarsens the destination (US 5 digits, CA 3 characters, AU 4 digits) and drops the full postcode; the submit carries `{country, postal_code}` in that coarse form, and binding-v2 compares coarse with coarse.
- **The completion mode is chosen before the passkey.** `shop_agent` when the policy allows one tap, Shop's checkout is open, it offers the agent budget, and the budget covers the total; otherwise `handoff` with Shop's `continue_url`, only when the policy allows it and its host is exactly `shop.app`, the checkout's myshopify domain or the store site's host (`continueUrlAllowed`, vector a4). Otherwise nothing is submitted.
- **The account key goes in every submit** (`account_key`, ADR-0022), and the snapshot must sign its thumbprint.
- **Step 7 for v4, twice.** The 201's snapshot must be a valid v4 snapshot and exactly the submitted request (vector e3), with the currency table version the gateway checked; it is checked before the `approval_pending` entry, and again when the approval is accepted. `sent` is `{contract_version: "1.7.0", checkout_request, currency_table}`.
- **After the passkey, nothing is created.** The step machine reads the submitted checkout again (`get_checkout`), runs the store pair check against `store_site`, the budget in the approved currency, and binding-v2 with check 2 bound (Appendix G), then the existing redemption rules: `completion`, `completing` report, attempt, precheck on a fresh read, one `complete_checkout`. This replaces ADR-0019's after-approval `create_checkout` for this path.
- **Refusals by code.** A 403 or 409 with `Error.code` (`one_tap_off`, `currency_unsupported`, `store_blocked`, `category_excluded`, `ceiling_order`, `ceiling_week`, `paused`) is told as one line per code. A 409 at the `completing` report refuses before anything is paid: no `complete_checkout` is ever sent, and the reason names the code.
- **Supersession.** A later submit of the same checkout in the same mode makes the earlier approval dead for the gateway too.

## Consequences

- The passkey signs the checkout that is paid: a variant, total or store swap at Shop between the submit and the completion fails binding-v2 and sends no `complete_checkout`.
- A Shop address whose ZIP differs from the search's is refused; the buyer sets the preferred address in the Shop app, or searches with its ZIP.
- A hand-off `continue_url` can carry a checkout `?key=`; it is sent to Intent Cloud, which redirects the buyer to it, and is logged as sent. Open: whether that key counts as a credential under ADR-0014.
- Evidence packs do not yet select the disclosures of a submitted checkout (they find a cart request).
