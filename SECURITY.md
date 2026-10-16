# Security policy

intent is pre-alpha: only preview releases exist (npm `next`, GHCR), and nothing here should run against real purchases yet. Security reports are still welcome, because the design is the part that has to be right.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and what an attacker gains. We aim to acknowledge a report within 7 days and will keep you updated until it is fixed or explained.

## Scope

- In scope: everything in this repository — the gateway code, its policy handling, the disclosure log and hash chain, the build and release pipeline, and the documentation's security claims.
- Intent Cloud (the hosted service the gateway talks to) is not in this repository, but you can report issues with it through the same channel.

## What the gateway promises

The invariants in [CLAUDE.md](CLAUDE.md#invariants-never-weaken-each-one-is-why-the-gateway-exists) are the security properties we hold ourselves to. A way to break any of them is a vulnerability. A threat model will be published before the first release.
