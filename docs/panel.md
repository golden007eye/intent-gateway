# Panel

The panel is a read-only local web page over the gateway's chain. It shows the same entries as `intent log`, with the approver pin and the pending approvals, and refreshes every 5 seconds.

```console
$ intent panel --demo
panel: http://127.0.0.1:41733/ (read-only; Ctrl-C stops it)
```

Open the address it prints. `--port <n>` picks the port; without it, a free one is used. Drop `--demo` for the real chain.

## What it shows

| Section | What it holds |
|---|---|
| Chain | Whether every hash links, and the entry count, or where the chain breaks. |
| Approver pin | The fingerprint of the pinned approver passkey, and any flagged passkeys. Compare it with your passkey manager before you run `intent approver accept`. |
| Pending approvals | Each cart waiting for an Approval, with its approval link. |
| Disclosures | Each send: the endpoint, the field names sent (never values), what was blocked, and what came back (receipt, not acknowledged, discarded). |

## Why it is safe to leave open

- It binds to `127.0.0.1` only and refuses any other address.
- It never writes: there is no route that takes input, every method but GET gets 405, and it reads the chain without taking the writer's lease.
- A request whose `Host` is not the panel's own address gets 421, so a web page that rebinds a DNS name to `127.0.0.1` cannot read your log through your browser.
- It loads nothing from outside the gateway, under a strict Content-Security-Policy, with `no-store` caching and no referrer.
- It refuses to start when the data directory or a file in it can be read by other users, and says which `chmod` fixes it.

In the Docker image the panel binds to `127.0.0.1` inside the container, so read the log with `docker exec <container> intent log` instead.
