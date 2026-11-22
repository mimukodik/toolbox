#!/usr/bin/env bash
set -euo pipefail

package=${1:?expected flake package}
evidence="$RUNNER_TEMP/bun-evidence"
mkdir -p "$evidence"
samples="$evidence/$package-resources.tsv"
sample() {
  printf '%s\t%s\t%s\n' "$SECONDS" \
    "$(awk '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { print total - $2 }' /proc/meminfo)" \
    "$(df -P -B1 /nix/store | awk 'NR == 2 { print $3 }')"
}

printf 'seconds\tmemory_used_KiB\tfilesystem_used_bytes\n' > "$samples"
sample >> "$samples"
disk_before=$(awk 'NR==2 {print $3}' "$samples")
(while sleep 1; do sample; done) >> "$samples" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true' EXIT

start=$SECONDS
status=0
nix build ".#$package" --print-build-logs --max-jobs 1 --cores "$(nproc)" \
  --out-link "$RUNNER_TEMP/$package" || status=$?
wall=$((SECONDS - start))
kill "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true
trap - EXIT
sample >> "$samples"
read -r peak_memory peak_disk disk_after < <(
  awk 'NR > 1 {
    if ($2 > memory) memory = $2
    if ($3 > disk) disk = $3
    last = $3
  } END { printf "%.0f %.0f %.0f\n", memory, disk, last }' "$samples"
)

{
  printf '### %s build\n\n' "$package"
  printf -- '- Runner: Blacksmith (%s vCPU available)\n' "$(nproc)"
  printf -- '- Wall time: %s s\n' "$wall"
  printf -- '- Peak runner memory: %s KiB (/proc/meminfo MemTotal minus MemAvailable, sampled each second)\n' "$peak_memory"
  printf -- '- Peak and final disk use above start: %s B and %s B (df on the Nix store filesystem, sampled each second)\n' \
    "$((peak_disk - disk_before))" "$((disk_after - disk_before))"
  if (( status == 0 )); then
    closure=$(nix path-info --json --closure-size "$RUNNER_TEMP/$package" | jq -er '.[].closureSize')
    printf -- '- Runtime closure: %s B (Nix NAR size)\n' "$closure"
    printf -- '- Binary revision: %s\n' "$("$RUNNER_TEMP/$package/bin/bun" --revision)"
  fi
  printf -- '- Nix exit: %s\n\n' "$status"
} | tee "$evidence/$package-build.md" -a "$GITHUB_STEP_SUMMARY"
exit "$status"
