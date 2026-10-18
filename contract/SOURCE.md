# Source of the vendored contract

The files in this directory are the Intent Cloud public contract, copied byte for byte. Do not edit them; replace them with a new published version instead.

- Contract: the Intent Cloud public contract
- Version: 1.7.0
- sha256 of `SHA256SUMS`: `b6bf35a69847283ac6373669e2ae952bcc7b9c17a8e1a75bf90ae024fd7625c1`
- Licence: Apache-2.0 (`LICENSE` in this directory)

`SHA256SUMS` lists every contract file except `LICENSE` and itself, with paths relative to this directory. `src/contract/vendored.test.ts` checks each listed hash, that the listed set equals the files present, that the sha256 above matches `SHA256SUMS`, and that the spec's `info.version` equals the version above.

Intent Cloud reports the same sha256 as `contract_sums_sha256` from `GET /v1/meta` at https://staging-api.intentai.shop, so a running host can be checked against this copy.

From 1.6.0 a caller names its version with the `Intent-Contract-Version` request header, and a request without it is answered as 1.5.0 (`SHA256SUMS` sha256 `c6fc6ffea8b7cb9053a74e0a3aa340d73d1c2800fcc4c47669707400d06410d2`). Versions 1.6.0 (`SHA256SUMS` sha256 `b75b771e3ae299d74a53f450574af6fab8e63d6bcca2b42aa957046afbf4657d`) and 1.6.1 (`SHA256SUMS` sha256 `bc035ee36b0a8fe54e1b87919c8de215c508ab5369d8254fdcdecf18c23710d8`, the previous copy here) are frozen and still answered to callers that name them; 1.7.0 is answered only to a request that names `1.7.0`. The gateway sends `Intent-Contract-Version: 1.7.0` on every request and refuses a host whose `Meta` reports another version or sums hash.

This copy is the 1.7.0 draft as Intent Cloud published it for review; its sums hash changes with each new draft, and the copy here is replaced byte for byte each time.
