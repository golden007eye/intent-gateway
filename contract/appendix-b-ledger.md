# Appendix B: Approval ledger (normative)

Contract version 1.0.0. Published under Apache-2.0 as part of the Intent Cloud public contract. Vector: `vectors/b1-ledger.json`.

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
