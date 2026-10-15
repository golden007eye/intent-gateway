# ADR-0009: Gateway policy schema v1 can only narrow

Status: accepted · 2026-10-15

## Context

A gateway policy may come from the developer or from the shared policy library. Invariant 1 says a policy can only narrow what Intent Cloud enforces, and that a policy turning purchase approval off is rejected at load time. YAML has many ways to say something a reviewer would not spot: duplicate keys, merge keys, aliases, special floats, strings with stray spaces. Combining a library policy with the developer's own must not produce anything looser than either.

## Decision

- **Schema v1 is strict.** `version: 1` is required. Unknown keys, duplicate keys and YAML merge keys (`<<:`) are rejected. Aliases are bounded, so an alias bomb fails. Files over 64 KiB are rejected. `approval` accepts only the exact value `passkey`. Spend limits must be positive whole USD amounts and `quantity.max` a whole number from 1 to 3, so `.inf`, `-1` and `0` fail (a zero limit could be read as "no limit").
- **`CLOUD_BASELINE` is the ceiling.** The gateway holds the rules Intent Cloud enforces as one constant, `CLOUD_BASELINE`: approval required, the maximum quantity, the excluded product categories. `loadPolicy` compares every field with the baseline and rejects anything looser with `POLICY_LOOSENS`. A policy cannot allow an excluded category, raise a limit or turn approval off.
- **`meet` combines policies.** `meet(a, b)` returns the narrowest policy that satisfies both: the lower of each limit, the union of each block list, the intersection of each allow list, and each `share` field at the less revealing value. `intent policy add` applies a library policy as `meet(current, library)`. A property test checks that the result is never looser than either input or the baseline.
- **Names are compared in one normal form.** A merchant is reduced to a bare ASCII hostname: NFKC, lowercase, IDN to punycode, one trailing dot dropped. A policy entry that is not a bare hostname (a scheme, port, path or empty label, or nothing left after normalization) fails to load with `POLICY_INVALID`. An offer whose merchant cannot be normalized is refused (`offer.merchant`). A category is folded the same way, with format characters dropped and whitespace collapsed. It is refused when any of its levels, or any part split on `&`, `>`, `/` or `,`, is blocked.
- **`evaluate` fails closed on bad history.** If any purchase in the history has a total that is not a finite number ≥ 0, or a time that is not a finite number, the request is refused (`history_invalid`). Order totals are counted in whole cents rounded up, so 3 × $20.004 is over a $60 cap.
- Each policy carries its own test cases, which `intent policy test` runs.

## Consequences

A policy that loads is never looser than Intent Cloud's rules, whatever its source, and adding a library policy can only tighten the gateway. The strict schema rejects some YAML that would parse elsewhere; the error names the offending key. A rule Intent Cloud adds later reaches `CLOUD_BASELINE` only with a gateway release; until then the gateway cannot narrow it further, and Intent Cloud still enforces it.
