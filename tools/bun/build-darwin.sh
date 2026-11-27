#!/usr/bin/env bash
# Cross-compiles the patched Bun for aarch64-darwin on a Linux x86_64 host, with Bun's own build script
# and the toolchain pins of scripts/build/ci-images/spec.ts at the pinned commit (the way upstream builds
# its Mac binaries: clang --target, ld64.lld, the Apple SDK that xmac fetches from Apple's CDN).
# Nix is not used: its clang wrapper adds Linux glibc flags that a darwin target cannot take.
set -euo pipefail
export LC_ALL=C

rev=0966e99d8f357833a147af2a4bce7d66321829c1
version=1.4.6-canary.1
src_sha256=1d1d2c42e63be40bf7999ff2055a80b280a93b2f12a1dba681f6bb7085b840fa

llvm_version=23.1.1
llvm_sha256=832aeb58d105de1cabc7b982dd2c65de0610f7377df48ae8fc2dd8e97420a15c
icu_url=https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu70_70.1-2_amd64.deb
icu_sha256=58a154f6307289813da2276f900498ef536ae7c0522d2cf31a3c3c5cf62dfd9a
cmake_version=3.30.5
cmake_sha256=83de8839f3fb0d9caf982a0435da3fa8c4fbe2c817dfec99def310dc7e6a8404
rustup_version=1.28.2
rustup_sha256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
rust_channel=nightly-2026-11-14
node_version=26.12.1
node_sha256=0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132
hostbun_version=1.4.4
hostbun_sha256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c

root=$PWD
work="$RUNNER_TEMP/bun-darwin"
tools="$work/tools"
out="$RUNNER_TEMP/bun-darwin-release"
mkdir -p "$work" "$tools" "$out"
t0=$SECONDS
phase() { printf '::group::%s\n' "$1"; }
endphase() { printf '::endgroup::\n'; }
declare -A timing=()
lap() { timing[$1]=$((SECONDS - t0)); t0=$SECONDS; }

fetch() { # url sha256 file
  curl --fail --silent --show-error --location --retry 3 --output "$3" -- "$1"
  printf '%s  %s\n' "$2" "$3" | sha256sum --check --quiet
}

phase 'Host packages'
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends xz-utils zstd unzip perl python3 libatomic1 ca-certificates curl git
endphase

phase 'LLVM and ICU'
fetch "https://github.com/llvm/llvm-project/releases/download/llvmorg-$llvm_version/LLVM-$llvm_version-Linux-X64.tar.xz" \
  "$llvm_sha256" "$work/llvm.tar.xz"
mkdir -p "$tools/llvm"
tar -xf "$work/llvm.tar.xz" -C "$tools/llvm" --strip-components=1
rm "$work/llvm.tar.xz"
fetch "$icu_url" "$icu_sha256" "$work/libicu.deb"
sudo dpkg -i "$work/libicu.deb"
"$tools/llvm/bin/ld64.lld" --version
"$tools/llvm/bin/clang" --version | head -1
endphase

phase 'cmake, Node, host Bun'
fetch "https://github.com/Kitware/CMake/releases/download/v$cmake_version/cmake-$cmake_version-linux-x86_64.sh" \
  "$cmake_sha256" "$work/cmake.sh"
sh "$work/cmake.sh" --skip-license --prefix="$tools/cmake" > /dev/null
fetch "https://nodejs.org/download/release/v$node_version/node-v$node_version-linux-x64.tar.xz" \
  "$node_sha256" "$work/node.tar.xz"
mkdir -p "$tools/node"
tar -xf "$work/node.tar.xz" -C "$tools/node" --strip-components=1
fetch "https://github.com/oven-sh/bun/releases/download/bun-v$hostbun_version/bun-linux-x64.zip" \
  "$hostbun_sha256" "$work/hostbun.zip"
unzip -q -o "$work/hostbun.zip" -d "$work/hostbun"
mkdir -p "$tools/hostbun"
install -m755 "$work/hostbun/bun-linux-x64/bun" "$tools/hostbun/bun"
endphase

phase 'Rust'
export RUSTUP_HOME="$work/rustup" CARGO_HOME="$work/cargo"
fetch "https://static.rust-lang.org/rustup/archive/$rustup_version/x86_64-unknown-linux-gnu/rustup-init" \
  "$rustup_sha256" "$work/rustup-init"
chmod +x "$work/rustup-init"
"$work/rustup-init" -y --no-modify-path --profile minimal --default-toolchain "$rust_channel" \
  --component rust-src --target aarch64-apple-darwin
export PATH="$CARGO_HOME/bin:$tools/cmake/bin:$tools/node/bin:$tools/hostbun:$tools/llvm/bin:$PATH"
rust_sysroot=$(rustc --print sysroot)
endphase
lap toolchains

phase 'Source and patches'
fetch "https://codeload.github.com/oven-sh/bun/tar.gz/$rev" "$src_sha256" "$work/bun-src.tar.gz"
src="$work/bun-$rev"
rm -rf "$src"
mkdir -p "$src"
tar -xzf "$work/bun-src.tar.gz" -C "$src" --strip-components=1
patchlevel=$(tr -d '\n' < "$root/tools/bun/PATCHLEVEL")
patches=("$root"/tools/bun/patches/*.patch)
for patch in "${patches[@]}"; do
  [[ -f $patch && ! -L $patch ]] || continue
  git -C "$src" apply --verbose "$patch"
done
# Same formula as buildId in package.nix.
series=$(cat "${patches[@]}"; printf '%s' "$patchlevel")
build_id="$patchlevel-$(printf '%s' "$series" | sha256sum | cut -c1-16)"
printf 'patchlevel %s, build id %s, %s patches\n' "$patchlevel" "$build_id" "${#patches[@]}"
endphase
lap source

phase 'Build bun for aarch64-darwin'
cd "$src"
# CI and GITHUB_ACTIONS would switch the build script to its CI mode.
env -u CI -u GITHUB_ACTIONS \
  BUN_TEST_INPUT_BUILD_ID="$build_id" \
  BUN_TOOLCHAIN_LLVM="$tools/llvm" \
  BUN_TOOLCHAIN_RUST="$rust_sysroot" \
  GIT_SHA="$rev" \
  bun scripts/build.ts --profile=release --os=darwin --arch=aarch64 --lto=off --aot=off \
    --cache-dir="$work/bun-cache" --build-dir=build/toolbox-darwin --target=bun -j"$(nproc)"
endphase
lap build

binary="$src/build/toolbox-darwin/bun"
test -f "$binary"
phase 'Inspect the Mach-O file'
"$tools/llvm/bin/llvm-objdump" --macho --private-header "$binary" | sed -n 1,12p
"$tools/llvm/bin/llvm-otool" -L "$binary"
endphase

install -Dm755 "$binary" "$out/bun"
printf '%s\n' "$build_id" > "$out/build-id"
{
  printf 'patchlevel=%s\nbuild_id=%s\nbinary_bytes=%s\n' "$patchlevel" "$build_id" "$(stat -c %s "$binary")"
  for k in toolchains source build; do printf 'seconds_%s=%s\n' "$k" "${timing[$k]}"; done
} | tee "$out/build-info"
{
  printf '### Darwin cross build\n\n'
  sed 's/^/- /' "$out/build-info"
} >> "$GITHUB_STEP_SUMMARY"
