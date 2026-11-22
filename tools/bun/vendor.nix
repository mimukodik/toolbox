{
  pkgs,
  src,
  rust,
  archives,
}:

let
  unpack = paths: ''
    python3 - ${src} '${paths}' <<'PYTHON'
    import re
    import sys
    import tarfile

    paths = re.compile(sys.argv[2])

    def include(member, destination):
        path = member.name.partition("/")[2]
        if not member.isfile() or not paths.search(path):
            return None
        return tarfile.data_filter(member, destination)

    with tarfile.open(sys.argv[1], "r|gz") as archive:
        archive.extractall(filter=include)
    PYTHON
    cd bun-*
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    if [[ -r "''${NIX_SSL_CERT_FILE:-}" ]]; then
      export SSL_CERT_FILE="$NIX_SSL_CERT_FILE"
    fi
  '';

  fixed = hash: {
    outputHash = hash;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars ++ [ "NIX_SSL_CERT_FILE" ];
  };

  lolhtml = archives."https://github.com/oven-sh/lol-html/archive/725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e.tar.gz";
  argon2 = archives."https://github.com/sru-systems/rust-argon2/archive/ed81866f163f0c7026aa6fd8388adf37242eb32a.tar.gz";

  # Bun's Rust workspace has two archive path dependencies. std has a
  # separate lockfile used by -Zbuild-std, so vendor it in the same pass.
  cargoDeps = pkgs.runCommand "bun-cargo-vendor" (
    fixed "sha256-bZBfHrmJc51CfoivmW2OuKp25c4zDUhFXTXW22Ny/e8="
    // {
      nativeBuildInputs = [ pkgs.python3 rust ];
    }
  ) ''
    ${unpack ''^\.cargo/|(^|/)(Cargo\.(toml|lock)|[^/]+\.rs)$''}
    mkdir -p vendor/lolhtml vendor/rust-argon2
    tar -xzf ${lolhtml} --strip-components=1 -C vendor/lolhtml
    tar -xzf ${argon2} --strip-components=1 -C vendor/rust-argon2
    export CARGO_HOME="$TMPDIR/cargo-home"
    export CARGO_HTTP_CAINFO="$SSL_CERT_FILE"
    cargo vendor --locked --versioned-dirs \
      --sync "${rust}/lib/rustlib/src/rust/library/Cargo.toml" "$out"
  '';

  # Use Bun's existing bun.lock -> package-lock.json conversion. The adapter
  # called in place of npm copies the locked registry packages into a cache.
  npmDeps = pkgs.runCommand "bun-npm-cache" (
    fixed "sha256-hqUhz3AyByDeCBrryDUR+KqreWm2ebQKWdEUrDrru0o="
    // {
      nativeBuildInputs = [ pkgs.python3 pkgs.bun pkgs.prefetch-npm-deps ];
    }
  ) ''
    ${unpack ''(^|/)package\.json$|^(packages/bun-error/|src/node-fallbacks/)?bun\.lock$|^scripts/build/npm-ci\.ts$''}
    mkdir -p "$out"
    cat > "$TMPDIR/prefetch-with-lock" <<'SCRIPT'
    #!${pkgs.runtimeShell}
    set -eu
    case "$1" in
      ci) prefetch-npm-deps package-lock.json "$NPM_CACHE_OUTPUT" ;;
      rebuild) ;;
      *) exit 2 ;;
    esac
    SCRIPT
    chmod +x "$TMPDIR/prefetch-with-lock"
    for dir in . packages/bun-error src/node-fallbacks; do
      export NPM_CACHE_OUTPUT="$out/$(basename "$(realpath "$dir")")"
      bun scripts/build/npm-ci.ts "$TMPDIR/prefetch-with-lock" "$dir"
    done
  '';
in
{
  inherit cargoDeps npmDeps;
}
