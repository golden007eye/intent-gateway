# Gateway policy

!!! planned "Planned"
    The gateway policy is not implemented. The format below is a draft and may change before the first release.

A gateway policy (`policy.yaml`) decides what may leave the gateway and how much may be spent. It can only **narrow** Intent Cloud's rules, never loosen them: a policy that turns purchase approval off is rejected at load time with an error. This is why a policy shared through the [policy library](policy-library.md) cannot switch off a safety rule.

```yaml
# policy.yaml · can only narrow Intent Cloud's rules (draft format)
version: 1
share:
  ship_to: postcode_only   # never street or name
  history: false
spend:
  per_order_usd: 60
  per_week_usd: 150
merchants:
  block: ["dropship.example"]
approval: passkey          # required; "off" is rejected
```

## What a policy cannot do

- Turn off the passkey Approval for a purchase.
- Send the buyer's name, postal address or card: the gateway never holds them.
- Raise a limit above what Intent Cloud enforces.
