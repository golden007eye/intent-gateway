# Policy library

The policy library is a public collection of [gateway policies](policy.md), reviewed by pull request in the gateway repository's `policies/` folder and bundled with every build. Because a gateway policy can only narrow the rules Intent Cloud enforces, adding a library policy can make your gateway stricter but never looser.

## The library policies

The ten seed policies, and three that the [policy advisor](#the-policy-advisor) uses (`per-order-20`, `weekly-40`, `handoff-only`):

| Name | What it does |
|---|---|
| `zip-only` | Shares only the country and a coarse postcode (in the US, the 5-digit ZIP) as the ship-to location. The default when there is no policy file. |
| `strict-default` | Shares no ship-to at all; one item; at most $50 per order, $75 per day and $150 per week; blocks `dropship.example`. It sends no ZIP code, so the gateway blocks every search (`find_offers`) before sending and no cart can be made: agents see every search blocked. Use it only to lock a gateway down; `policy add`, `policy show` and `doctor` all say so. To search again, delete `policy.yaml` and add a policy that keeps the ZIP, such as `per-order-60`. |
| `per-order-60` | Refuses a cart over $60 (price × quantity). |
| `per-order-20` | Refuses a cart over $20 (price × quantity): the per-order limit the policy advisor suggests. |
| `daily-40` | Refuses a cart that would take approved purchases in the last 24 hours above $40. |
| `weekly-150` | Refuses a cart that would take approved purchases in the last 7 days above $150. |
| `weekly-40` | Refuses a cart that would take approved purchases in the last 7 days above $40: the weekly limit the policy advisor suggests. |
| `handoff-only` | Allows the hand-off completion mode only, so no purchase is completed in one tap. |
| `one-item` | One item per cart; the baseline allows 3. |
| `gifts-under-30` | One item at up to $30. |
| `no-electronics` | Blocks the `electronics` category and its subcategories. |
| `block-dropship` | Blocks the placeholder merchants `dropship.example` and `resale.example`; replace them with your own. |
| `no-history` | States that no history is shared. Policy v1 never shares history, so it changes nothing today. |

Each one is a folder with `policy.yaml`, a `README.md` and a `cases.yaml` that `intent policy test` runs. `policies/index.json` lists the sha256 of every `policy.yaml`.

## `intent policy add`

```console
$ intent policy add per-order-60
```

`add` computes the narrowest combination of your current policy and the library policy, the lower of each limit and both block lists, and shows the change as a diff before writing anything:

```diff
policy add one-item, from the library bundled with this gateway (commit 51ddb39…), into ~/.local/share/intent-gateway/policy.yaml:
  version: 1
  share:
    ship_to: postcode_only
    history: false
  spend:
    per_order_usd: 60
  quantity:
-   max: 3
+   max: 1
  ...
Apply this change? [y/N]
```

- At a terminal it asks before writing; anything but `y` writes nothing.
- When stdin is not a terminal (an agent, a script, CI) it refuses with `re-run with --yes to apply it`. `--yes` (or `-y`) applies the change without asking, after printing the same diff.
- With no policy file yet, the diff shows the whole new file.
- If your policy is already at least as strict, it says `no change` and only records the policy in `policy.lock`.
- A running gateway reads its policy at start, so restart it afterwards.

`add` checks the library policy's sha256 against `policies/index.json` before using it, and refuses a build from source with no recorded commit.

### From a later library commit

```console
$ intent policy add no-electronics --commit <40-hex commit sha> --yes
```

`--commit` fetches the policy from that commit of the gateway repository on GitHub instead of the bundled copy. The commit must be signed and on `main`, and the policy must match that commit's `index.json`.

## `policy.lock`

`add` writes `policy.lock` beside `policy.yaml`. It records the library policy last applied: its name, the commit it came from, its source (`bundled` or `github`), the sha256 of the library's `policy.yaml`, and `policy_sha256`, the hash of the `policy.yaml` it wrote. `intent policy show` prints it and exits 1 when the lock no longer matches the file, for example after a hand edit.

## `intent policy test`

```console
$ intent policy test cases.yaml
```

Runs a `cases.yaml` against the active policy, or against another file with `--policy <file>`. The format is in [Gateway policy](policy.md#test-cases).

## The policy advisor

The npm package ships a Claude Code skill, `onboarding/skills/policy-advisor/SKILL.md`, which the [onboarding prompt](https://github.com/golden007eye/intent-gateway/blob/main/onboarding/claude-code.md) copies into your project's `.claude/skills/`. When there is no policy file it applies the default limits ($20 per order, $40 per 7 days); it never applies them again to your file. It shows your policy on the panel's Policy view and changes it only when you ask, showing each change as a diff first, with `intent policy add` only; to loosen a limit it removes `policy.yaml` and `policy.lock` and adds back the limits you want. Then it runs `intent policy test`.

## Proposing a policy

Open a pull request that adds a folder under `policies/` with `policy.yaml`, `README.md` and `cases.yaml`, its sha256 in `policies/index.json`, and its name in `src/policy/library-seeds.test.ts`. CI loads it, refuses it if it would loosen the baseline, checks the sha256 and runs its cases.
