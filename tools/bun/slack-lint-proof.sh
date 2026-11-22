#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C NO_COLOR=1 NODE_DISABLE_COMPILE_CACHE=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

evidence="$RUNNER_TEMP/bun-proof/slack-listener"
mkdir -p "$evidence"
exec > >(tee "$evidence/step.log") 2>&1

time_bin=$(type -P time)
revision=$SLACK_LISTENER_REV
upstream=https://github.com/mimukodik/slack-listener.git
work=$(mktemp -d "$RUNNER_TEMP/slack-listener.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
git init --bare --quiet "$work/repo.git"
git -C "$work/repo.git" fetch --no-tags --depth=1 "$upstream" "$revision"
git -C "$work/repo.git" worktree add --detach "$work/checkout" "$revision"
cd "$work/checkout"
test "$(git rev-parse HEAD)" = "$revision"

stock="$RUNNER_TEMP/bun-unpatched-result/bin/bun"
patched="$RUNNER_TEMP/bun-result/bin/bun"
build_control=${BUN_BUILD_CONTROL:-true}
stock_skip='skipped (no control input changed)'
installer=$patched
if [[ "$build_control" == true ]]; then
  cmp "$RUNNER_TEMP/bun-proof/bun-unpatched/upstream-source.txt" "$RUNNER_TEMP/bun-proof/bun/upstream-source.txt"
  installer=$stock
fi
printf 'Slack listener: %s @ %s\n' "$upstream" "$revision"
printf 'Node version: %s\n' "$(node --version)"
if [[ "$build_control" == true ]]; then
  printf 'Unpatched Bun: %s\n' "$("$stock" --revision)"
else
  printf 'Unpatched Bun: %s\n' "$stock_skip"
fi
printf 'Patched Bun: %s\n' "$("$patched" --revision)"
sha256sum package.json bun.lock tsconfig.json .oxlintrc.json
"$installer" install --frozen-lockfile 2>&1 | tee "$evidence/install.log"
git diff --exit-code HEAD

# Reproduce the checked-in script after its formatter. Bun's --no-script
# selects its built-in linter despite the package.json entry of the same name.
format_prefix='bun run fmt:check && '
lint_script=$(jq -er '.scripts.lint' package.json)
baseline_lint=${lint_script#"$format_prefix"}
test "$lint_script" = "${format_prefix}$baseline_lint"
oxlint_prefix='effect-tsgo --tsrs-lint oxlint '
lint_flags=${baseline_lint#"$oxlint_prefix"}
test "$baseline_lint" = "${oxlint_prefix}$lint_flags"
test "$lint_flags" = '--type-aware --type-check --tsconfig tsconfig.json --format=unix --deny-warnings src'
read -r -a lint_args <<< "$lint_flags"
export PATH="$PWD/node_modules/.bin:${installer%/*}:$PATH"
baseline=(bash -c "exec $baseline_lint")
stock_lint=("$stock" lint --no-script "${lint_args[@]}")
patched_lint=("$patched" lint --no-script "${lint_args[@]}")
printf 'Baseline command: %s\n' "$baseline_lint"
printf 'Native command options: lint --no-script %s\n' "$lint_flags"

build_info=$(jq -er '.compilerOptions.tsBuildInfoFile' tsconfig.json)
test "$build_info" = 'node_modules/.cache/tsbuildinfo/slack-listener.tsbuildinfo'
reset_build_cache() {
  rm -rf -- node_modules/.cache
  test ! -e "$build_info"
}

proof="$evidence/proof.tsv"
printf 'case\tarm\texpected_exit\tactual_exit\texpected_diagnostic\tresult\n' > "$proof"
failures=0
run_case() {
  local fixture=$1 arm=$2 expected_exit=$3 rule=$4 line=$5
  shift 5
  if [[ "$arm" == stock && "$build_control" == false ]]; then
    printf '%s\t%s\t%s\t\t%s\t%s\n' "$fixture" "$arm" "$expected_exit" "$rule" "$stock_skip" \
      | tee -a "$proof"
    return
  fi
  local status=0 result=pass log="$evidence/$fixture-$arm.log" diagnostics
  reset_build_cache
  "$@" > "$log" 2>&1 || status=$?
  if (( status != expected_exit )); then
    result=fail
  fi
  diagnostics=$(rg '\[(Error|Warning)(/[^]]+)?\]$|^::(error|warning) file=' "$log" || true)
  if [[ -n "$rule" ]]; then
    if ! [[ "$diagnostics" != *$'\n'* ]] ||
      ! [[ "$diagnostics" == *" [Error/$rule]" || "$diagnostics" == "::error file="*",title=$rule::"* ]] ||
      ! rg -q "(^|/|::)src/core\.ts:$line:[0-9]+:" <<< "$diagnostics"; then
      result=fail
    fi
  elif [[ -n "$diagnostics" ]]; then
    result=fail
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$fixture" "$arm" "$expected_exit" "$status" "$rule" "$result" \
    | tee -a "$proof"
  if [[ "$result" == fail ]]; then
    cat "$log"
    failures=$((failures + 1))
  fi
}

run_case clean baseline 0 '' 0 "${baseline[@]}"
run_case clean stock 0 '' 0 "${stock_lint[@]}"
run_case clean patched 0 '' 0 "${patched_lint[@]}"

plant() {
  local fixture=$1 code=$2
  planted_line=$(( $(wc -l < src/core.ts) + 2 ))
  printf '\n%s\n' "$code" >> src/core.ts
  git diff -- src/core.ts > "$evidence/$fixture.diff"
}

sed -i '1i import { Effect } from "effect";' src/core.ts
plant floating-effect 'Effect.succeed(1);'
run_case floating-effect stock 0 '' "$planted_line" "${stock_lint[@]}"
run_case floating-effect patched 1 'bun(floating-effect)' "$planted_line" "${patched_lint[@]}"
directory_args=(lint --no-script --type-aware --type-check --tsconfig tsconfig.json src)
run_case floating-effect-default stock 0 '' "$planted_line" \
  env AGENT=0 GITHUB_ACTIONS=true "$stock" "${directory_args[@]}"
run_case floating-effect-default patched 1 'bun(floating-effect)' "$planted_line" \
  env AGENT=0 GITHUB_ACTIONS=true "$patched" "${directory_args[@]}"
git restore --source=HEAD -- src/core.ts

# Each fixture is checked against stock and patched on a freshly restored core.
regression() {
  local fixture=$1 rule=$2 code=$3
  plant "$fixture" "$code"
  run_case "$fixture" stock 1 "$rule" "$planted_line" "${stock_lint[@]}"
  run_case "$fixture" patched 1 "$rule" "$planted_line" "${patched_lint[@]}"
  git restore --source=HEAD -- src/core.ts
}
regression date-now 'eslint(no-restricted-properties)' 'export const ber2343Now = Date.now();'
regression nullable-string 'typescript(strict-boolean-expressions)' \
  'export function ber2343Nullable(value: string | null) { return value ? "yes" : "no"; }'
regression floating-promise 'typescript(no-floating-promises)' 'Promise.resolve(1);'
regression type-error 'typescript(TS2322)' 'export const ber2343Type: number = "wrong";'
git diff --exit-code HEAD

drop_page_cache() {
  sudo -n sh -c 'sync && printf "3\n" > /proc/sys/vm/drop_caches'
}
cache_mode=cache-uncontrolled
if drop_page_cache > "$evidence/drop-caches.log" 2>&1; then
  cache_mode=linux-drop-caches-3
fi
printf 'Filesystem cache mode: %s\n' "$cache_mode"
printf 'Each timed invocation is a new process with the project compiler cache deleted.\n'
printf 'With linux-drop-caches-3, each invocation starts after sync and a write of 3 to /proc/sys/vm/drop_caches.\n'
printf 'GNU time reports maximum RSS in KiB. This is a process high-water mark.\n'
printf 'Load comes from /proc/loadavg immediately before each invocation.\n'

timings="$evidence/timings.tsv"
printf 'round\tarm\tfilesystem_cache\tloadavg\twall_seconds\tmax_rss_kib\texit\n' > "$timings"
timed_run() {
  local round=$1 arm=$2
  shift 2
  if [[ "$arm" == stock && "$build_control" == false ]]; then
    printf 'timing-%s\t%s\t\t\t\t%s\n' "$round" "$arm" "$stock_skip" >> "$proof"
    printf '%s\t%s\t\t\t\t\t%s\n' "$round" "$arm" "$stock_skip" | tee -a "$timings"
    return
  fi
  local log="$evidence/timing-$round-$arm" load status=0 metric
  reset_build_cache
  if [[ "$cache_mode" == linux-drop-caches-3 ]]; then
    drop_page_cache >> "$evidence/drop-caches.log" 2>&1
  fi
  read -r load < /proc/loadavg
  "$time_bin" -f $'%e\t%M' -o "$log.time" "$@" > "$log.log" 2>&1 || status=$?
  metric=$(tail -n 1 "$log.time")
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$round" "$arm" "$cache_mode" "$load" "$metric" "$status" \
    | tee -a "$timings"
  if (( status != 0 )); then
    cat "$log.log"
    failures=$((failures + 1))
  fi
}
for round in 1 2 3 4 5; do
  case $(( (round - 1) % 3 )) in
    0) arms=(baseline stock patched) ;;
    1) arms=(stock patched baseline) ;;
    2) arms=(patched baseline stock) ;;
  esac
  for arm in "${arms[@]}"; do
    case "$arm" in
      baseline) timed_run "$round" "$arm" "${baseline[@]}" ;;
      stock) timed_run "$round" "$arm" "${stock_lint[@]}" ;;
      patched) timed_run "$round" "$arm" "${patched_lint[@]}" ;;
    esac
  done
done

{
  printf '\n### Slack listener lint proof\n\n'
  printf 'Commit %s on %s. Filesystem cache mode %s.\n\n' "$revision" "$BUN_PROOF_RUNNER" "$cache_mode"
  printf 'Diagnostic assertions: %s passed, %s failed.\n\n' \
    "$(awk -F '\t' '$6 == "pass" { n++ } END { print n+0 }' "$proof")" \
    "$(awk -F '\t' '$6 == "fail" { n++ } END { print n+0 }' "$proof")"
  if [[ "$build_control" == false ]]; then
    printf 'Stock diagnostic assertions and timings: %s.\n\n' "$stock_skip"
  fi
  printf '| Round | Arm | Wall (s) | Max RSS (KiB) | 1-min load | Exit |\n'
  printf '| --- | --- | --- | --- | --- | --- |\n'
  awk -F '\t' 'NR > 1 { split($4, load, " "); printf "| %s | %s | %s | %s | %s | %s |\n", $1, $2, $5, $6, load[1], $7 }' "$timings"
} | tee "$evidence/summary.md" >> "$GITHUB_STEP_SUMMARY"
(( failures == 0 ))
