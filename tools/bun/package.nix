{
  lib,
  bun-src,
  bootstrapBun,
  patched,
  callPackage,
  cmake,
  fetchurl,
  git,
  llvmPackages_23,
  ninja,
  perl,
  pkg-config,
  python3,
  runCommand,
  rust-bin,
  rustPlatform,
  stdenvNoCC,
  unzip,
  xz,
  zstd,
}:
let
  version = "1.4.6-canary.1";
  patchlevel = lib.strings.trim (builtins.readFile ./PATCHLEVEL);
  llvm = llvmPackages_23;
  rust = rust-bin.nightly."2026-11-14".minimal.override { extensions = [ "rust-src" ]; };
  bunCargo = rustPlatform.importCargoLock { lockFile = "${bun-src}/Cargo.lock"; };
  rustCargo = rustPlatform.importCargoLock {
    lockFile = builtins.fetchurl {
      url = "https://raw.githubusercontent.com/rust-lang/rust/5f4effd579500175af844241eb179e756190f1e7/library/Cargo.lock";
      sha256 = "e3007071f73ee4fddcf817e4a19c1ecea766b590c9a5469980341aa79473914e";
    };
  };
  cargoVendor = runCommand "bun-cargo-vendor" { } ''
    mkdir "$out"
    for vendor in ${bunCargo} ${rustCargo}; do
      for crate in "$vendor"/*; do
        if [[ -d "$crate" && ! -e "$out/''${crate##*/}" ]]; then
          ln -s "$(readlink -f "$crate")" "$out/"
        fi
      done
    done
  '';
  npmVendor = stdenvNoCC.mkDerivation {
    pname = "bun-npm-vendor";
    inherit version;
    src = bun-src;
    nativeBuildInputs = [ bootstrapBun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      for project in . packages/bun-error src/node-fallbacks; do
        (cd "$project" && bun install --frozen-lockfile --ignore-scripts)
      done
    '';
    installPhase = ''
      for project in . packages/bun-error src/node-fallbacks; do
        mkdir -p "$out/$project"
        cp -a "$project/node_modules" "$out/$project/"
      done
    '';
    outputHashMode = "recursive";
    outputHash = "sha256-PncRz9AfubyfDkvJUaMYb39ceMftHc5xipG8yqqUukU=";
  };
  prefetch = callPackage ./dependencies.nix { };
  ninjaTag = "bun-ninja-5ecd8831";
  ninjaArchive = fetchurl {
    url = "https://github.com/oven-sh/ninja/releases/download/${ninjaTag}/bun-ninja-linux-x64.zip";
    sha256 = "1521dc92e7ebcdccbc259ff41e4c27a5a7982bcf183e37b1fc6ea5a603379f0c";
  };
  release = llvm.stdenv.mkDerivation {
    pname = if patched then "bun-toolbox" else "bun-unpatched";
    version = version + lib.optionalString patched "-${patchlevel}";
    src = bun-src;
    patches = lib.optionals patched (lib.mapAttrsToList
      (name: _: ./patches + "/${name}")
      (lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".patch" name)
        (builtins.readDir ./patches)));
    nativeBuildInputs = [
      bootstrapBun
      cmake
      git
      llvm.lld
      llvm.llvm
      ninja
      perl
      pkg-config
      python3
      rust
      unzip
      xz
      zstd
    ];
    dontConfigure = true;
    dontStrip = true;
    hardeningDisable = [ "all" ];
    enableParallelBuilding = true;

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR/home"
      export CARGO_HOME="$TMPDIR/cargo"
      export CARGO_NET_OFFLINE=true
      export GIT_SHA=${bun-src.rev}
      export BUN_BUILD_PREFETCH_DIR=${prefetch}
      export BUN_TOOLCHAIN_RUST=${rust}
      mkdir -p "$HOME" "$CARGO_HOME"
      cat > "$CARGO_HOME/config.toml" <<CONFIG
      [source.crates-io]
      replace-with = "vendor"
      [source.vendor]
      directory = "${cargoVendor}"
      CONFIG

      cp -a --no-preserve=mode,ownership ${npmVendor}/. .
      # Codegen calls bun install for these ready-made trees. Keep its build
      # graph intact while ensuring those install edges never use the network.
      substituteInPlace scripts/build/codegen.ts \
        --replace-fail 'cd $dir && ''${bun} install --frozen-lockfile && ''${touch} $stamp' \
                       'cd $dir && test -d node_modules && ''${touch} $stamp'

      cache="$TMPDIR/bun-cache"
      mkdir -p "$cache/ninja/${ninjaTag}"
      unzip -q ${ninjaArchive} -d "$cache/ninja/${ninjaTag}"
      chmod +x "$cache/ninja/${ninjaTag}/ninja"
      bun scripts/build.ts --profile=release --lto=off --debug-info=none \
        --cache-dir="$cache" --build-dir="$PWD/out" -j"$NIX_BUILD_CORES"
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      install -Dm755 out/bun "$out/bin/bun"
      runHook postInstall
    '';
    passthru = { inherit npmVendor; };
    meta = {
      description = "Source-built Bun canary for the Toolbox Effect lint experiment";
      mainProgram = "bun";
      platforms = [ "x86_64-linux" ];
      license = lib.licenses.mit;
    };
  };
in
release
