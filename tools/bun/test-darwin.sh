#!/usr/bin/env bash
# Runs on a macos-15 runner against the downloaded darwin release files, with no Nix.
set -euo pipefail
export LC_ALL=C NO_COLOR=1

release=$1
root=$PWD
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/bun-darwin-test.XXXXXX")
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
say() { printf '%s\n' "$*" | tee -a "$summary"; }

asset=$(cd "$release" && ls ./*.tar.zst | head -n1)
asset=${asset#./}
(cd "$release" && shasum -a 256 -c "$asset.sha256")
read -r sha256 _ < "$release/$asset.sha256"
test "$(jq -er .sha256 "$release/manifest.json")" = "$sha256"
mkdir "$work/bin"
zstd -dc "$release/$asset" | tar -x -C "$work/bin"
bun="$work/bin/bun"
chmod +x "$bun"
version=$(jq -er .version "$release/manifest.json")
commit=$(jq -er .bun_commit "$release/manifest.json")
say '### Darwin test'
say ''
say "- binary: $(stat -f %z "$bun") bytes, $(file "$bun")"

otool -L "$bun" | tee "$work/otool.txt"
bad=$(tail -n +2 "$work/otool.txt" | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)
if [[ -n $bad ]]; then
  say "- otool -L: unexpected libraries: $bad"
  exit 1
fi
say '- otool -L lists only /usr/lib and /System libraries'

actual_version=$("$bun" --version)
actual_revision=$("$bun" --revision)
say "- bun --version: $actual_version"
say "- bun --revision: $actual_revision"
test "$actual_version" = "${version%%-*}" || test "$actual_version" = "$version"
test "$actual_revision" = "$version+${commit:0:9}"
"$bun" lint --help > /dev/null
say '- bun lint --help: ok'

export PATH="$work/bin:$PATH"
src="$work/src"
mkdir "$src"
curl --fail --silent --show-error --location --retry 3 -o "$work/src.tar.gz" \
  "https://codeload.github.com/oven-sh/bun/tar.gz/$commit"
printf '%s  %s\n' 1d1d2c42e63be40bf7999ff2055a80b280a93b2f12a1dba681f6bb7085b840fa "$work/src.tar.gz" | shasum -a 256 -c
tar -xzf "$work/src.tar.gz" -C "$src" --strip-components=1
for patch in "$root"/tools/bun/patches/*.patch; do
  git -C "$src" apply "$patch"
done

while IFS= read -r line; do
  [[ $line == 'only '* ]] || continue
  spec=${line#only }
  path=${spec%% :: *}
  pattern=${spec#* :: }
  log="$work/only.log"
  (cd "$src/test" && "$bun" test "./$path" --test-name-pattern "$pattern") 2>&1 | tee "$log"
  pass=$(awk '/^[[:space:]]*[0-9]+ pass$/ { n = $1 } END { print n + 0 }' "$log")
  fail=$(awk '/^[[:space:]]*[0-9]+ fail$/ { n = $1 } END { print n + 0 }' "$log")
  say "- $path :: $pattern: $pass pass, $fail fail"
  [[ $pass -gt 0 && $fail -eq 0 ]]
done < "$root/tools/bun/upstream-tests.txt"

git init --quiet "$work/slack-listener"
cd "$work/slack-listener"
git fetch --no-tags --depth=1 https://github.com/mimukodik/slack-listener.git "$SLACK_LISTENER_REV"
git checkout --quiet --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$SLACK_LISTENER_REV"
"$bun" install --frozen-lockfile
"$bun" test 2>&1 | tee "$work/slack.log"
say "- slack-listener $SLACK_LISTENER_REV: $(grep -E '^[[:space:]]*[0-9]+ (pass|fail)$' "$work/slack.log" | tr -s ' ' | tr '\n' ' ')"
