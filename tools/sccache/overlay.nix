final: prev:
let
  upstreamCommit = "4a138d78794bf3c1df11adfdef2ad49fed05b031";
in
{
  sccache = prev.sccache.overrideAttrs (old: {
    version = "0.20.0";
    src = final.fetchurl {
      url = "https://codeload.github.com/mozilla/sccache/tar.gz/${upstreamCommit}";
      name = "sccache-${upstreamCommit}.tar.gz";
      sha256 = "de8af6632af953150350b68eaf0cc49bb4c13f2935e1ff4e378a6f6958c4be74";
    };
    cargoDeps = final.rustPlatform.importCargoLock {
      lockFile = builtins.fetchurl {
        url = "https://raw.githubusercontent.com/mozilla/sccache/${upstreamCommit}/Cargo.lock";
        sha256 = "a08f5abdbe25e71c55da1c4b20a002f08feecfa3011f96d6b4197d3c5bf4140b";
      };
    };
    buildInputs = old.buildInputs ++ [ final.aws-lc ];
    patches = (old.patches or [ ]) ++ [
      ./patches/cargo-build-dir.patch
      ./patches/remap-paths.patch
    ];

    postInstall = (old.postInstall or "") + ''
      install -Dm444 LICENSE "$out/share/licenses/sccache/LICENSE"
    '';

    # These unit tests need neither a server socket nor external services.
    doCheck = true;
    cargoTestFlags = [ "--lib" ];
    checkFlags = [
      "--exact"
      "compiler::rust::test::test_equal_hashes_out_dir_in_cargo_build_root"
      "compiler::rust::test::test_hash_key_basedirs_remap_paths"
    ];

    passthru = (old.passthru or { }) // { inherit upstreamCommit; };
  });
}
