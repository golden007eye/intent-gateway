# Threat model

This page says what the gateway protects, from whom, and where its protection ends. It covers the gateway as it is built today, in demo mode and against an Intent Cloud host, including one-tap purchases with a linked Shop wallet ([One-tap purchases](one-tap.md)), which run in demo mode only until a registered Shop client exists. The rules the code is held to are the five invariants in the repository's agent guide; each section below names how one is enforced and tested. Settled design decisions are in the [ADRs](adr/0005-packaging-npx-docker.md).

To report a vulnerability, see [Security](security.md).

## Assets

| Asset | Why it matters |
|---|---|
| The buyer's identity: name, postal address, card, email, phone | Never held by the gateway; the buyer gives it to the merchant at checkout. A leak would be the worst failure. |
| The buyer's money | Spent only through one passkey Approval per purchase: paid by hand at the merchant, or, with one tap, from the linked Shop account, up to the smaller of the policy's per-order limit and the Shop budget. |
| The Shop token and the wallet key | The token can spend from the Shop account up to its budget. It is kept AES-256-GCM in `<data dir>/wallet/shop.enc`, under a key kept outside the data dir; it never enters the chain. |
| Shop checkout ids and completer keys | A checkout id can carry a credential to read that checkout (`?key=`); a completer key signs one approval's reads and outcome reports. Both are kept per purchase, on disk, and deleted when it ends. |
| The local hash chain (`<data dir>/audit.jsonl`) | The developer's proof of what left the machine and what came back. A gap or an edit makes it worthless. |
| The gateway policy and `policy.lock` | Decides what may leave and how much may be spent. A loosened policy would weaken every other control. |
| The approver pin | Which passkey the gateway accepts for Approvals. |
| The pinned root key | The one key the gateway trusts for an Intent Cloud host; every receipt and approval key is checked against the statement it signs. |
| The MCP HTTP bearer token | Off loopback, the only thing between the network and the tools. |

## Trust boundaries

| Boundary | Who is on the other side | What crosses it |
|---|---|---|
| Agent ↔ gateway (MCP, stdio or HTTP) | The agent, which is **not trusted**: it may be confused, prompt-injected or hostile. | Tool calls with search terms, a budget, a ZIP, an offer handle; results with offers, a cart and an approval link. |
| Gateway to Intent Cloud (HTTPS) | Intent Cloud's public edge, which receives the requests, reached through the network. The network is not trusted, and the gateway trusts what Intent Cloud signs only as far as the keys under the pinned root. | Signed requests whose every field is logged first; responses with a signed receipt. |
| Buyer ↔ confirm page | The buyer's own browser and passkey, on intent's confirm page. | The purchase snapshot and check code; the passkey assertion. |
| Buyer ↔ merchant | The merchant's own checkout. | Name, address and card, which never touch the gateway. |
| Gateway to Shop (HTTPS, one tap) | Shop's MCP server and account server, reached with the developer's token. Not trusted beyond what it returns: it signs no receipt. | Five allow-listed tools, a saved-address id, the checkout id and the token, every request logged first; answers kept as a status, a digest and a size, and projected to named fields. |
| Developer ↔ local files and terminal | The developer's own account. Other local users are not trusted. | The data dir (mode 700), the policy, `intent verify`, `intent approver accept`, the panel. |
| Build ↔ developer | The npm registry, GHCR and the release workflow. | The package and the image, with provenance, signature and SBOM. |

## Invariant 1: the policy can only narrow

**Threat.** A shared or edited policy turns off purchase approval, raises a limit above the baseline, allows an excluded category, or is written so that the gateway and a human reviewer read it differently.

**Controls.** Policy v1 is a strict schema: every value that could loosen the baseline is refused at load time with `POLICY_LOOSENS`, and the gateway does not start. `approval` must be `passkey`. Unknown keys, duplicate keys, YAML merge keys, alias bombs and oversized files are refused. Every loaded policy is combined with the baseline (the rules Intent Cloud enforces) by taking the stricter of each rule, and `intent policy add` writes the same combination of your policy and the library's, so adding a library policy can only tighten. Library policies are checked against their sha256 in `policies/index.json`; `--commit` also needs a signed commit on `main`. Category and merchant names are compared after Unicode and IDN normalisation, so look-alikes match the block list. Tests: `src/policy/*.test.ts`, with property tests on the combination and attack cases for each refused construct ([ADR-0009](adr/0009-policy-v1-narrow-only.md)).

## Invariant 2: log before send

**Threat.** A field leaves the machine without a log entry, or the log is changed afterwards to hide one.

