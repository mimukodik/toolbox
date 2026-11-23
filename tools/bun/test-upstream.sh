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
declare -A touched=() listed=() exclusions=()
while IFS=$'\t' read -r -d '' _added _removed path; do
  test_path=${path#test/cli/lint/}
  [[ $path == test/cli/lint/*.test.ts && $test_path != */* && -f "$fixture/$path" ]] || continue
  path=${path#test/}
  [[ ${touched[$path]+x} ]] || tests+=("$path")
  touched[$path]=yes
done < "$changes"

while IFS= read -r path || [[ -n $path ]]; do
  [[ $path =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ $path == 'exclude '* ]]; then
    spec=${path#exclude }
    path=${spec%% :: *}
    name=${spec#* :: }
    if [[ $spec != *' :: '* || -z $path || -z $name || ${exclusions[$path]+x} ]]; then
      printf '::error::Invalid or duplicate Bun test exclusion: %s\n' "$spec" | tee -a "$GITHUB_STEP_SUMMARY"
      exit 1
    fi
    exclusions[$path]=$name
    continue
  fi
  if [[ $path == /* || /$path/ == */../* || ! -f "$fixture/test/$path" ]]; then
    printf '::error::Listed Bun test file missing under test/: %s\n' "$path" | tee -a "$GITHUB_STEP_SUMMARY"
    exit 1
  fi
  [[ ${touched[$path]+x} || ${listed[$path]+x} ]] || tests+=("$path")
  listed[$path]=yes
done < tools/bun/upstream-tests.txt

for path in "${!exclusions[@]}"; do
  if [[ ! ${listed[$path]+x} ]]; then
    printf '::error::Bun test exclusion requires a listed file: %s :: %s\n' "$path" "${exclusions[$path]}" | tee -a "$GITHUB_STEP_SUMMARY"
    exit 1
  fi
done

printf '### Bun lint tests\n\n| File | Touched | Listed | Pass | Fail |\n| --- | --- | --- | ---: | ---: |\n' \
  | tee -a "$GITHUB_STEP_SUMMARY"
cd "$fixture/test"
status=0
log="$RUNNER_TEMP/bun-upstream-test.log"
excluded=()
for path in "${tests[@]}"; do
  name=${exclusions[$path]:-}
  args=()
  if [[ -n $name ]]; then
    literal=$(printf '%s' "$name" | sed 's/[][\\.^$*+?(){}|]/\\&/g')
    args+=(--test-name-pattern "^(?!${literal}\$).*")
  fi
  NO_COLOR=1 "$RUNNER_TEMP/bun-result/bin/bun" test "./$path" "${args[@]}" 2>&1 | tee "$log" || status=1
  if [[ -n $name ]]; then
    filtered=$(awk '/^[[:space:]]*[0-9]+ filtered out$/ { count = $1 } END { print count + 0 }' "$log")
    if [[ $filtered == 1 ]]; then
      excluded+=("EXCLUDED: $path :: $name (owner lane:nix, BER-2427)")
    else
      printf '::error::Bun expected to filter exactly one test for %s :: %s, reported %s filtered out\n' \
        "$path" "$name" "$filtered" >&2
      status=1
    fi
  fi
  awk -v file="$path" -v touched="${touched[$path]:-no}" -v listed="${listed[$path]:-no}" '
    /^[[:space:]]*[0-9]+ pass$/ { pass = $1 }
    /^[[:space:]]*[0-9]+ fail$/ { fail = $1 }
    END {
      printf "| `%s` | %s | %s | %s | %s |\n", file, touched, listed,
        (pass == "" ? "—" : pass), (fail == "" ? "—" : fail)
    }
  ' "$log" | tee -a "$GITHUB_STEP_SUMMARY"
done
if ((${#excluded[@]})); then
  printf '\n%s\n' "${excluded[@]}" | tee -a "$GITHUB_STEP_SUMMARY"
fi
exit "$status"
