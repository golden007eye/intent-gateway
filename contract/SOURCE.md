# Source of the vendored contract

The files in this directory are the Intent Cloud public contract, copied byte for byte. Do not edit them; replace them with a new published version instead.

- Contract: the Intent Cloud public contract
- Version: 1.5.0
- sha256 of `SHA256SUMS`: `c6fc6ffea8b7cb9053a74e0a3aa340d73d1c2800fcc4c47669707400d06410d2`
- Licence: Apache-2.0 (`LICENSE` in this directory)

`SHA256SUMS` lists every contract file except `LICENSE` and itself, with paths relative to this directory. `src/contract/vendored.test.ts` checks each listed hash, that the listed set equals the files present, that the sha256 above matches `SHA256SUMS`, and that the spec's `info.version` equals the version above.

Intent Cloud reports the same sha256 as `contract_sums_sha256` from `GET /v1/meta` at https://staging-api.intentai.shop, so a running host can be checked against this copy.