**Controls.** The only path from gateway code to Intent Cloud is the disclosed cloud: it appends the exact request bytes, digest and signature parameters to the chain and only then sends. If the append fails, the send does not happen. Every other outside destination (a linked wallet) goes through the same disclosure core, with the same rule, and a failed append stops sends to every destination. Credentials (an `authorization` header, token fields in a body) are logged only as their sha256, and `intent verify` fails on a chain that holds one in clear ([ADR-0014](adr/0014-log-before-send-every-destination.md)). One writer at a time holds a fenced lease on the chain and re-checks the tail before and after each write; a writer that lost its lease, or finds the tail moved, is refused for good. The chain refuses a data dir that is not owned by the current user. `intent verify` re-checks every link offline. Tests: `src/disclosure/*.test.ts` and `src/store/*.test.ts`, including byte comparisons with what the fake Intent Cloud received, and lease fencing with a paused holder ([ADR-0007](adr/0007-local-store-jsonl.md)).

## Invariant 3: no buyer identity in the gateway

**Threat.** The agent passes the buyer's name, address, email, phone or card number to a tool, in a field or hidden inside another one, and the gateway forwards it.

**Controls.** The MCP tools take only search terms, a budget, a 5-digit ZIP and an offer handle. Every outbound body is scanned before it is logged: card numbers (Luhn, including split across fields), emails, phone numbers, street addresses and identity-named keys, after Unicode normalisation. A match blocks the send, and the log records what was blocked (field paths, never values). The tools have no field for a name, address or card; the buyer gives those to the merchant, or keeps them in their Shop account. For one tap, the gateway chooses delivery by a saved-address id and never sends address fields (a step that would need them fails, nothing sent), and it keeps from each Shop answer only named fields, dropping the rest on receipt. Tests: `src/privacy/privacy.test.ts` and the gateway's outbound privacy suite.

**Limit.** Patterns cannot detect everything. A name typed into the free text of `product` or `must_haves` (for example "a gift for Jane Doe") cannot be told apart from a product name, and neither can contact details written to dodge a pattern (for example `jane(at)example(dot)com`, or a card number spelled out in words). Such text is sent like any other search term, and the log records that it was sent. A blocked search keeps only its structured values (category, ZIP) in the local `block` entry, never the free text of `product`, for the same reason. Keep identity out of what you ask the agent to search for.

## Invariant 4: one human approval per purchase

**Threat.** A purchase goes ahead without a person: the agent approves for them, an approval is replayed for another cart, or a forged approval is accepted.

