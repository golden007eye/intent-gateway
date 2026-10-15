# intent-gateway — Agent & Human Shipyard

The gateway is a self-hosted Docker container. Agents reach it over MCP; it reaches Intent Cloud for offers and carts. Everything in this repository is written to be published: the repo goes public at its launch gate, so a file that is safe to commit is a file that is safe to show the world.

## Invariants (never weaken; each one is why the gateway exists)

1. **The policy can only narrow.** A gateway policy decides what leaves the gateway and how much may be spent; it never loosens a rule Intent Cloud enforces. A policy that turns purchase approval off is rejected at load time with an error. Why: a shared library policy must not be able to switch off a safety rule.
2. **Log before send.** Every field sent to Intent Cloud is appended to the local hash chain before the request leaves. A send whose log append failed does not happen. Why: the disclosure log is the developer's proof of what left the machine; a gap makes it worthless.
3. **No buyer identity in the gateway.** The gateway never stores or forwards the buyer's name, postal address or card. The buyer gives those to the merchant at checkout. Why: what we never hold, we cannot leak.
4. **One human approval per purchase.** A purchase proceeds only with a passkey-signed Approval that the gateway has verified and chained. Why: agents search freely; spending is always a human act.
5. **Claim only what was sent.** Docs, logs and CLI output say what the gateway sent and what Intent Cloud acknowledged receiving, never what Intent Cloud does afterwards. Why: privacy claims must be checkable by the developer.

A change that touches an invariant carries a test that fails if the invariant breaks, including an attack case.

## Project conventions

- TypeScript strict, ESM only, pnpm. Node version is pinned in `.node-version`.
- One module = one folder under `src/` with an `index.ts` that is its only public interface. Importing another module's internals fails CI (dependency-cruiser). Why: modules stay separable and agents cannot tangle them.
- Each outside system (Intent Cloud, the merchant checkout) sits behind one adapter in our own terms, with a fake used by tests. Why: tests run offline and a provider changes in one place.
- Runtime dependencies must carry a licence compatible with Apache-2.0; CI checks this.

## Keeping the repo public-safe

- Committed files mention only public names: the gateway, Intent Cloud, its public API host, the confirm page. Internal service names, hosts, repos and people belong in `CLAUDE.local.md`. Why: the history is published as-is at launch.
- The `public-safety` check fails on any tracked file that contains a term from the private list (CI secret `PRIVATE_TERMS`; locally `~/.config/intent-gateway/private-terms`). When it fails, move the content to the local overlay; never edit the check to pass.

## Shared background

- Glossary: `GLOSSARY.md`. On term conflicts `GLOSSARY.md` wins; record a new term in the same PR that introduces it.
- Decision records: `docs/adr/`, one file per settled decision, numbered.
- Private overlay: `CLAUDE.local.md` (gitignored; headings in `CLAUDE.local.md.example`). Read it when you need context about Intent Cloud internals or the wider project.

## Agent guide

1. Work follows plan → execute → review → verify; review is a separate pass from writing.
2. Every change lands by pull request on a branch; `main` is protected (squash-only, signed, CI required). The maintainer approves and merges.
3. Before opening a PR, run `pnpm check` (once the toolchain exists) and fill in the PR template, including the public-safe box. Done = template complete and CI green.
