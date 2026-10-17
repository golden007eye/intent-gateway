# Panel

The panel is a read-only local web page over the gateway's chain: what the gateway sent, what came back, what waits for your approval and the rules it runs under. It refreshes itself every few seconds.

```console
$ intent panel --demo
panel: http://127.0.0.1:41733/ (read-only; Ctrl-C stops it)
```

Open the address it prints. `--port <n>` picks the port; without it, a free one is used. Drop `--demo` for the real chain. The brand bar shows **DEMO** on the demo chain and **REAL** on yours.

## Views

The side navigation (a row of tabs on a narrow window) switches between six views. Each view has its own address, so you can bookmark or share a view on your own machine, and the browser's back button works. The Approvals tab shows how many approvals wait for you.

| View | Address | What it shows |
|---|---|---|
| Overview | `#/overview` | Four cards: approved in the last 24 hours against your policy's daily limit; approvals waiting for you, with a link to the approval page; requests sent to Intent Cloud, split into acknowledged by a signed receipt, no receipt, logged and maybe sent, and not sent, then each wallet destination apart ("Also sent to Shop: 2 (2 answered, unsigned)": a wallet answers, it signs no receipt); requests refused before sending, with the reason. Below them: the latest activity, a summary of your rules and approver pin, and the last server log entries. |
| Purchases | `#/purchases` | Each purchase as four steps: Search, Cart, Your approval, Agent checked, each marked done, waiting, failed or not yet. A step's **Details** opens a drawer (`#/purchases/a-<seq>`) with exactly the fields that left your machine and their values, the line "Never sent: your name, postal address and card", what came back (status and receipt key), the request's digest and its seq range. Refused requests are listed below the purchases. |
| Approvals | `#/approvals` | Approvals waiting for you, each with **Open approval page**; approved and expired ones; the pinned approver passkey's fingerprint and any flagged passkey. Compare the fingerprint with your passkey manager before you run `intent approver accept`. |
| Policy | `#/policy` | The active policy, rule by rule, and where it came from (your policy file, or the bundled default). A policy can only narrow the rules Intent Cloud enforces. |
| Server log | `#/log` | The full local chain, entry by entry. Open an entry to see its body field by field, with its `prev` and `hash`. Filter by kind or by any text (a field, a value, a seq); the filter is kept in the address (`#/log?kind=disclosure&q=94103`). |
| Verify | `#/verify` | The result of the same chain checks as `intent verify`: the hash links, the key statements, every receipt and every approval proof, with the head seq and hash. The panel runs them again whenever the chain changes. It skips the install self-check; run `intent verify` for that. |

The values the drawers and the server log show are the ones the gateway already sent and logged: a search's category, budget and ZIP code, a cart's offer and quantity. The gateway never holds your name, postal address or card, so the panel cannot show them.

The activity feed also lists each call to a wallet destination (`Shop get_checkout · answered 200, unsigned`), each wallet change (`Shop wallet linked`, `Shop wallet unlinked · token revoked at Shop`, or `token not revoked (deleted here only)`), each Shop check (`Shop wallet checked · Shop reported 3 orders since 2026-10-10 · 2 not matched to a purchase in this log (21.49 USD)`, a warning when any order is unmatched; see [orders the log does not name](log.md#orders-the-log-does-not-name)), and each request refused before sending, with its reason and "nothing sent": a policy rule, buyer identity (never its value), or a request the gateway would not log as it was. A credential shows as `redacted (sha256 1a2b3c4d…)`, never as its value.

## Why it is safe to leave open

- It binds to `127.0.0.1` only and refuses any other address.
- It never writes: there is no route that takes input, every method but GET gets 405, and it reads the chain without taking the writer's lease. Verify runs read-only, offline.
- A request whose `Host` is not the panel's own address gets 421, so a web page that rebinds a DNS name to `127.0.0.1` cannot read your log through your browser.
- It loads nothing from outside the gateway: no font, image or script from elsewhere, under a strict Content-Security-Policy (`default-src 'none'`, its own script and stylesheet only, no inline script or style, no images, no forms, no framing), with `no-store` caching and no referrer. The only outside link is the approval page, which opens only when you click it.
- Every value from the chain is written as text, never as markup, and an approval link that is not `http` or `https` is shown as text, not as a link.
- It refuses to start when the data directory or a file in it can be read by other users, and says which `chmod` fixes it.

Without JavaScript the page still works: every view is listed one after another, the navigation links scroll to them, and the details drawers open from their links. It does not refresh itself then; reload it.

In the Docker image the panel binds to `127.0.0.1` inside the container, so read the log with `docker exec <container> intent log` instead.
