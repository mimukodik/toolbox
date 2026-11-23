# Effect lint parity

Run **Effect lint parity** in GitHub Actions on Blacksmith. The harness uses
stock Bun 1.4.5 as its TypeScript runtime.

- Effect's fixtures and baselines come from `@effect/tsgo@0.70.0` at
  `0e722d359c969bdf1b1316f08e8637022cde3cce`. The fixture manifest and its
  dependency resolutions are copied from that revision's pnpm workspace.
- The reference linter uses `@effect/tsgo` 0.70.0, `oxlint` 1.94.0, and
  `tsrs` 0.25.0-ts7.1.0-beta. Its lockfile uses the resolutions from
  slack-listener at `8132eccf4db7799dc3647e467ddc08f7384aa9a8`.
- The default subject is Toolbox's Linux x86-64 release
  `bun-1.4.6-canary.1-b15f513-p5`. The workflow pins the SHA-256 published
  with the release and passes it to the installer from the release tag.

## Run and extend the harness

From the Actions tab, run **Effect lint parity** on the branch with the change.
A pull request also runs it when the harness or workflow changes. The
`effect-parity` artifact contains the fixture inventory, parsed baselines,
raw command output, and per-fixture scores. The job summary groups the score and
wall time by linter. Matching uses fixture, file, line, column, and rule.
Severity and message text are comparison fields.

To score another Bun release, change the release tag and published SHA-256 in
the workflow. Update the gated Bun rules in `score.ts`. To change the
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

The pinned Bun release score is informational and uses all severities from the compiler baselines.

To gate a candidate Bun build, run **Effect lint parity** on the candidate
branch and supply `bun_build_run`, the successful **Build and prove Bun lint**
run ID. The workflow accepts a build from the same repository and commit, or
from an ancestor when changes are confined to the parity harness, its
workflow, and the documented difference list. It verifies the closure
checksum before importing the build artifact. The `effect-parity` artifact
records the build run, build commit, parity commit, checksum, and Bun
revision alongside the parity evidence. Set `regenerate_rule_docs` to run
`bun src/codegen/lint-rule-docs.ts --write` with that same candidate and check
that it reproduces the patched rule pages, index, and example reports.

The candidate gate checks all 195 Oxlint diagnostics across the
[19 Bun Effect rules](../bun/README.md). It requires 194 exact locations, the
[listed pipe-stage move](../bun/effect-port-differences.md#relation-overload-recovery),
and zero fixture execution or parsing failures. Against the direct compiler
it requires the same locations and move, the exact 35 lower-severity
omissions described above, and matching severity at every shared location.
Oxlint formats the compiler's warnings as errors in Unix output.

## Generated differential

Each run that scores a candidate also generates a report on Blacksmith. The
report step runs after the gate, has a five-minute limit, and cannot fail
the job. It uses the locked Oxlint parser's TypeScript AST to rewrite the
standalone v4 fixtures whose baselines mention the 19 gated rules. Virtual-file fixtures stay in the fixture gate.
A separate strict TypeScript project exercises each missing-channel rule in
`satisfies`, reassignment, class property initializers, default parameters,
object properties, concise callback returns, array elements, inferred generic
calls and JSX attributes. The report includes both references and Bun by
position and rule.
The AST pass runs just the generator rule, using the existing Oxlint install.

Seed 2431 selects one edit site per eligible fixture, mutation, and rewrite
direction, preferring sites that contain a baseline diagnostic. The corpus
includes every seed as a control and every eligible seed for each mutation.
Pipe mutations toggle between function and method syntax on known Effect receivers and
switch eligible dual overload calls between direct and curried forms.
Other mutations copy eligible seeds as TSX, route imports through a
symlinked Effect package alias, and put a bare Effect into eligible
initializers of existing classic `for` loops.

The `optional-pipe-receiver` mutation uses a typed identity function to give a
known Effect receiver type `Effect | undefined` before calling `?.pipe`. The
receiver still evaluates once, and the steps and explicit type arguments are
preserved. These cases run separately with strict null checks. The report
includes a dedicated `Effect.try` probe and counts reports from the
`catchUnfailableEffect` seed variants.

The `pipeable-declared-types` probes use the `traverse` and `reordered`
overloads from Effect's pinned `pipingFlows_selfDualOverloads` and
`pipingFlows_dataFirstOverloads` fixtures. Each probe takes the data-first and
data-last forms through `Effect.sync`. The `reordered` probes compare an
inline conditional with the same conditional instantiated through a generic
member. The report shows where `lazyPromiseInEffectSync` lands on each form.

The expected/real type probes move the fixture’s nested Effect between an
annotated and inferred const, a function return, a typed argument, and
overloads with matching, mixed, or `void` and `never` success channels. The
`effect-runner-alias` probe checks a local alias of `Effect.runSync`. The fixture
gate and Bun suite cover platform `runMain`. The report includes the diagnostic
locations from all three engines.

The same corpus runs in a single-config project and in a project whose
child config redeclares the base config's plugin by name.
The single and base configs set `floatingEffect` to warning to exercise
inheritance of a setting that differs from the default.
Two separate projects exercise a project-supplied global `Error` with
`noLib` and a path-scoped override disabling `floatingEffect` for generated
files. The override project compares Bun directly with Effect's compiler
to measure the compiler's scoped configuration.

Each project batches the compiler, slack-listener and candidate commands.
The comparison uses file, line, column, rule, and visible severity.
As in the gate, the compiler pass supplies the severity that the Oxlint Unix
formatter collapses to error. Only errors and warnings are counted.

In the `effect-parity` artifact, `differential-summary.md` gives the counts by
mechanism and rule, documented coverage, case availability, corpus size,
and wall time.
A difference is listed when the [difference list](../bun/effect-port-differences.md)
predicts its mechanism, rule, and outcome. The step tests the classifier on
two synthetic severity mismatches before starting the linters.
`differential-differences.json` records every disagreement and any matching
prediction. Each new mechanism gets its smallest affected file under
`differential-repros/`, with the project config and any local re-export it
needs. To replay one, make the locked fixture dependencies available from
that directory and run the reference and candidate commands against it with
`--tsconfig tsconfig.json` (the direct compiler uses `-p tsconfig.json`).
For a `package-manifest` reproduction, also run
`ln -s effect node_modules/effect-differential-alias` in the reproduction root.

## Bun p1 findings

P1 matched 66 of the 67 `floatingEffect` locations and emitted 22 extras.
A `satisfies` expression in `promiseInEffectSuccess.ts` accounts for both the
miss and one extra. Effect highlights column 30 on line 80, while p1 highlights
column 1. The other 21 extras occur at expressions covered by Effect
suppression directives. The artifact lists every location.

The location score includes the message on line 23 and the suggestion on
line 27 of `floatingEffect_directivePrecedence.ts`. P1 reported both as errors.
The slack-listener command omits both. P1 agreed with the baseline severity
at 59 of the 66 matching locations.

In [Blacksmith run 45038112140](https://github.com/mimukodik/toolbox/actions/runs/45038112140), the workflow took
101 s from creation to completion, including 94 s on
Blacksmith (1.57 job-minutes).

| Pass over 553 fixtures | Wall time |
| --- | ---: |
| Effect TSRS compiler | 34.78 s |
| Effect TSRS Oxlint | 40.92 s |
| Patched Bun p1 | 4.85 s |
