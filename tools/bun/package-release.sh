#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

out="$RUNNER_TEMP/bun-release"
metadata="$RUNNER_TEMP/bun-release-metadata"
mkdir -p "$out" "$metadata"

version=$(nix eval --raw .#bun.version)
bun_commit=$(nix eval --raw .#bun.upstreamRevision)
patchlevel=$(cat tools/bun/PATCHLEVEL)
tag="bun-$version-${bun_commit:0:7}-$patchlevel"
asset="$tag-x86_64-linux.tar.zst"
store_path=$(readlink -f "$RUNNER_TEMP/bun-result")
nixpkgs_rev=$(jq -er '.nodes.nixpkgs.locked.rev' flake.lock)
source_commit=$(git rev-parse HEAD)

test -x "$store_path/bin/bun"
jq -n --arg store_path "$store_path" \
  '{store_path: $store_path, bins: ["bun"]}' > "$metadata/manifest.json"
nix-store --query --requisites "$store_path" | sort | sed 's|^/||' > "$metadata/closure-paths.txt"
tar --create --zstd --file "$out/$asset" --format=gnu --sort=name \
  --mtime=@0 --owner=0 --group=0 --numeric-owner --hard-dereference \
  -C / --files-from "$metadata/closure-paths.txt" -C "$metadata" manifest.json

(cd "$out" && sha256sum "$asset" > "$asset.sha256")
read -r sha256 _ < "$out/$asset.sha256"
jq --arg version "$version" --arg bun_commit "$bun_commit" --arg patchlevel "$patchlevel" \
  --arg nixpkgs_rev "$nixpkgs_rev" --arg source_commit "$source_commit" --arg sha256 "$sha256" \
  '. + {tool: "bun", version: $version, bun_commit: $bun_commit, patchlevel: $patchlevel,
    nixpkgs_rev: $nixpkgs_rev, source_commit: $source_commit, sha256: $sha256}' \
  "$metadata/manifest.json" > "$out/manifest.json"

packed=$(stat -c %s "$out/$asset")
unpacked=$(zstd -dc "$out/$asset" | wc -c)
patched_binary=$(stat -c %s "$store_path/bin/bun")
npm_binary=$(curl --fail --silent --show-error --location \
  'https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.5.tgz' \
  | tar -xzOf - package/bin/bun | wc -c)
{
  printf '\n### Bun release runtime closure\n\n'
  printf -- '- Packed archive: %s bytes\n' "$packed"
  printf -- '- Unpacked tar stream: %s bytes\n' "$unpacked"
  printf -- '- Patched Bun binary: %s bytes\n' "$patched_binary"
  printf -- '- npm @oven/bun-linux-x64 1.4.5 binary: %s bytes\n' "$npm_binary"
  printf -- '- Unpacked closure difference from npm binary: %+d bytes\n' "$((unpacked - npm_binary))"
  printf -- '- Patched binary difference from npm binary: %+d bytes\n' "$((patched_binary - npm_binary))"
} | tee -a "$GITHUB_STEP_SUMMARY"
