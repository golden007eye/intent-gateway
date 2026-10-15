# Verify

!!! planned "Planned"
    `intent verify` does not exist yet, and neither do the disclosure log, receipts or signed images it checks. This page describes the design so it can be reviewed before it is built.

The gateway is designed so you can check what left your machine instead of taking our word for it.

```console
$ intent verify
```

`intent verify` will run three checks:

| Check | What it compares |
|---|---|
| Disclosure log | The local hash chain is intact: no entry was changed or removed. |
| Disclosure receipts | Every signed receipt from Intent Cloud matches a log entry, field for field. |
| Image | The running Docker image's signature and SBOM. |

## How the log is kept

Before each request to Intent Cloud, the gateway appends every field it is about to send to the disclosure log. A send whose log append fails does not happen, so the log has no gaps by construction. Each Approval the gateway verified is appended to the same chain, which together form the local audit trail.

## What it does not cover

`intent verify` proves what the gateway sent and what Intent Cloud acknowledged receiving. It cannot show what Intent Cloud does with that data afterwards, and these docs do not claim otherwise.
