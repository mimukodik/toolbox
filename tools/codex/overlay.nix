_final: prev: {
  codex = prev.codex.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./patches/exec-wait.patch ];

    # The pinned nixpkgs hook only removes thin LTO and the four codegen units.
    postPatch = "";

    postInstall = (old.postInstall or "") + ''
      install -Dm444 ../LICENSE "$out/share/licenses/codex/LICENSE"
      install -Dm444 ../NOTICE "$out/share/licenses/codex/NOTICE"
    '';

    # Nixpkgs disables the full suite. Run these Linux unit tests with the
    # same release profile and vendored sources as the CLI.
    doCheck = true;
    cargoTestFlags = [
      "--package"
      "codex-core"
      "--lib"
    ];
    checkFlags = [
      "--exact"
      "unified_exec::process_manager::tests::initial_exec_yield_time_has_no_platform_floor"
      "unified_exec::process_manager::tests::stdin_poll_defaults_to_the_configured_timeout"
      "unified_exec::tests::stdin_approval_preserves_the_reviewed_terminal"
      "unified_exec::tests::stdin_approval_observes_strict_review_enabled_while_queued"
    ];
  });
}
