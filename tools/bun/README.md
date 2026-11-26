# Patched Bun

Toolbox adds nineteen Effect v4 rules to Bun's native `bun lint`, and a
test input recorder to `bun test --isolate` (patch 07, below).
Bun 1.4.5 has no `bun lint` command, so the Linux x86-64 build uses
Bun 1.4.6-canary.1 at
[`0966e99d8f357833a147af2a4bce7d66321829c1`](https://github.com/oven-sh/bun/commit/0966e99d8f357833a147af2a4bce7d66321829c1).
Move the pin to the first Bun release that includes `bun lint`.

## Install

Use the `bun-1.4.6-canary.1-0966e99-p3` release. Copy `sha256` from the
release's `.tar.zst.sha256` file and run [the Toolbox installer](../../README.md)
from the same tag.

```sh
tag=bun-1.4.6-canary.1-0966e99-p3
url="https://github.com/mimukodik/toolbox/releases/download/$tag/$tag-x86_64-linux.tar.zst"
sudo sh ./install.sh "$url" "$sha256"
bun --version
bun lint --help
```

## Build and use the rules

Both packages use the same release build with LTO and AOT disabled. The
patched package applies the patches in this directory at patch level `p3`.
The unpatched package is the control. Both load Nix's shared libstdc++ at
start, so native addons built against it, such as `sharp`, load. Patch level
`p1` could not load them, and the release's Ubuntu smoke test now loads
`sharp`. Patch level `p3` fixes the recorder's wrong reuses found in review
(see below).

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
| `missingEffectError` | `bun/missing-effect-error` | Error |
| `missingEffectContext` | `bun/missing-effect-context` | Error |
| `missingLayerContext` | `bun/missing-layer-context` | Error |

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

## Test input recorder

`patches/07-test-input-recorder.patch` adds a native recorder to
`bun test --isolate`. It is off unless you set a variable below, and then it
only adds work around the resolver and the transpiler. It is the difference
between this pin and the `native-recorder-p2` branch of our Bun checkout
(commit `819c1243295aa8d82f3db6da62c7b01d3d456816`), which starts at this pin,
so it needs no fix-ups.

| Variable | Effect |
| --- | --- |
| `BUN_TEST_INPUT_RECORD_DIR=<dir>` | Records what each test file's pass depended on into one store in `<dir>` (`store.btis`, with `segments/` for the processes still running). A record lists the file's resolutions (question and answer), the modules it loaded with a SHA-256 of their source, what its own code read through `node:fs`, `Bun.file`, `Bun.Glob`, snapshots and `Bun.mmap`, what it did that a record cannot replay (spawn, FFI, workers, SQLite, macros), and its outcome counts. When a file ends, what each path its own code wrote now holds is recorded too, so a file is reused only while its outputs are still on disk as it left them; otherwise it runs with the reason `own-write` (paths under a directory `fs.mkdtemp` made are left out). A file that writes different bytes to a fixed path on every run is therefore never reused. A file keeps its last four distinct states. A module that the file's own code wrote before it imported it is not an input. A module loaded with a query such as `?raw` is hashed as its file. Paths in a record are relative to the repository root, so records hold in another checkout of the same files (store format version 2; an older store is ignored with a line saying so). Needs `--isolate`; `--parallel` implies it. |
| `BUN_TEST_INPUT_REUSE=1` | With a record directory, skips every test file whose record still holds and counts its recorded results in the summary. `explain` also says why each other file runs. `check` runs every file anyway and fails the run when a file whose record held ends with other pass, skip or todo counts; a different number of `expect()` calls alone is only reported, because it is not deterministic in every test. `list` says for each file whether it would run and why, and runs none. Unset, `0`, `false`, `no` and `off` are off; any other unknown value is an error, so a mistyped off switch cannot skip files. A run with coverage or `--aot` never records or reuses. With `--shard`, the files are dealt to shards before reuse is decided, so every shard deals the same list whatever its store holds. After `--bail` stops a run, each file that was to be reused but whose record no longer holds prints `<file>: not run after --bail: <why>`. Recording and reuse are unavailable off Unix. |
| `BUN_TEST_INPUT_REUSE_REPORT=<file>` | Writes one JSON line per file saying whether its record held and why not. |
| `BUN_TEST_INPUT_RECORD_SALT=<text>` | Part of every record's fingerprint, for what you know changes outcomes, such as a database version. |
| `BUN_TEST_INPUT_RECORD_ENV=<A,B>` | Environment variables whose values are part of the fingerprint. |
| `BUN_TEST_INPUT_RECORD_ROOT=<dir>` | The record root that paths are relative to, resolved against the project directory. Default: the nearest directory at or above the project directory with `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock` or `package-lock.json`, else the project directory. The root is in no hash; the fingerprint holds the project directory relative to it, so two packages never share a fingerprint. A lockfile in a directory above the repository would make that the root; set this variable to override it. |
| `BUN_TEST_INPUT_RECORD_JSON=1` | Also writes each record as JSON beside the store, to read. |

`BUN_TEST_INPUT_RECORD_FINGERPRINT` is internal: a `--parallel` coordinator
hands its fingerprint to its workers with it. `BUN_TEST_INPUT_BUILD_ID` is read
when Bun is compiled and hashed with the recorder's sources into a 64-bit build
identity. The patched package sets it to `<patch level>-<first 16 hex of the
SHA-256 of patches 01 to 07 and the patch level>`, so a record never outlives
the level or a byte of the series that made it. It reaches rustc because Bun's
Rust runner starts each rustc with the build's own environment.

The fingerprint covers the Bun build, the flags that change how tests run,
the transpiler's options and the environment Bun itself acts on, so a Bun
upgrade makes every record stale (and says so once).

Proof: `upstream-tests.txt` lists `cli/test/isolation.test.ts` with an `only`
line that runs the recorder's cases (`BUN_TEST_INPUT_*`) and none of the file's
other upstream tests. On a manual run of any branch the workflow keeps the
tested release tarball as the `bun-release` artifact.

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

`patches/06-effect-relation-errors.patch` adds the three missing-channel rules,
their expected/actual type comparisons, regression cases and rule docs. It
uses Bun's existing type queries. The generated rule index and reports are
the only upstream-owned files touched by this patch.

`patches/07-test-input-recorder.patch` adds `src/jsc/TestInputRecorder.rs`,
`src/jsc/TestInputStore.rs`, `src/jsc/TestOwnReads.rs` and
`src/runtime/cli/test/InputReuse.rs`, one `bun_glob` dependency of `bun_jsc`
(with its `Cargo.lock` line), the recorder's cases in
`test/cli/test/isolation.test.ts`, and small hooks in about thirty existing
files: the resolver and module loading in `VirtualMachine.rs`,
`RuntimeTranspilerStore.rs` and `jsc_hooks.rs`, `bun test` in
`test_command.rs`, and the file APIs it records or marks (`node:fs`,
`Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.spawn`, the shell, SQLite, FFI).

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
