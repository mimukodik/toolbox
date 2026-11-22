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

## Run and extend the harness

From the Actions tab, run **Effect lint parity** on the branch with the change.
A pull request also runs it when the harness or workflow changes. The
`effect-parity` artifact contains the fixture inventory, parsed baselines,
raw command output, and per-fixture scores. The job summary groups the score and
wall time by linter. Matching uses fixture, file, line, column, and rule.
Severity and message text are comparison fields.

To score another Bun release, change the release tag and published SHA-256 in
the workflow. Add its rule IDs to the Bun mapping in `score.ts`. To change the
reference rule set, update `parityRules` in `diagnostics.ts` and reconcile the
reference gates with the pinned baselines.

The generated configs set `includeSuggestionsInTsc: true` on the Effect
plugin for all passes. Two reference gates must pass before Bun runs.

1. `effect-tsgo tsrs --noEmit` must match all 230 baseline diagnostics across
   the 19 rules with zero extras.
2. The slack-listener `effect-tsgo --tsrs-lint oxlint` command must match all
   195 error and warning diagnostics with zero extras. The only expected
   omissions are 34 suggestions and one message.
   [Patch 180](https://github.com/Effect-TS/tsgo/blob/0e722d359c969bdf1b1316f08e8637022cde3cce/_patches/tsrs/180-lint-type-check-severity.patch)
   filters those categories before Oxlint receives type-check diagnostics.

The Bun comparison uses the full `floatingEffect` baseline, including its
suggestion and message. Its score is informational.
