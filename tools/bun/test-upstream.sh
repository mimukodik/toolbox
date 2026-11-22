#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
shopt -s dotglob
SECONDS=0
trap 'printf "\nBun lint test step wall time: %ss\n" "$SECONDS" | tee -a "$GITHUB_STEP_SUMMARY"' EXIT

source=$(nix eval --raw .#bun.src.outPath)
fixture=$(mktemp -d "$RUNNER_TEMP/bun-upstream.XXXXXX")
tar -xzf "$source" -C "$fixture" --strip-components=1

changes="$RUNNER_TEMP/bun-patched-tests"
for patch in "$PWD"/tools/bun/patches/*.patch; do
  # Match the regular files selected by package.nix.
  [[ -f "$patch" && ! -L "$patch" ]] || continue
  git -C "$fixture" apply --apply --numstat -z "$patch"
done > "$changes"

tests=()
declare -A touched=() listed=()
while IFS=$'\t' read -r -d '' _added _removed path; do
  test_path=${path#test/cli/lint/}
  [[ $path == test/cli/lint/*.test.ts && $test_path != */* && -f "$fixture/$path" ]] || continue
  path=${path#test/}
  [[ ${touched[$path]+x} ]] || tests+=("$path")
  touched[$path]=yes
done < "$changes"

while IFS= read -r path || [[ -n $path ]]; do
  [[ $path =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ $path == /* || /$path/ == */../* || ! -f "$fixture/test/$path" ]]; then
    printf '::error::Listed Bun test file missing under test/: %s\n' "$path" | tee -a "$GITHUB_STEP_SUMMARY"
    exit 1
  fi
  [[ ${touched[$path]+x} || ${listed[$path]+x} ]] || tests+=("$path")
  listed[$path]=yes
done < tools/bun/upstream-tests.txt

printf '### Bun lint tests\n\n| File | Touched | Listed | Pass | Fail |\n| --- | --- | --- | ---: | ---: |\n' \
  | tee -a "$GITHUB_STEP_SUMMARY"
cd "$fixture/test"
status=0
log="$RUNNER_TEMP/bun-upstream-test.log"
for path in "${tests[@]}"; do
  NO_COLOR=1 "$RUNNER_TEMP/bun-result/bin/bun" test "./$path" 2>&1 | tee "$log" || status=1
  awk -v file="$path" -v touched="${touched[$path]:-no}" -v listed="${listed[$path]:-no}" '
    /^[[:space:]]*[0-9]+ pass$/ { pass = $1 }
    /^[[:space:]]*[0-9]+ fail$/ { fail = $1 }
    END {
      printf "| `%s` | %s | %s | %s | %s |\n", file, touched, listed,
        (pass == "" ? "—" : pass), (fail == "" ? "—" : fail)
    }
  ' "$log" | tee -a "$GITHUB_STEP_SUMMARY"
done
exit "$status"
