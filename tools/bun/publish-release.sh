#!/usr/bin/env bash
# Publishes the Bun release from the `release` job: Linux files in ./release, darwin files in ./release-darwin.
# Writes the release tag to $GITHUB_OUTPUT as `tag`, whether it published, appended or found the release complete.
# Test seams: DRY_RUN=1 prints the writing gh calls instead of making them; RELEASES_FILE replaces the releases API read.
set -euo pipefail
export LC_ALL=C

: "${GITHUB_SHA:?}" "${GH_REPO:?}"
out=${GITHUB_OUTPUT:-/dev/null}
tag_of() { jq -er '"bun-" + .version + "-" + .bun_commit[:7] + "-" + .patchlevel' "$1"; }
tag=$(tag_of release/manifest.json)
test "$tag" = "$(tag_of release-darwin/manifest-aarch64-darwin.json)"
linux_asset="$tag-x86_64-linux.tar.zst"
darwin_asset="$tag-aarch64-darwin.tar.zst"
linux_names=("$linux_asset" "$linux_asset.sha256" manifest.json)
darwin_names=("$darwin_asset" "$darwin_asset.sha256" manifest-aarch64-darwin.json)

for pair in "release:$linux_asset:manifest.json" "release-darwin:$darwin_asset:manifest-aarch64-darwin.json"; do
  IFS=: read -r dir asset manifest <<< "$pair"
  (
    cd "$dir"
    read -r sha256 checksummed_asset < "$asset.sha256"
    test "$checksummed_asset" = "$asset"
    sha256sum --check "$asset.sha256"
    test "$(jq -er .sha256 "$manifest")" = "$sha256"
    test "$(jq -er .source_commit "$manifest")" = "$GITHUB_SHA"
  )
done
linux_sha=$(cut -d' ' -f1 "release/$linux_asset.sha256")
darwin_sha=$(cut -d' ' -f1 "release-darwin/$darwin_asset.sha256")
cp release-darwin/"$darwin_asset" release-darwin/"$darwin_asset.sha256" release-darwin/manifest-aarch64-darwin.json release/
cd release

write() { if [[ ${DRY_RUN:-} == 1 ]]; then printf 'DRY RUN: gh %s\n' "$*"; else gh "$@"; fi; }
releases_json() {
  if [[ -n ${RELEASES_FILE:-} ]]; then cat "$RELEASES_FILE"
  else gh api --paginate "repos/$GH_REPO/releases" --jq ".[] | select(.tag_name == \"$tag\")"; fi
}
# Digest GitHub reports for a published asset; empty when the asset is absent.
digest_of() { jq -r --arg asset "$2" 'select(.draft == false) | .assets[] | select(.name == $asset) | .digest // "none"' <<< "$1"; }
has_name() { [[ -n $(jq -r --arg asset "$2" 'select(.draft == false) | .assets[] | select(.name == $asset) | .name' <<< "$1") ]]; }
fail() { echo "::error::$*"; exit 1; }

releases=$(releases_json)
if [[ -n "$releases" ]]; then
  [[ $(jq -s 'map(select(.draft == false)) | length' <<< "$releases") != 0 ]] \
    || fail "Release $tag exists only as a draft. Delete the draft or bump PATCHLEVEL."
  [[ "$(digest_of "$releases" "$linux_asset")" == "sha256:$linux_sha" ]] \
    || fail "Release $tag exists without the matching Linux asset. Bump PATCHLEVEL."
  for name in "${linux_names[@]}"; do
    has_name "$releases" "$name" || fail "Release $tag lacks $name. Bump PATCHLEVEL."
  done
  present=0
  for name in "${darwin_names[@]}"; do
    if has_name "$releases" "$name"; then present=$((present + 1)); fi
  done
  current=$(digest_of "$releases" "$darwin_asset")
  if [[ $present == 0 ]]; then
    write release upload "$tag" "$darwin_asset" "$darwin_asset.sha256" manifest-aarch64-darwin.json
    releases=$([[ ${DRY_RUN:-} == 1 ]] && cat "${RELEASES_AFTER_FILE:-/dev/null}" || releases_json)
    verify=append
  elif [[ $present == 3 && "$current" == "sha256:$darwin_sha" ]]; then
    printf 'Release %s already has all six files. Skipping.\n' "$tag"
    printf 'tag=%s\n' "$tag" >> "$out"
    exit 0
  elif [[ $present == 3 ]]; then
    fail "Release $tag has a different $darwin_asset ($current). Bump PATCHLEVEL."
  else
    fail "Release $tag has $present of the 3 darwin files, so an earlier upload was partial. Delete them from the release by hand, or bump PATCHLEVEL."
  fi
  if [[ ${DRY_RUN:-} == 1 && -z ${RELEASES_AFTER_FILE:-} ]]; then
    printf 'tag=%s\n' "$tag" >> "$out"; exit 0
  fi
  [[ "$(digest_of "$releases" "$linux_asset")" == "sha256:$linux_sha" ]] || fail "Linux digest changed after the upload."
  [[ "$(digest_of "$releases" "$darwin_asset")" == "sha256:$darwin_sha" ]] || fail "Darwin digest is wrong after the upload."
  for name in "${linux_names[@]}" "${darwin_names[@]}"; do
    has_name "$releases" "$name" || fail "Release $tag lacks $name after the upload."
  done
  printf 'Added the darwin files to release %s.\n' "$tag"
  printf 'tag=%s\n' "$tag" >> "$out"
  exit 0
fi

tags=$(gh api --paginate "repos/$GH_REPO/git/matching-refs/tags/$tag" \
  --jq ".[] | select(.ref == \"refs/tags/$tag\") | .ref")
[[ -z "$tags" ]] || fail "Tag $tag already exists without a release. Bump PATCHLEVEL."

write release create "$tag" "$linux_asset" "$linux_asset.sha256" manifest.json \
  "$darwin_asset" "$darwin_asset.sha256" manifest-aarch64-darwin.json \
  --draft --target "$GITHUB_SHA" --title "$tag" \
  --notes "Bun for Linux x86_64 (runtime closure) and macOS aarch64 (single binary). [Build and measurements](${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-})."
if [[ ${DRY_RUN:-} != 1 ]]; then
  drafted=$(gh api --paginate "repos/$GH_REPO/releases" --jq ".[] | select(.tag_name == \"$tag\" and .draft == true)")
  for pair in "$linux_asset:$linux_sha" "$darwin_asset:$darwin_sha"; do
    asset=${pair%%:*}; sha=${pair##*:}
    [[ "$(jq -r --arg asset "$asset" '.assets[] | select(.name == $asset) | .digest // ""' <<< "$drafted")" == "sha256:$sha" ]] \
      || fail "Draft $tag has the wrong digest for $asset."
  done
  for name in "${linux_names[@]}" "${darwin_names[@]}"; do
    [[ -n $(jq -r --arg asset "$name" '.assets[] | select(.name == $asset) | .name' <<< "$drafted") ]] || fail "Draft $tag lacks $name."
  done
fi
write release edit "$tag" --draft=false
printf 'tag=%s\n' "$tag" >> "$out"
