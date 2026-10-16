#!/usr/bin/env bash
# Shows why two OCI image archives of one commit have different digests: which layers differ, then for each
# differing layer the tar entries (type, mode, owner, size, mtime, link target) and file contents that differ.
# CI runs it when two image builds disagree, so a nondeterministic build explains itself in the job log.
#   scripts/image-diff.sh <image-1.tar> <image-2.tar>
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: $0 <image-1.tar> <image-2.tar>" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for n in 1 2; do
  mkdir -p "$work/$n"
  tar -xf "$(realpath "${!n}")" -C "$work/$n"
done

blob() { echo "$work/$1/blobs/sha256/${2#sha256:}"; }
manifest() { blob "$1" "$(jq -r '.manifests[0].digest' "$work/$1/index.json")"; }
config() { blob "$1" "$(jq -r '.config.digest' "$(manifest "$1")")"; }

echo "config diff (history and rootfs):"
diff <(jq -S . "$(config 1)") <(jq -S . "$(config 2)") || true

mapfile -t layers1 < <(jq -r '.layers[].digest' "$(manifest 1)")
mapfile -t layers2 < <(jq -r '.layers[].digest' "$(manifest 2)")
[[ ${#layers1[@]} -eq ${#layers2[@]} ]] || echo "layer count differs: ${#layers1[@]} vs ${#layers2[@]}"

for i in "${!layers1[@]}"; do
  a="${layers1[$i]}" b="${layers2[$i]:-}"
  [[ "$a" == "$b" ]] && continue
  echo "layer $i differs: $a vs $b"
  for n in 1 2; do
    d="$a"; [[ $n -eq 2 ]] && d="$b"
    tar -tvzf "$(blob "$n" "$d")" --full-time --numeric-owner > "$work/list-$n"
    mkdir -p "$work/root-$i-$n"
    tar -xzf "$(blob "$n" "$d")" -C "$work/root-$i-$n" --no-same-owner --no-same-permissions 2>/dev/null || true
  done
  echo "  entries that differ (first 50):"
  diff "$work/list-1" "$work/list-2" | head -50 || true
  echo "  contents that differ (first 50):"
  diff -rq --no-dereference "$work/root-$i-1" "$work/root-$i-2" | head -50 || true
done
