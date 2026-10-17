# intent-gateway — Agent & Human Shipyard

The gateway is a self-hosted gateway you run with npx or Docker. Agents reach it over MCP; it reaches Intent Cloud for offers and carts. The repository is public (pre-alpha, ADR-0004): anyone can read every committed file and the full history.

## Invariants (never weaken; each one is why the gateway exists)

1. **The policy can only narrow.** A gateway policy decides what leaves the gateway and how much may be spent; it never loosens a rule Intent Cloud enforces. A policy that turns purchase approval off is rejected at load time with an error. Why: a shared library policy must not be able to switch off a safety rule.
2. **Log before send.** Every field sent to Intent Cloud or any other outside destination (a linked wallet) is appended to the local hash chain before the request leaves, in exact bytes except credentials, which are kept only as their sha256 (ADR-0014). A send whose log append failed does not happen, to any destination. Why: the disclosure log is the developer's proof of what left the machine; a gap makes it worthless, and a credential in it would leak with it.
3. **No buyer identity in the gateway.** The gateway never stores or forwards the buyer's name, postal address or card. The buyer gives those to the merchant at checkout. Why: what we never hold, we cannot leak.
4. **One human approval per purchase.** A purchase proceeds only with a passkey-signed Approval that the gateway has verified and chained. Why: agents search freely; spending is always a human act.
5. **Claim only what was sent.** Docs, logs and CLI output say what the gateway sent and what Intent Cloud acknowledged receiving, never what Intent Cloud does afterwards. Why: privacy claims must be checkable by the developer.

A change that touches an invariant carries a test that fails if the invariant breaks, including an attack case.

## Project conventions

- TypeScript strict, ESM only, pnpm (ADR-0002).
- One module = one folder under `src/` with an `index.ts` that is its only public interface; other modules import only that file (`pnpm boundaries` enforces it). Why: modules stay separable and agents cannot tangle them.
- Each outside system (Intent Cloud, the merchant checkout) sits behind one adapter in our own terms, with a fake used by tests. Why: tests run offline and a provider changes in one place.
- Runtime dependencies must carry a licence compatible with Apache-2.0 (`pnpm licence-check`), because the gateway ships under Apache-2.0. They are compiled into `dist/` (ADR-0013), so add them with `pnpm add -D`; the published package has no `dependencies`.

## Keeping the repo public-safe

- Committed files mention only public names: the gateway, Intent Cloud, its public API host, the confirm page. Internal service names, hosts, repos and people belong in `CLAUDE.local.md`. Why: the repository and its full history are public.
- `pnpm public-safety` (also a pre-commit hook and a CI job) fails on any tracked file containing a term from the private list: CI secret `PRIVATE_TERMS`, locally `~/.config/intent-gateway/private-terms`. Without either it skips locally (contributors have no list) and fails in CI. When it fails, move the content to `CLAUDE.local.md`; the fix is never to edit the check or the list.

## Shared background

- Glossary: `GLOSSARY.md`. On term conflicts `GLOSSARY.md` wins; record a new term in the same PR that introduces it.
- Decision records: `docs/adr/`, one file per settled decision, numbered.
- Private overlay: `CLAUDE.local.md` (gitignored; headings in `CLAUDE.local.md.example`). Read it when you need context about Intent Cloud internals or the wider project.

## Agent guide

1. Work follows plan → execute → review → verify; review is a separate pass from writing.
2. Every change lands by pull request on a branch. When every required CI check is green, the author (agent or human) merges it with `gh pr merge --squash` (ADR-0003). The `main-protection` ruleset on GitHub (PR required, squash-only, signed commits, CI green) is the real control; `.claude/settings.json` only stops agents from trying anything else.
3. Before opening a PR, run `pnpm check` and fill in the PR template, including the public-safe box. Done = `pnpm check` passes, template complete, CI green.

Tooling gotchas: pnpm scripts run on the Node 24 that `devEngines.runtime` pins, whatever `node` is on `PATH`; a bare `node` or `npx` does not, and dependency-cruiser refuses odd-numbered Node releases, so call it through `pnpm boundaries`. Run `pre-commit install` once per clone.
