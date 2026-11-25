{ pkgs }:

let
  inherit (pkgs) lib;
  rev = "0966e99d8f357833a147af2a4bce7d66321829c1";
  version = "1.4.6-canary.1";
  patchlevel = lib.removeSuffix "\n" (builtins.readFile ./PATCHLEVEL);
  src = pkgs.fetchurl {
    url = "https://codeload.github.com/oven-sh/bun/tar.gz/${rev}";
    name = "bun-${rev}.tar.gz";
    hash = "sha256-HR0sQuY75Av3mZ/yBVqAsoCpOy8Sodumgfa7cIW4QPo=";
  };

  # Match Bun's build pins (scripts/build/ci-images/spec.ts and rust-toolchain.toml).
  llvm = pkgs.llvmPackages_23;
  llvmTools = pkgs.buildEnv {
    name = "bun-llvm-tools";
    paths = [ llvm.clang llvm.lld llvm.llvm ];
    # Use Nix's wrappers for libc and the same libstdc++ ABI as WebKit.
    pathsToLink = [ "/bin" ];
  };
  rust = pkgs.rust-bin.nightly."2026-11-14".minimal.override {
    extensions = [ "rust-src" ];
  };
  ninjaTag = "bun-ninja-5ecd8831";
  ninja = pkgs.fetchurl {
    url = "https://github.com/oven-sh/ninja/releases/download/${ninjaTag}/bun-ninja-linux-x64.zip";
    sha256 = "1521dc92e7ebcdccbc259ff41e4c27a5a7982bcf183e37b1fc6ea5a603379f0c";
  };

  # Bun looks up the original URLs here. GitHub source archives are served by
  # codeload. WebKit and Node's headers use the checksums in Bun's own tree.
  archiveHashes = builtins.fromJSON (builtins.readFile ./prefetch.json);
  archives = lib.mapAttrs (
    url: sha256:
    let
      github = builtins.match "https://github.com/([^/]+/[^/]+)/archive/([^/]+)\\.tar\\.gz" url;
    in
    pkgs.fetchurl {
      url =
        if github == null then
          url
        else
          "https://codeload.github.com/${builtins.elemAt github 0}/tar.gz/${builtins.elemAt github 1}";
      name = baseNameOf url;
      inherit sha256;
    }
  ) archiveHashes;
  prefetch = pkgs.runCommand "bun-prefetch-${version}" { } (
    ''
      mkdir -p "$out/by-url"
    ''
    + lib.concatStrings (lib.mapAttrsToList (url: archive: ''
      ln -s ${archive} "$out/by-url/${builtins.substring 0 32 (builtins.hashString "sha256" url)}"
    '') archives)
  );

  inherit (import ./vendor.nix { inherit pkgs src rust archives; }) cargoDeps npmDeps;

  patchDir = builtins.readDir ./patches;
  effectPatches = map (name: ./patches + "/${name}") (
    lib.filter (name: patchDir.${name} == "regular" && lib.hasSuffix ".patch" name) (
      builtins.attrNames patchDir
    )
  );

  buildBun =
    patched:
    llvm.stdenv.mkDerivation {
      pname = if patched then "bun-${patchlevel}" else "bun-unpatched";
      inherit version src;

      patches = lib.optionals patched effectPatches;
      postPatch = ''
        # This nixpkgs LLVM build has no zstd support for debug sections.
        substituteInPlace scripts/build/flags.ts --replace-fail ', "-gz=zstd"' ""
      '';
      strictDeps = true;
      dontUseCmakeConfigure = true;
      dontUseNinjaBuild = true;
      dontUseNinjaInstall = true;

      nativeBuildInputs = with pkgs; [
        bun
        cmake
        git
        nodejs_26
        perl
        python3
        unzip
        rust
      ];
      env = {
        BUN_TOOLCHAIN_LLVM = llvmTools;
        BUN_TOOLCHAIN_RUST = rust;
        BUN_BUILD_PREFETCH_DIR = prefetch;
        CARGO_NET_OFFLINE = "true";
        GIT_SHA = rev;
        npm_config_offline = "true";
      };

      buildPhase = ''
        runHook preBuild
        export HOME="$TMPDIR/home"
        export CARGO_HOME="$TMPDIR/cargo-home"
        export npm_config_cache="$TMPDIR/npm-cache"
        mkdir -p "$HOME" "$CARGO_HOME" "$npm_config_cache" "$TMPDIR/bun-cache/ninja/${ninjaTag}"
        for cache in ${npmDeps}/*; do
          cp -r "$cache/." "$npm_config_cache"
          chmod -R u+w "$npm_config_cache"
        done
        unzip -q ${ninja} -d "$TMPDIR/bun-cache/ninja/${ninjaTag}"
        chmod +x "$TMPDIR/bun-cache/ninja/${ninjaTag}/ninja"
        cat > "$CARGO_HOME/config.toml" <<CONFIG
        [source.crates-io]
        replace-with = "nix-vendor"
        [source.nix-vendor]
        directory = "${cargoDeps}"
        CONFIG

        bun scripts/build.ts --profile=release --lto=off --aot=off \
          --package-manager=npm --cache-dir="$TMPDIR/bun-cache" \
          --build-dir=build/toolbox --target=bun -j"$NIX_BUILD_CORES"
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        install -Dm755 build/toolbox/bun "$out/bin/bun"
        runHook postInstall
      '';

      passthru = {
        inherit cargoDeps npmDeps;
        upstreamRevision = rev;
      };
      meta = {
        description = "Bun canary built from source for the Effect lint experiment";
        homepage = "https://bun.sh";
        license = lib.licenses.mit;
        mainProgram = "bun";
        platforms = [ "x86_64-linux" ];
      };
    };
in
{
  bun = buildBun true;
  bun-unpatched = buildBun false;
}
