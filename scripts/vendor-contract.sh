#!/usr/bin/env bash
# Re-vendors the Intent Cloud public contract into contract/, byte for byte, from a git ref of a
# local clone of the contract's source. Usage:
#   scripts/vendor-contract.sh <clone> <ref> [<expected sha256 of SHA256SUMS>]
# The tree is written to a temporary directory and checked there first: every SHA256SUMS line, and
# the sums hash when one is given. Only then is contract/ replaced (SOURCE.md is kept, with its
# version and sums hash rewritten). Edit SOURCE.md's prose by hand when the frozen versions change.
set -euo pipefail

usage="usage: vendor-contract.sh <clone> <ref> [<sums sha256>]"
clone=${1:?$usage}
ref=${2:?$usage}
want=${3:-}
src=contract/public
repo=$(cd "$(dirname "$0")/.." && pwd)
dest="$repo/contract"
if command -v sha256sum >/dev/null; then sha() { sha256sum "$@"; }; else sha() { shasum -a 256 "$@"; }; fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/vendor-contract.XXXXXX")
trap 'rm -rf "$stage"' EXIT

count=0
while IFS= read -r -d '' f; do
  rel=${f#"$src"/}
  case "$rel" in /* | ../* | */../* | */..) echo "path escapes the contract: $f" >&2; exit 1 ;; esac
  mkdir -p "$stage/new/$(dirname "$rel")"
  git -C "$clone" show "$ref:$f" > "$stage/new/$rel"
  count=$((count + 1))
done < <(git -C "$clone" ls-tree -r -z --name-only "$ref" -- "$src")
[ "$count" -gt 0 ] || { echo "no $src at $ref" >&2; exit 1; }

(cd "$stage/new" && sha --check --quiet SHA256SUMS)
sums=$(sha "$stage/new/SHA256SUMS" | cut -d' ' -f1)
if [ -n "$want" ] && [ "$sums" != "$want" ]; then
  echo "sha256(SHA256SUMS) is $sums, expected $want; contract/ is unchanged" >&2
  exit 1
fi
version=$(sed -n 's/^  version: *"\{0,1\}\([0-9][0-9.]*\)"\{0,1\} *$/\1/p' "$stage/new/gateway-api.v1.yaml" | head -n 1)
[ -n "$version" ] || { echo "no info.version in gateway-api.v1.yaml; contract/ is unchanged" >&2; exit 1; }

# Every check passed: swap the checked tree in, keeping SOURCE.md.
cp "$dest/SOURCE.md" "$stage/new/SOURCE.md"
sed -i.bak -e "s/^- Version: .*/- Version: $version/" \
  -e "s/^- sha256 of \`SHA256SUMS\`: .*/- sha256 of \`SHA256SUMS\`: \`$sums\`/" "$stage/new/SOURCE.md"
rm -f "$stage/new/SOURCE.md.bak"
# Swap with the old tree kept until the new one is in place: if the second move fails, the old tree goes back, and if
# that fails too, the stage is kept and the recovery command printed (the trap then removes nothing).
mv "$dest" "$stage/old"
if ! mv "$stage/new" "$dest"; then
  if mv "$stage/old" "$dest"; then
    echo "could not move the new tree in; contract/ is unchanged" >&2
  else
    trap - EXIT
    echo "could not move the new tree in, nor the old one back; restore it with: mv '$stage/old' '$dest'" >&2
  fi
  exit 1
fi
echo "vendored contract $version, sha256(SHA256SUMS) $sums"