**Controls.** `create_cart` never buys; it returns an approval link. The gateway counts a purchase as approved only when the approval carries a passkey assertion over the exact purchase snapshot that was pending, signed by an approval key from the statement under the pinned root, from the [approver pin](#phone-hand-off-and-self-approval), and not used before. The check code on the confirm page is the start of the snapshot hash, so the buyer can match the cart the agent showed. Tests: the proof attack suite in `src/trust/*.test.ts` and `src/gateway/gateway.test.ts` ([ADR-0011](adr/0011-approver-pin.md)).

For one tap, the gateway sends `complete_checkout` only after it chained that verified Approval, and at most once per purchase: the send is appended to the chain only while this process owns the purchase's attempt and no earlier send for it is logged, and one that may have left is only read again, never repeated. `intent verify` fails a chain with a second `complete_checkout` for a purchase, or one before its attempt. Tests: `src/gateway/complete.test.ts`, with two processes, crashes at each step and restarts ([ADR-0019](adr/0019-one-tap-completion.md)).

## Invariant 5: claim only what was sent

**Threat.** The docs, the log or the CLI say more than the gateway can check, so a developer trusts a claim about what happens to their data after it left.

**Controls.** Output describes what the gateway sent, what Intent Cloud acknowledged receiving and what Shop returned. A receipt means "received at Intent Cloud's public edge" and nothing more; a send with no receipt is reported as "sent, not acknowledged"; a response that should have carried a receipt and did not is discarded and fails verify. A Shop answer is recorded as "answered" with its status, never as acknowledged, and an outcome read from Shop says so (`read from Shop`). A test (`scripts/claims.test.ts`) reads every sentence in the README, the docs and the CLI's strings that names Intent Cloud and fails unless it uses a verb from a short, checkable list (receives, acknowledges, returns, signs, enforces, reported) or is listed with a reason in `docs/claims-allow.txt`.

## HTTP transport and Docker

- `intent serve --http` binds to `127.0.0.1:8787` by default. Off loopback, it refuses to start without a bearer token of at least 32 characters (`INTENT_HTTP_TOKEN`). `localhost` is not treated as loopback, because it can resolve elsewhere.
- With a token, a missing or wrong `Authorization: Bearer` gets 401; the comparison is constant-time. A `Host` or `Origin` that does not name the server gets 421, so a web page cannot rebind a DNS name to `127.0.0.1` and drive the tools through the developer's browser. Bodies over 256 KiB get 413.
- On loopback without a token, any process of any user on the machine can call the tools, as with stdio for the agent's own user. The tools can search and prepare carts; they cannot approve or pay. In demo mode the local confirm page is different: see [Phone hand-off and self-approval](#phone-hand-off-and-self-approval).
- The Docker image runs the same package with no gateway code of its own, as uid 1000, which owns the `/data` volume. Inside the container it listens on `0.0.0.0:8787`, so a token is always set: the entrypoint makes a 43-character token on first start, saves it in `/data/http-token` (mode 600), and the gateway prints it once, in the line to paste, on the first start that serves (a start that fails prints no line). That line is also kept in the container's log (`docker logs`), and the gateway says so; later starts print only how to read the file, and `INTENT_QUIET_TOKEN=1` never prints the token. The docs always publish the port as `-p 127.0.0.1:8787:8787`, so it stays on the host's loopback. In demo mode the confirm page listens on port 8788 and answers only `Host 127.0.0.1:8788` ([ADR-0005](adr/0005-packaging-npx-docker.md)).

## Phone hand-off and self-approval

The agent is not trusted, and an agent with shell access on the developer's machine can try to approve its own purchases.

- **Trust on first use.** The first passkey whose Approval the gateway verifies becomes the approver pin. Its fingerprint is printed on stderr and shown in the [panel](panel.md) when the pin is created. An Approval from any other passkey is flagged: the purchase is not reported as approved, and the agent is told to have a person run `intent approver accept`.
- **A copied passkey.** The gateway records the pinned passkey's signature counter with each Approval. An Approval whose counter is not above the last recorded one is flagged and not reported as approved, as WebAuthn recommends. Many passkeys always report 0; a counter of 0 after 0 is accepted, so for them this check detects nothing.
- **`intent approver accept` needs a person at a terminal.** It refuses unless stdin and stdout are both terminals, and it asks for the flagged fingerprint, which the person compares with the panel and their passkey manager. The TTY check raises the bar but is not a guarantee. An agent that can open a pseudo-terminal can pass it.
- **If the agent goes first.** An agent that enrols its own passkey and approves before the human does becomes the pin. The signals are the fingerprint shown at creation, and the human's own passkey being flagged at their first purchase.
- **The backstop.** The approval only lets the confirm page hand the buyer to the merchant's checkout; the gateway holds no card and cannot pay. Payment by hand at the merchant is the backstop against self-approval. A self-approved cart still cannot be paid for without the human entering their payment details.
- **One tap removes that backstop.** One-tap spends without a hand at the merchant: the approver pin and the Shop budget are the backstop. With a Shop wallet linked, an agent that wins the approver pin can spend from the Shop account up to the smaller of the policy's per-order limit and the Shop budget, within the daily and weekly limits. Keep the Shop budget low, set `spend` limits, or set `completion: [handoff]` to keep the hand at the merchant.
- **The hand-off.** The approval link and QR code open intent's confirm page, on the origin named in the signed key statement. The page shows the item, merchant, total, the ZIP code and the check code; the buyer checks them against what the agent showed before using their passkey.

In demo mode the confirm page is a local stand-in for the passkey step: it signs with a software demo passkey kept on disk. Any program that can reach `127.0.0.1` can press its buttons, so it does not prove that a person approved. As a speed bump, **Approve** also needs a 6-digit demo code that the gateway prints on its own stderr and keeps in `<data dir>/demo/approval-code` (mode 600), never in a tool result: an agent that only reads tool results cannot approve, but one that can read the gateway's output or files can. After five wrong codes the page refuses approvals until the demo restarts with a new code. Nothing can be bought in demo mode. Real approvals need the buyer's passkey on intent's confirm page; see [Demo mode](demo.md).

## Local panel

**Merchant text in the terminal.** Titles and merchant names come from merchants, and the contract allows any character in them. Everything the CLI prints from the chain passes through one sanitiser (`src/ui/printable.ts`, which the panel uses too) that shows control, format and bidi characters as escapes and line breaks as `\n`, so a title cannot clear the screen, write the clipboard (OSC 52), hide a link (OSC 8) or forge a log line. Tests: `src/cli/terminal.test.ts`.

The [panel](panel.md) binds to `127.0.0.1` only, serves GET only (405 otherwise), checks `Host` (421 otherwise), loads nothing from outside under a strict Content-Security-Policy, writes chain values as text, never as HTML, and never writes the chain. It refuses to start when the data dir or a file in it can be read by other users. It shows the values each request sent, as logged: what already left the machine, never buyer identity, which the gateway does not hold.

## Supply chain

- Releases are published from GitHub Actions with npm provenance and a keyless cosign signature and CycloneDX SBOM on the image, and the image rebuilds to the same digest ([ADR-0010](adr/0010-release-supply-chain.md)). Preview releases are on npm (`next`) and GHCR.
- `intent verify` runs a **self-check** of the installed package or image. It runs inside the code it checks, so a tampered gateway could report anything; its output says so and names the outside checks to run with your own tools: `npm audit signatures`, `cosign verify` and `cosign verify-attestation`. See [Verify](verify.md#self-check-and-outside-checks).
- Runtime dependencies are few, pinned by the lockfile, at least 7 days old when added, and licence-checked. They are compiled into the package at build time ([ADR-0013](adr/0013-bundled-dependencies.md)), so an install fetches no other package and the package's provenance covers their code; a dependency fix reaches developers only with a gateway release. Gateway code may not start processes or load code dynamically, and only the modules that need the network may use it; CI enforces both.
- The demo's test keys are public. The test root key is trusted only in demo mode, it may never be pinned for an Intent Cloud host, and a demo chain never mixes with a real one.

## Known risks

These risks are known and open; no code in this repository closes them today.

- **The Shop token at rest.** The token and the checkout ids are encrypted with a key kept outside the data dir (`INTENT_WALLET_KEY_FILE`, or a generated 600 file in the config folder). Malware running as the developer's user can read both the key and the files, and then spend from the Shop account up to its budget without the gateway, its policy or its log. Against such malware the vault is obfuscation, not protection; an OS keychain is planned. `intent wallet unlink shop` asks Shop to revoke the token. A full threat model of the token store is deferred past the preview gate.
- **The legal status of the Shop route.** Whether a self-hosted gateway completing purchases from a developer's own Shop account raises custody or money-transmission questions has not had legal review. That review is pending and deferred past the preview gate; until then one tap runs in demo mode only.
- **Shop's personal-use terms.** Shop allows an agent on a shopper's own account for personal use. Use one tap with your own account only, personal use only unless authorised by Shopify. A gateway shipped to others needs its own registered Shop client; none exists yet, so one tap runs in demo mode only.
- **The store alias.** Shop names a store by its `*.myshopify.com` domain, and an offer by the storefront the buyer sees. Until the rule that maps one to the other is settled, only a store whose storefront is its own myshopify domain gets one tap; every other cart is handed off.
- **Evidence-pack completeness.** An evidence pack shows what is in it. One built by hand could leave out an entry of its purchase, such as a later outcome or a second `complete_checkout`, and still verify offline. Closing this needs the chain's head countersigned by Intent Cloud, planned for a later contract version ([Evidence pack](evidence.md#limits)).
- **A stolen completer key.** It can read one approval and race the gateway to report `completing`, which can stop that purchase; it cannot spend, which needs the Shop token. It is bounded by the cart's expiry and the contract's 48-hour read window.
- **What Shop returns.** Shop signs nothing, so an `ordered (read from Shop)` rests on Shop's answer over TLS and the gateway's binding check, not on a signature anyone can re-check later.

## Out of scope

The TLS fingerprint and the carrier-NAT tier are out of scope.

- **TLS fingerprint.** The gateway's HTTPS client has the TLS fingerprint of its Node.js runtime, the same for every gateway, so a network observer can tell gateway traffic from a browser's. The gateway does nothing to disguise it. Shopping sessions stay unlinkable by their keys, which are fresh per session.
- **Carrier-NAT tier sharing.** Intent Cloud enforces its rate limits per IP address (per /64 for IPv6), with a higher tier for an address that recently completed a passkey Approval. Behind carrier-grade NAT, one passkey user raises the tier for everyone sharing that address. Per-claimer caps are weak too, since a claimer costs nothing to create; the IP limit is the real cap.
- **Clean tail truncation.** Dropping whole entries from the end of `audit.jsonl` leaves a valid, shorter chain. It is detectable only by outside evidence: a head seq and hash saved earlier, the receipts Intent Cloud returns, or the chained approval proofs. `intent verify` prints the head for that comparison.
- **What happens after receipt.** The gateway can show what it sent and what Intent Cloud acknowledged receiving, not what is done with it afterwards.
- **A compromised developer account.** Anyone who runs code as the developer's user can read the data dir, edit the policy and pass the TTY check.
- **The merchant.** The checkout, payment and delivery are between the buyer and the merchant.
