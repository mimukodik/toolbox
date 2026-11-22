# Bun canary with Effect floatingEffect

This Linux x86-64 experiment builds Bun canary 1.4.6-canary.1 at
[b15f513](https://github.com/oven-sh/bun/commit/b15f51302d72e1cd9038ecd0cf33782c02ee7681).
The `bun` and `bun-unpatched` flake packages share the toolchain, source and
build flags. Only `bun` applies the lint patch.

```sh
nix build .#bun -o result
nix build .#bun-unpatched -o result-control
result/bin/bun lint --type-aware --type-check src
```

The typed linter reads the project's merged `compilerOptions.plugins` entry for
`@effect/language-service`. Set `diagnosticSeverity.floatingEffect` to `error`,
`warning` or `off`. The experiment runs after the checker has loaded the typed
project. Use both flags above to ensure Bun checks files even when no other
enabled lint rule needs types. Bun reports the rule as `bun/floating-effect`.

The rule uses the Effect v4 Effect and Stream variance properties. The
expression-statement filter, assignment exclusions and Effect subtype and
Fiber exclusions follow
[Effect's implementation](https://github.com/Effect-TS/tsgo/blob/a518dc78d9c7952672fcdb8e964a3fcb53327541/crates/ets_rules/src/floating_effect.rs).
The detector uses Bun's HIR and type API. This patch covers Effect v4. It omits
the upstream v3 variance-property scan, language-service quick fixes,
Effect-specific suppression directives and Bun's generated website, rule
schema and conformance bundle. The Blacksmith proof exercises the CLI.

## Build inputs and evidence

Bun's build graph runs with a Nix-provided bootstrap Bun and LLVM 23, with
the upstream nightly Rust pin and `rust-src`. The dependency cache lists
upstream's archives and published WebKit and Node header hashes. Cargo
dependencies come from Bun's lockfile and the matching Rust standard library
lockfile. A fixed-output derivation installs the three locked JavaScript
dependency trees used by codegen. The main build uses those trees and runs
Cargo offline. Both binaries use release optimization with cross-language
LTO disabled.

The **Build and verify Bun** workflow builds both packages on one Blacksmith
runner. It uploads the patched runtime closure and the build and proof
receipts. The build summaries record elapsed time, runner memory, filesystem
usage and closure size. The proof script runs on slack-listener at
`8132ecc`, then interleaves five fresh, cold filesystem-cache runs per tool.
For local use on a Nix machine, run the binary through its flake result link.

When updating the pin, refresh the flake locks, the Rust nightly and std
lockfile hash, the build dependency URLs and hashes, and the JavaScript
dependency derivation hash. Check patch application and rerun the workflow.
