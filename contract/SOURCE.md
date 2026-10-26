# Source of the vendored contract

The files in this directory are the Intent Cloud public contract, copied byte for byte. Do not edit them; replace them with a new published version instead.

- Contract: the Intent Cloud public contract
- Version: 1.7.1
- sha256 of `SHA256SUMS`: `c0ca70669a1db9986b3c83334fc2e159ae54a7ff0057b86bfa5957050a1706dc`
- Licence: Apache-2.0 (`LICENSE` in this directory)

`SHA256SUMS` lists every contract file except `LICENSE` and itself, with paths relative to this directory. `src/contract/vendored.test.ts` checks each listed hash, that the listed set equals the files present, that the sha256 above matches `SHA256SUMS`, and that the spec's `info.version` equals the version above.

Intent Cloud reports the same sha256 as `contract_sums_sha256` from `GET /v1/meta` at https://staging-api.intentai.shop, so a running host can be checked against this copy.

From 1.6.0 a caller names its version with the `Intent-Contract-Version` request header, and a request without it is answered as 1.5.0 (`SHA256SUMS` sha256 `c6fc6ffea8b7cb9053a74e0a3aa340d73d1c2800fcc4c47669707400d06410d2`). Versions 1.6.0 (`SHA256SUMS` sha256 `b75b771e3ae299d74a53f450574af6fab8e63d6bcca2b42aa957046afbf4657d`), 1.6.1 (`SHA256SUMS` sha256 `bc035ee36b0a8fe54e1b87919c8de215c508ab5369d8254fdcdecf18c23710d8`) and 1.7.0 (`SHA256SUMS` sha256 `dad42cb22c35fc68948d5a69517ed3db08ba28786f1c81886fb8f334fbbfff5a`, the previous copy here, USD only) are frozen and still answered to callers that name them; 1.7.1 is answered only to a request that names `1.7.1`. The gateway sends `Intent-Contract-Version: 1.7.1` on every request, the pause included, and refuses a host whose `Meta` reports another version or sums hash.

This copy is the final 1.7.1 as Intent Cloud published it. `scripts/vendor-contract.sh <clone> <ref> [<sums sha256>]` replaces it from a clone of the contract's source in one step.
