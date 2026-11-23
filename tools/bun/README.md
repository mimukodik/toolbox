# Patched Bun

Toolbox adds sixteen Effect v4 rules to Bun's native `bun lint`.
Bun 1.4.5 has no `bun lint` command, so the Linux x86-64 build uses
Bun 1.4.6-canary.1 at
[`b15f51302d72e1cd9038ecd0cf33782c02ee7681`](https://github.com/oven-sh/bun/commit/b15f51302d72e1cd9038ecd0cf33782c02ee7681).
Move the pin to the first Bun release that includes `bun lint`.

## Install

Use the `bun-1.4.6-canary.1-b15f513-p6` release. Copy `sha256` from the
release's `.tar.zst.sha256` file and run [the Toolbox installer](../../README.md)
from the same tag.

```sh
tag=bun-1.4.6-canary.1-b15f513-p6
url="https://github.com/mimukodik/toolbox/releases/download/$tag/$tag-x86_64-linux.tar.zst"
sudo sh ./install.sh "$url" "$sha256"
bun --version
bun lint --help
```

## Build and use the rules

Both packages use the same release build with LTO and AOT disabled. The
patched package applies the patches in this directory at patch level `p6`.
The unpatched package is the control.

```sh
nix build .#bun
nix build .#bun-unpatched --out-link result-unpatched
```

Enable the `@effect/language-service` TypeScript plugin and run
`bun lint --type-aware src`. You can also enable type-aware linting with
`options.typeAware` in `.oxlintrc.json`. Bun reads
`compilerOptions.plugins[].diagnosticSeverity` from the selected project for
each file, including referenced projects.

| Effect rule | Bun rule | Default severity |
| --- | --- | --- |
| `floatingEffect` | `bun/floating-effect` | Error |
| `globalErrorInEffectFailure` | `bun/global-error-in-effect-failure` | Warning |
| `globalErrorInEffectCatch` | `bun/global-error-in-effect-catch` | Warning |
| `unknownInEffectCatch` | `bun/unknown-in-effect-catch` | Warning |
| `effectInFailure` | `bun/effect-in-failure` | Warning |
| `anyUnknownInErrorContext` | `bun/any-unknown-in-error-context` | Off |
| `unsafeEffectTypeAssertion` | `bun/unsafe-effect-type-assertion` | Off |
| `tryCatchInEffectGen` | `bun/try-catch-in-effect-gen` | Suggestion |
| `returnEffectInGen` | `bun/return-effect-in-gen` | Suggestion |
| `missingStarInYieldEffectGen` | `bun/missing-star-in-yield-effect-gen` | Error |
| `missingReturnYieldStar` | `bun/missing-return-yield-star` | Error |
| `effectTryWithoutCatch` | `bun/effect-try-without-catch` | Off |
| `catchUnfailableEffect` | `bun/catch-unfailable-effect` | Suggestion |
| `lazyPromiseInEffectSync` | `bun/lazy-promise-in-effect-sync` | Warning |
| `effectInVoidSuccess` | `bun/effect-in-void-success` | Warning |
| `runEffectInsideEffect` | `bun/run-effect-inside-effect` | Suggestion |

Effect's `@effect-diagnostics` and `@effect-diagnostics-next-line` directives
can change the severity or suppress reports. Bun displays Effect errors and
warnings. Set a suggestion rule's severity to warning or error to see its reports.
The Unix formatter spells `bun/floating-effect` as
`bun(floating-effect)`, and uses the same convention for the other rules.

The build reuses Bun's Ninja graph and URL-keyed prefetch cache. Nix
pins the source archives, the prebuilt WebKit with JavaScriptCore, Node
headers and Bun's Ninja. Cargo's workspace and Rust standard library
dependencies are vendored together. Bun's npm lockfile converter supplies
the lockfiles used to prefetch the three JavaScript dependency trees.
Only fixed-output fetch and vendor derivations use the network.
Both variants omit zstd debug-section compression because the pinned
nixpkgs LLVM build lacks that option.

When changing the Bun pin, compare `scripts/build/ci-images/spec.ts`,
`scripts/build/deps/`, `scripts/build/deps/webkit.sha256`, and
`rust-toolchain.toml` in the new source. Update the prefetch URLs and
hashes. Build `.#bun-unpatched.cargoDeps` and `.#bun-unpatched.npmDeps`
to refresh the vendor hashes when their inputs change. Apply the Effect
patches at the new commit and run the Blacksmith proof for both variants.

## Upstream patch files

Existing Bun files changed by `patches/01-effect-seams.patch`:

- `docs/lint/rules/index.mdx`
- `docs/lint/rules/reports.json`
- `src/lint/context.rs`
- `src/lint/driver/for_tests.rs`
- `src/lint/driver/lib.rs`
- `src/lint/driver/rules.rs`
- `src/lint/driver/run.rs`
- `src/lint/driver/typed.rs`
- `src/lint/linter/resolved.rs`
- `src/lint/linter/schema/own.json`
- `src/lint/plugins/lib.rs`
- `src/sema/resolve.rs`

New files added by `patches/02-effect-rules.patch`:

- Seven rule pages under `docs/lint/rules/bun/`
- `src/lint/driver/effect.rs`
- `src/lint/plugins/effect/mod.rs`
- `src/lint/plugins/effect/type_parser.rs`
- `src/lint/plugins/effect/rules/bun_*.rs`
- `test/cli/lint/effect.test.ts`

`patches/03-effect-generators.patch` adds `src/lint/plugins/effect/generator_context.rs`,
the four generator rule modules and their rule pages. It extends the Effect
registration and refreshes the generated rule index and example reports.

`patches/04-effect-piping.patch` adds the piping-flow and overload-shape
modules, three piping rules and their rule pages. It extends registration and
refreshes the generated index and example reports.

`patches/05-effect-contextual-types.patch` adds the expected/real type pairing
and platform runtime lookup modules, two rules and their pages. It extends the
Effect registrations, regression fixtures and generated rule docs.

The Nix build also edits the existing `scripts/build/flags.ts` to disable
debug-section compression for both variants.

## Build and install proof

The **Build and prove Bun lint** workflow records the build cost for both
variants, runs the diagnostic cases and timing at the pinned slack-listener
commit, and uploads its output as `bun-lint-proof`. It measures the patched
runtime archive and installs it with `install.sh` in a clean Ubuntu 24.04
container. The installed Bun runs the slack-listener tests at `8132ecc`.

The Bun lint test step reads every regular `tools/bun/patches/*.patch` file
in lexical order, applies its changes to top-level `test/cli/lint/*.test.ts`
files, and runs each test file those patches touch.

The `main` workflow publishes the tested archive, its SHA-256 file, and
`manifest.json` in the matching GitHub Release. Download the
`bun-patched-x86_64-linux` or `bun-unpatched-x86_64-linux` Actions artifact
to import its runtime closure on a Linux x86-64 machine with Nix:

```sh
zstd -dc closure.nix-export.zst | nix-store --import
"$(cat store-path.txt)/bin/bun" --version
```

The source patches are subject to Bun's MIT license. They adapt Effect's
MIT-licensed [rules](https://github.com/Effect-TS/tsgo/tree/0e722d359c969bdf1b1316f08e8637022cde3cce/crates/ets_rules/src),
[type parser](https://github.com/Effect-TS/tsgo/tree/0e722d359c969bdf1b1316f08e8637022cde3cce/crates/ets_typeparser/src),
and [directive parser](https://github.com/Effect-TS/tsgo/blob/0e722d359c969bdf1b1316f08e8637022cde3cce/crates/ets_directives/src/parser.rs).
