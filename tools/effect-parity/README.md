# Effect lint parity

Run **Effect lint parity** in GitHub Actions on Blacksmith. The harness uses
stock Bun 1.4.5 as its TypeScript runtime.

- Effect's fixtures and baselines come from `@effect/tsgo@0.70.0` at
  `0e722d359c969bdf1b1316f08e8637022cde3cce`. The fixture manifest and its
  dependency resolutions are copied from that revision's pnpm workspace.
- The reference linter uses `@effect/tsgo` 0.70.0, `oxlint` 1.94.0, and
  `tsrs` 0.25.0-ts7.1.0-beta. Its lockfile uses the resolutions from
  slack-listener at `8132eccf4db7799dc3647e467ddc08f7384aa9a8`.
- The subject is Toolbox's Linux x86-64 release
  `bun-1.4.6-canary.1-b15f513-p1`. The workflow pins the SHA-256 published
  with the release and passes it to the installer from the release tag.
