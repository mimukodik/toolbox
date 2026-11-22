#!/usr/bin/env bash
set -euo pipefail

stock=$(realpath "${1:?stock sccache binary required}")
patched=$(realpath "${2:?patched sccache binary required}")
fixture=$(cd "$(dirname "$0")" && pwd)
root=${PROOF_CHECKOUT_ROOT:-/tmp}
run=$(mktemp -d "$root/sccache-proof.XXXXXXXX")
a="$root/a/ws"
b="$root/b/ws"

mkdir -p "${a%/*}" "${b%/*}"
mkdir "$a" "$b"
cp -a "$fixture"/{Cargo.toml,Cargo.lock,src,fixture.txt} "$a/"

export CARGO_HOME="$run/cargo-home"
export CARGO_INCREMENTAL=0
export RUST_BACKTRACE=0
unset SCCACHE_BASEDIRS_VERBATIM_ENV_DEPS
(cd "$a" && cargo fetch --locked)

run_pair() (
    label=$1
    export RUSTC_WRAPPER=$2
    export SCCACHE_DIR="$run/$label-cache"
    export SCCACHE_SERVER_PORT=43219
    export SCCACHE_BASEDIRS="$root/a:$root/b"
    export SCCACHE_BASEDIRS_REMAP_PATHS=1
    export SCCACHE_ERROR_LOG="$run/$label-server.log"

    "$RUSTC_WRAPPER" --version
    SCCACHE_LOG=debug "$RUSTC_WRAPPER" --start-server
    trap '"$RUSTC_WRAPPER" --stop-server >/dev/null' EXIT

    build() (
        cd "$1"
        export CARGO_TARGET_DIR="$PWD/target-$label"
        cargo build --locked --offline
    )

    printf '\n%s fill at %s\n' "$label" "$a"
    build "$a"
    "$RUSTC_WRAPPER" --show-stats
    "$RUSTC_WRAPPER" --zero-stats >/dev/null
    replay_log_start=$(wc -l < "$SCCACHE_ERROR_LOG")

    cp -a "$a"/{Cargo.toml,Cargo.lock,src,fixture.txt} "$b/"
    printf 'checkout-b\n' > "$b/fixture.txt"
    printf '\n%s replay at %s\n' "$label" "$b"
    build "$b"
    "$RUSTC_WRAPPER" --show-stats
    "$RUSTC_WRAPPER" --show-stats --stats-format=json > "$run/$label-replay.json"
    jq -e '.cache_location | startswith("Local disk:")' "$run/$label-replay.json" > /dev/null
    read -r hits misses < <(jq -er '.stats | [.cache_hits.counts.Rust // 0,
        .cache_misses.counts.Rust // 0] | @tsv' "$run/$label-replay.json")
    total=$((hits + misses))
    (( total > 0 ))
    printf '%s replay: %s/%s cacheable Rust compiles hit\n' "$label" "$hits" "$total"

    if [[ $label == stock ]]; then
        (( hits == 0 ))
        exit
    fi

    tail -n "+$((replay_log_start + 1))" "$SCCACHE_ERROR_LOG" > "$run/replay.log"
    grep -F 'compile result:' "$run/replay.log"
    if (( hits * 100 < total * 90 )); then
        echo 'Patched replay fell below the 90% Rust hit threshold.' >&2
        exit 1
    fi
    grep -F '[path_probe]: compile result: cache hit' "$run/replay.log"

    "$b/target-$label/debug/path-probe" > "$run/probe.log" 2>&1
    cat "$run/probe.log"
    grep -Fxq "Binary manifest dir: $b" "$run/probe.log"
    grep -Fxq "Cached library manifest dir: $a" "$run/probe.log"
    grep -Eq '^Source file: (\./)?src/location\.rs$' "$run/probe.log"
    grep -Eq 'panicked at (\./)?src/location\.rs:[0-9]+:[0-9]+:' "$run/probe.log"
    grep -Fxq 'Fixture: checkout-b' "$run/probe.log"
    test "$(grep -Fc "$a" "$run/probe.log")" -eq 1
)

run_pair stock "$stock"
run_pair patched "$patched"
