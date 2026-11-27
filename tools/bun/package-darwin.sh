#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# Run from the repository root after build-darwin.sh. Packs the bun binary alone (mise extracts it and puts it on PATH); the manifest is its own file.
in="$RUNNER_TEMP/bun-darwin-release"
out="$RUNNER_TEMP/bun-darwin-package"
rm -rf "$out"
mkdir -p "$out" "$RUNNER_TEMP/darwin-stage"

version=1.4.6-canary.1
bun_commit=0966e99d8f357833a147af2a4bce7d66321829c1
patchlevel=$(tr -d '\n' < tools/bun/PATCHLEVEL)
tag="bun-$version-${bun_commit:0:7}-$patchlevel"
asset="$tag-aarch64-darwin.tar.zst"
build_id=$(cat "$in/build-id")
source_commit=$(git rev-parse HEAD)

stage="$RUNNER_TEMP/darwin-stage"
rm -rf "$stage"/*
install -m755 "$in/bun" "$stage/bun"
jq -n --arg version "$version" --arg bun_commit "$bun_commit" --arg patchlevel "$patchlevel" \
  --arg build_id "$build_id" --arg source_commit "$source_commit" \
  '{tool: "bun", target: "aarch64-darwin", bins: ["bun"], version: $version, bun_commit: $bun_commit,
    patchlevel: $patchlevel, build_id: $build_id, source_commit: $source_commit}' > "$stage/manifest.json"
tar --create --zstd --file "$out/$asset" --format=gnu --sort=name \
  --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$stage" bun
(cd "$out" && sha256sum "$asset" > "$asset.sha256")
read -r sha256 _ < "$out/$asset.sha256"
jq --arg sha256 "$sha256" '. + {sha256: $sha256}' "$stage/manifest.json" > "$out/manifest-aarch64-darwin.json"
{
  printf '\n### Darwin release files\n\n'
  printf -- '- Asset: %s\n- Packed archive: %s bytes\n- SHA-256: %s\n- Binary: %s bytes\n' \
    "$asset" "$(stat -c %s "$out/$asset")" "$sha256" "$(stat -c %s "$in/bun")"
} | tee -a "$GITHUB_STEP_SUMMARY"
