# Appendix B: Approval ledger (normative)

Contract version 1.7.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vectors: `vectors/b1-ledger.json` and `vectors/b2-ledger-outcome.json`.

## Entry
`E = {seq, prev_hash, approval, event, snapshot_hash, credential_id?, rule_version, recorded_at}`.
- `seq` starts at 1 and increases by 1.
- `prev_hash` of the first entry is 64 × `"0"`. For every later entry it is the previous `entry_hash`.
- `credential_id` is present when a passkey assertion produced the event.

`entry_hash = hex(SHA-256(JCS(E)))`, using the same JCS profile as Appendix A.

## Storage and verification
- The ledger is append-only and kept by Intent Cloud.
- Each entry is stored with what is needed to reproduce the approval (the passkey signature, `authenticator_data`, `client_data_json` and the version of the signing statement the confirm page showed), outside the hash.
- Verification walks the chain. A missing, altered or reordered entry is reported by the `seq` of the first broken entry.
- An approval proof (Appendix E) names its `approved` entry by `seq` and `entry_hash`. The gateway records them; it cannot recompute `entry_hash`, because it does not see `prev_hash`.

## Events (1.6.0)
The entry shape is unchanged. `event` is one of `pending`, `approved`, `rejected`, `expired`, `handed_off`, `ordered`, and from 1.6.0 `completing` and the outcome events `outcome:ordered`, `outcome:mismatch`, `outcome:failed`, `outcome:checkout_expired`, `outcome:indeterminate`, `outcome:reported` (Appendix G). Outcome events carry `rule_version: "binding-v1"`; the approval events, `handed_off` and `completing` included, carry the snapshot's rule version (`recheck-v1`). Vector: `vectors/b2-ledger-outcome.json`.

## Events (1.7.0)
The entry shape is unchanged. Every entry of an approval with a v4 snapshot (Appendix A) records, beside the entry and outside its hash, the version of the currency table the approval was checked against; the hash binds it anyway, through `snapshot_hash`, since the v4 snapshot signs `currency_table`. Its outcome events carry `rule_version: "binding-v2"` (Appendix G).
