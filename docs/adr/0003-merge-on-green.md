# ADR-0003: Merge on green CI

Status: accepted · 2026-10-15 · amends ADR-0001

## Context

The project is built fast, mostly by AI coding agents, and is meant to be easy for new contributors to join. Waiting for a maintainer to press merge on every green PR slows both.

## Decision

A pull request is merged by its author with `gh pr merge --squash` as soon as every required CI check is green. No approving review is required. The `main-protection` ruleset enforces the gate: a PR, squash-only, signed commits, and the required checks. Agents remain denied approving PRs, pushing to `main`, and changing repository settings or visibility.

## Consequences

CI is the review gate, so a rule worth keeping must be a check, not a convention. A change to an invariant in `CLAUDE.md` ships with a test that fails if the invariant breaks. The maintainer reviews after merge and reverts by PR when needed.
