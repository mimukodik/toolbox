# Codex foreground waits

The patch gives an omitted `exec_command` wait a 15-minute default and raises
its cap to 20 minutes. A command that finishes sooner still returns promptly.
An empty `write_stdin` poll defaults to the configured background terminal
timeout. Writes with input keep their 250 ms default and 30-second cap.
Short polling on long commands accounted for 7.6–14% of measured token spend
in the rollout investigation.

Remove the patch when upstream Codex waits for long commands by default.

After changing the nixpkgs pin, run the Blacksmith build workflow on the PR.
`nix build .#codex` applies the patch and runs the focused `codex-core` unit
tests listed in the overlay. The workflow checks the CLI version, checks that
the companion is executable, and runs both shipped binaries in Ubuntu without
Nix. When updating Codex, update the expected version in the smoke checks and
publish under a new version or patch level.
