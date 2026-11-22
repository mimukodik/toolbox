#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

variant=$1
case "$variant" in
  bun-unpatched|bun) ;;
  *) printf 'Unknown package %s\n' "$variant" >&2; exit 2 ;;
esac
evidence="$RUNNER_TEMP/bun-proof/$variant"
archive_dir="$RUNNER_TEMP/bun-closures/$variant"
out_link="$RUNNER_TEMP/$variant-result"
mkdir -p "$evidence" "$archive_dir"
exec > >(tee "$evidence/step.log") 2>&1

cores=$(nproc)
time_bin=$(type -P time)
printf 'Toolbox commit: %s\n' "$(git rev-parse HEAD)"
printf 'Runner: %s (%s logical CPUs), %s\n' "$BUN_PROOF_RUNNER" "$cores" "$(uname -srmo)"
printf 'CPU: %s\n' "$(lscpu | sed -n 's/^Model name:[[:space:]]*//p')"
nix --version
df -PB1 /nix/store "$RUNNER_TEMP"
printf 'Builds share one Nix store. The second build can reuse dependencies realized by the first.\n'

upstream_revision=$(nix eval --raw ".#$variant.upstreamRevision")
source_path=$(nix eval --raw ".#$variant.src.outPath")
printf 'Bun source commit: %s\nBun source archive: %s\n' "$upstream_revision" "$source_path" \
  | tee "$evidence/upstream-source.txt"
drv_path=$(nix eval --raw ".#$variant.drvPath")
store_path=$(nix eval --raw ".#$variant.outPath")
printf 'Derivation: %s\nOutput: %s\n' "$drv_path" "$store_path"
if nix path-info "$store_path" >/dev/null 2>&1; then
  printf 'Output already exists in the Nix store. This run cannot measure a source build.\n' >&2
  exit 1
fi

sample_runner() {
  local used_kib disk
  used_kib=$(awk '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { print total - $2 }' /proc/meminfo)
  mapfile -t disk < <(df --output=used -B1 /nix/store "$RUNNER_TEMP")
  printf '%s\t%s\t%s\t%s\n' "$EPOCHREALTIME" "$used_kib" "${disk[1]// /}" "${disk[2]// /}"
}

samples="$evidence/runner-samples.tsv"
printf 'unix_seconds\tmemory_used_kib\tnix_store_filesystem_used_bytes\trunner_temp_filesystem_used_bytes\n' > "$samples"
sample_runner >> "$samples"
(
  while sleep 1; do sample_runner; done
) >> "$samples" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true' EXIT

status=0
"$time_bin" -f '%e' -o "$evidence/wall-seconds.txt" \
  nix build ".#$variant" --print-build-logs --log-format raw \
    --max-jobs 1 --cores "$cores" --out-link "$out_link" \
  2>&1 | tee "$evidence/nix-build.log" || status=$?

kill "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true
trap - EXIT
sample_runner >> "$samples"

wall=$(tail -n 1 "$evidence/wall-seconds.txt")
{
  printf '### %s source build\n\n' "$variant"
  printf -- '- Runner: %s, %s logical CPUs\n' "$BUN_PROOF_RUNNER" "$cores"
  printf -- '- Bun source commit: %s\n' "$upstream_revision"
  printf -- '- Build exit: %s. Wall: %s seconds (GNU time).\n' "$status" "$wall"
  awk -F '\t' 'NR == 2 { nix_start = $3; temp_start = $4 }
    NR > 1 {
      if ($2 > mem_peak) mem_peak = $2
      if ($3 > nix_peak) nix_peak = $3
      if ($4 > temp_peak) temp_peak = $4
      nix_end = $3
      temp_end = $4
    }
    END {
      printf "- Peak runner RAM: %d KiB (MemTotal minus MemAvailable, sampled every second).\n", mem_peak
      printf "- /nix/store filesystem used (before / peak / after): %.0f / %.0f / %.0f bytes.\n", nix_start, nix_peak, nix_end
      printf "- Runner temporary filesystem used (before / peak / after): %.0f / %.0f / %.0f bytes.\n", temp_start, temp_peak, temp_end
    }' "$samples"
} | tee "$evidence/summary.md" >> "$GITHUB_STEP_SUMMARY"
cat "$evidence/summary.md"

if (( status != 0 )); then
  if nix log "$drv_path" > "$evidence/nix-compile.log" 2> "$evidence/nix-log-errors.txt"; then
    rg -n -m 35 -e '^FAILED:|(^|[ :])(fatal )?error([ :]|\[[[:alnum:]]+\])|CMake Error|npm ERR!' \
      "$evidence/nix-compile.log" || true
  fi
  exit "$status"
fi
if ! rg -F "building '$drv_path'" "$evidence/nix-build.log"; then
  printf 'Nix did not log building the Bun derivation. The measurement does not prove a source build.\n' >&2
  exit 1
fi
test "$(readlink -f "$out_link")" = "$store_path"
"$store_path/bin/bun" --revision | tee "$evidence/bun-revision.txt"
nix path-info --json --closure-size "$store_path" > "$evidence/closure.json"
closure_bytes=$(jq -er 'first(.[] | .closureSize)' "$evidence/closure.json")

# Keep the store root alongside the export so the binary can be found after import.
printf '%s\n' "$store_path" > "$archive_dir/store-path.txt"
nix-store --query --requisites "$store_path" > "$evidence/closure-paths.txt"
mapfile -t closure < "$evidence/closure-paths.txt"
nix-store --export "${closure[@]}" | zstd -q -T0 -o "$archive_dir/closure.nix-export.zst"
(cd "$archive_dir" && sha256sum closure.nix-export.zst > closure.nix-export.zst.sha256)
printf -- '- Runtime closure NAR size: %s bytes. Compressed export: %s bytes.\n' \
  "$closure_bytes" "$(stat -c %s "$archive_dir/closure.nix-export.zst")" \
  | tee -a "$evidence/summary.md" "$GITHUB_STEP_SUMMARY"
