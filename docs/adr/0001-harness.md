# ADR-0001: One shared harness, public-safe from the first commit

Status: accepted · 2026-10-15

## Context

AI coding agents write most of this code and one maintainer reviews it. The repository is private now and becomes public at its launch gate, with its full history.

## Decision

- Agent instructions (`CLAUDE.md`, `AGENTS.md`), the glossary and these decision records are committed, and written so they can be published unchanged.
- Context about non-public systems lives in a gitignored overlay (`CLAUDE.local.md`, `.claude/settings.local.json`).
- A `public-safety` check fails CI when a tracked file contains a term from a private list. The list is supplied as a CI secret and a local file, so the check never publishes what it guards.
- `.claude/settings.json` denies agents the actions that are the maintainer's alone: merging and approving PRs, pushing to `main`, changing repository settings or visibility, and reading secrets.

## Consequences

Going public needs no history rewrite. Every contributor, human or agent, inherits the same rules by cloning. The private list must be kept current when a new internal name appears.
