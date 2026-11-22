# Bun floatingEffect experiment

This Linux x86-64 build pins Bun canary 1.4.6-canary.1 at
[`b15f51302d72e1cd9038ecd0cf33782c02ee7681`](https://github.com/oven-sh/bun/commit/b15f51302d72e1cd9038ecd0cf33782c02ee7681).
Both packages use the same release build with LTO and AOT disabled. The
patched package applies the patches in this directory, at patch level
`p1`. The unpatched package is the control.

```sh
nix build .#bun
nix build .#bun-unpatched --out-link result-unpatched
```

The patch reads the Effect language-service rule setting from the
TypeScript project used by native lint. Set
`compilerOptions.plugins[].diagnosticSeverity.floatingEffect` to `error`
in the `@effect/language-service` entry and run
`bun lint --type-aware --type-check`. The diagnostic is
`bun/floating-effect`. The experiment covers the Effect v4 type marker.

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
to refresh the vendor hashes when their inputs change. Apply the rule
patch at the new commit and run the Blacksmith proof for both variants.

The **Build and prove Bun lint** workflow records the build cost for both
variants, runs the diagnostic cases and timing at the pinned slack-listener
commit, and uploads its output as `bun-lint-proof`. Download the
`bun-patched-x86_64-linux` or `bun-unpatched-x86_64-linux` Actions artifact
to import its runtime closure on a Linux x86-64 machine with Nix:

```sh
zstd -dc closure.nix-export.zst | nix-store --import
"$(cat store-path.txt)/bin/bun" --version
```

The source patch is subject to Bun's MIT license. Its rule behavior is
adapted from [Effect's MIT-licensed floatingEffect rule](https://github.com/Effect-TS/tsgo/blob/a518dc78d9c7952672fcdb8e964a3fcb53327541/crates/ets_rules/src/floating_effect.rs).
