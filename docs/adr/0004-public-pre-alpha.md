# ADR-0004: Public from pre-alpha

Status: accepted · 2026-10-15 · amends ADR-0001

## Context

The repository was to stay private until the gateway could place a real order. Building in the open lets developers follow along, try the policy format early and contribute, which is what the project needs most at this stage.

## Decision

The repository is public while pre-alpha. The README states plainly that it is in development and not usable, and marks every unbuilt feature as planned. Real use waits for the launch criteria: a first real order, a published threat model, and live spend caps and rate limits. `SECURITY.md` is in place before the repository opens.

## Consequences

Every commit is published as it lands, so the public-safety check (ADR-0001) runs on every push to `main`. Fork and Dependabot PRs cannot read the private term list, so they skip that check and the scan on `main` covers them after merge. Outside contributors' PRs are merged by a maintainer once CI is green (ADR-0003).
