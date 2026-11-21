#!/bin/sh
set -eu

die() {
    printf '%s\n' "install.sh: $*" >&2
    exit 1
}

[ "$#" -eq 2 ] || die "usage: install.sh <tarball-url> <sha256>"
[ "$(id -u)" -eq 0 ] || die "run as root to install into /nix/store and /usr/local/bin"

expected_sha256=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
case "$expected_sha256" in
    *[!0-9a-f]*) die "expected a 64-digit SHA-256" ;;
esac
[ "${#expected_sha256}" -eq 64 ] || die "expected a 64-digit SHA-256"

work=$(mktemp -d)
trap 'rm -r -- "$work"' EXIT
trap 'exit 1' HUP INT TERM

archive="$work/release.tar.zst"
curl --fail --silent --show-error --location --proto '=https,file' --proto-redir '=https' \
    --output "$archive" -- "$1"
sum=$(sha256sum "$archive")
actual_sha256=${sum%% *}
[ "$actual_sha256" = "$expected_sha256" ] ||
    die "SHA-256 mismatch (expected $expected_sha256, got $actual_sha256)"

# The embedded manifest is covered by the expected SHA-256.
tar --zstd --extract --to-stdout --file "$archive" manifest.json > "$work/manifest.json"
store_path=$(jq -er '.store_path | select(test("^/nix/store/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+\\z"))' \
    "$work/manifest.json") || die "invalid store path in manifest"
jq -er '.bins | select(type == "array" and length > 0 and
    all(.[]; type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*\\z")))[]' \
    "$work/manifest.json" > "$work/bins" || die "invalid bin list in manifest"

tar --zstd --extract --file "$archive" --directory / --exclude=manifest.json
while IFS= read -r bin; do
    [ -x "$store_path/bin/$bin" ] || die "missing executable $store_path/bin/$bin"
done < "$work/bins"

mkdir -p /usr/local/bin
while IFS= read -r bin; do
    ln -sfnT "$store_path/bin/$bin" "/usr/local/bin/$bin"
done < "$work/bins"
