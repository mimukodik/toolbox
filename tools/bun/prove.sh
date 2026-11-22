#!/usr/bin/env bash
set -euo pipefail

patched="$RUNNER_TEMP/bun/bin/bun"
unpatched="$RUNNER_TEMP/bun-unpatched/bin/bun"
evidence="$RUNNER_TEMP/bun-evidence"
cd "${1:?expected slack-listener checkout}"
test "$(git rev-parse HEAD)" = 8132eccf4db7799dc3647e467ddc08f7384aa9a8
git diff --exit-code -- src/core.ts
export PATH="$RUNNER_TEMP/bun/bin:$PWD/node_modules/.bin:$PATH"
export NO_COLOR=1
"$patched" install --frozen-lockfile

core=src/core.ts
original="$RUNNER_TEMP/slack-listener-core.ts"
cp "$core" "$original"
trap 'cp "$original" "$core"' EXIT

lint() {
  local label=$1 binary=$2 expected=$3 diagnostic=${4:-} status=0
  "$binary" lint --type-aware --type-check src > "$evidence/$label.log" 2>&1 || status=$?
  cat "$evidence/$label.log"
  printf '\nExit status: %s\n' "$status" | tee -a "$evidence/$label.log"
  test "$status" = "$expected"
  if [[ "$expected" == 0 ]]; then
    grep -E 'No problems in [1-9][0-9]* files?|Found 0 warnings and 0 errors' "$evidence/$label.log"
  else
    grep -F -- "$diagnostic" "$evidence/$label.log"
  fi
}

planted() {
  cp "$original" "$core"
  printf '\n%s\n' "$@" >> "$core"
}

lint clean-patched "$patched" 0
planted 'import { Effect } from "effect";' 'Effect.succeed("BER-2343");'
lint floating-unpatched "$unpatched" 0
lint floating-patched "$patched" 1 'floating-effect'
planted 'Date.now();'
lint date-now "$patched" 1 'no-restricted-properties'
planted 'declare const ber2343Nullable: string | null;' 'if (ber2343Nullable) console.log(ber2343Nullable);'
lint nullable-condition "$patched" 1 'strict-boolean-expressions'
planted 'Promise.resolve(1);'
lint unawaited-promise "$patched" 1 'no-floating-promises'
planted 'export const ber2343Number: number = "not a number";'
lint type-error "$patched" 1 "not assignable to type"

cp "$original" "$core"
git diff --exit-code
baseline=(effect-tsgo --tsrs-lint oxlint --type-aware --type-check --tsconfig tsconfig.json --format=unix --deny-warnings src)
tee "$evidence/load-before.txt" < /proc/loadavg
printf '| Tool | Trial | Wall (s) | Peak RSS (KiB) |\n|---|---:|---:|---:|\n' > "$evidence/timing.md"

benchmark() {
  local tool=$1 trial=$2
  shift 2
  local times="$evidence/$tool-$trial.time" log="$evidence/$tool-$trial.log" wall rss
  if [[ -f node_modules/.cache/tsbuildinfo/slack-listener.tsbuildinfo ]]; then
    rm node_modules/.cache/tsbuildinfo/slack-listener.tsbuildinfo
  fi
  sync
  # Each command starts in a fresh process with a cold filesystem page cache.
  printf '3\n' | sudo -n tee /proc/sys/vm/drop_caches > /dev/null
  cat /proc/loadavg > "$evidence/$tool-$trial.load"
  if ! /usr/bin/time -f '%e %M' -o "$times" "$@" > "$log" 2>&1; then
    cat "$log"
    return 1
  fi
  read -r wall rss < "$times"
  printf '| %s | %s | %s | %s |\n' "$tool" "$trial" "$wall" "$rss" >> "$evidence/timing.md"
}

for trial in {1..5}; do
  if (( trial % 2 )); then
    benchmark bun "$trial" "$patched" lint --type-aware --type-check src
    benchmark effect-tsgo "$trial" "${baseline[@]}"
  else
    benchmark effect-tsgo "$trial" "${baseline[@]}"
    benchmark bun "$trial" "$patched" lint --type-aware --type-check src
  fi
done

{
  printf '### slack-listener on Blacksmith\n\n'
  printf 'Checkout %s\n\n' "$(git rev-parse HEAD)"
  printf 'Load average before the trials %s\n\n' "$(cat "$evidence/load-before.txt")"
  cat "$evidence/timing.md"
} | tee -a "$GITHUB_STEP_SUMMARY"
