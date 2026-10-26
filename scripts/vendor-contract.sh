#!/usr/bin/env bash
# Re-vendors the Intent Cloud public contract into contract/, byte for byte, from a git ref of a
# local clone of the contract's source. Usage:
#   scripts/vendor-contract.sh <clone> <ref> [<expected sha256 of SHA256SUMS>]
# It replaces every vendored file (keeping SOURCE.md), checks each SHA256SUMS line, checks the sums
# hash when one is given, and writes the version and sums hash into SOURCE.md. Edit SOURCE.md's
# prose (negotiation sentence) by hand when the frozen versions change.
set -euo pipefail

clone=${1:?usage: vendor-contract.sh <clone> <ref> [<sums sha256>]}
ref=${2:?usage: vendor-contract.sh <clone> <ref> [<sums sha256>]}
want=${3:-}
src=contract/public
repo=$(cd "$(dirname "$0")/.." && pwd)
dest="$repo/contract"
if command -v sha256sum >/dev/null; then sha() { sha256sum "$@"; }; else sha() { shasum -a 256 "$@"; }; fi

files=$(git -C "$clone" ls-tree -r --name-only "$ref" "$src")
[ -n "$files" ] || { echo "no $src at $ref" >&2; exit 1; }

find "$dest" -mindepth 1 ! -name SOURCE.md -delete
while IFS= read -r f; do
  rel=${f#"$src"/}
  mkdir -p "$dest/$(dirname "$rel")"
  git -C "$clone" show "$ref:$f" > "$dest/$rel"
done <<< "$files"

(cd "$dest" && sha --check --quiet SHA256SUMS)
sums=$(sha "$dest/SHA256SUMS" | cut -d' ' -f1)
if [ -n "$want" ] && [ "$sums" != "$want" ]; then
  echo "sha256(SHA256SUMS) is $sums, expected $want" >&2
  exit 1
fi
version=$(sed -n 's/^  version: *"\{0,1\}\([0-9][0-9.]*\)"\{0,1\} *$/\1/p' "$dest/gateway-api.v1.yaml" | head -n 1)
[ -n "$version" ] || { echo "no info.version in gateway-api.v1.yaml" >&2; exit 1; }
sed -i.bak -e "s/^- Version: .*/- Version: $version/" \
  -e "s/^- sha256 of \`SHA256SUMS\`: .*/- sha256 of \`SHA256SUMS\`: \`$sums\`/" "$dest/SOURCE.md"
rm -f "$dest/SOURCE.md.bak"
echo "vendored contract $version, sha256(SHA256SUMS) $sums"
