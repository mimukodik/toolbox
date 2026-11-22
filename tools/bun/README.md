# Patched Bun

Toolbox adds Effect v4's `floatingEffect` rule to Bun's native `bun lint`.
Bun 1.4.5 has no `bun lint` command, so the Linux x86-64 build uses
Bun 1.4.6-canary.1 at
[`b15f51302d72e1cd9038ecd0cf33782c02ee7681`](https://github.com/oven-sh/bun/commit/b15f51302d72e1cd9038ecd0cf33782c02ee7681).
Move the pin to the first Bun release that includes `bun lint`.

## Install

Use the `bun-1.4.6-canary.1-b15f513-p2` release. Copy `sha256` from the
release's `.tar.zst.sha256` file and run [the Toolbox installer](../../README.md)
from the same tag.

```sh
tag=bun-1.4.6-canary.1-b15f513-p2
url="https://github.com/mimukodik/toolbox/releases/download/$tag/$tag-x86_64-linux.tar.zst"
sudo sh ./install.sh "$url" "$sha256"
bun --version
bun lint --help
```

## Build and use the rule

Both packages use the same release build with LTO and AOT disabled. The
patched package applies the patches in this directory at patch level `p2`.
The unpatched package is the control.

```sh
nix build .#bun
nix build .#bun-unpatched --out-link result-unpatched
```

The patch reads the Effect language-service rule setting from the
TypeScript project used by native lint. Set
`compilerOptions.plugins[].diagnosticSeverity.floatingEffect` to `error`
in the `@effect/language-service` entry and run `bun lint --type-aware src`
with Bun's built-in lint configuration. You can also enable type-aware linting
in the lint configuration, for example with `options.typeAware` in `.oxlintrc.json`.
Plain `bun lint` does not activate `floatingEffect` from the Effect plugin.
The checker selects the project for each file, including referenced projects.

Bun reports `bun/floating-effect` when a statement leaves an Effect or Stream
value unused. Oxlint's Unix formatter calls it `bun(floating-effect)`.
Effect's `@effect-diagnostics` and `@effect-diagnostics-next-line` directives
can change the severity or suppress reports. Bun displays Effect errors and
warnings.

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
- `src/lint/context.rs`
- `src/lint/driver/for_tests.rs`
- `src/lint/driver/lib.rs`
- `src/lint/driver/run.rs`
- `src/lint/driver/typed.rs`
- `src/lint/linter/resolved.rs`
- `src/lint/linter/schema/own.json`
- `src/lint/plugins/lib.rs`
- `src/sema/resolve.rs`

New files added by `patches/02-effect-rules.patch`:

- `docs/lint/rules/bun/floating-effect.mdx`
- `src/lint/driver/effect.rs`
- `src/lint/plugins/effect/mod.rs`
- `src/lint/plugins/rules/bun_floating_effect.rs`
- `test/cli/lint/effect.test.ts`

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

The source patch is subject to Bun's MIT license. Its rule behavior is
adapted from [Effect's MIT-licensed floatingEffect rule](https://github.com/Effect-TS/tsgo/blob/0e722d359c969bdf1b1316f08e8637022cde3cce/crates/ets_rules/src/floating_effect.rs)
and its [directive parser](https://github.com/Effect-TS/tsgo/blob/0e722d359c969bdf1b1316f08e8637022cde3cce/crates/ets_directives/src/parser.rs).
