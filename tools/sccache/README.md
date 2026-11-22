# sccache

Toolbox builds sccache v0.20.0 from upstream `main` at
[`4a138d78794bf3c1df11adfdef2ad49fed05b031`](https://github.com/mozilla/sccache/commit/4a138d78794bf3c1df11adfdef2ad49fed05b031).
The Linux x86_64 closure uses the [Toolbox installer](../../README.md) and
the release tag `sccache-0.20.0-4a138d7-p1`.

| Patch | Upstream head | Remove when |
| --- | --- | --- |
| [#3051](https://github.com/mozilla/sccache/pull/3051) strips the Cargo build directory from tracked Rust environment values. The README hunk is rebased. | `02dfeb627651449322e4dd0f4ccee86a71dd73d3` | #3051 is merged and included in the upstream release Toolbox pins. |
| [#3021](https://github.com/mozilla/sccache/pull/3021) remaps base directories in Rust outputs. | `3fa52500202666f9f6b29bc21f764b26bb3cc00b` | #3021 is merged and included in the upstream release Toolbox pins. |

## Reusing Rust builds

Start one sccache server per checkout with that checkout's absolute root in
`SCCACHE_BASEDIRS`. Set `SCCACHE_BASEDIRS_REMAP_PATHS=1` for Rust compiles
and `CARGO_INCREMENTAL=0` for Cargo. Cargo's registry sources must have the
same absolute paths on the machine filling the cache and the machine replaying
it. Proc-macros compile locally and can embed their registry paths in metadata
that sccache hashes for downstream crates. CI replaying sandbox builds must
use the sandbox's `CARGO_HOME` path, `/home/agent/.cargo`.

Rust can still bake `env!("CARGO_MANIFEST_DIR")` into a cached artifact. A
crate that uses that directory for runtime file access should receive the
path at runtime. To keep a compile-time path instead, set
`SCCACHE_BASEDIRS_VERBATIM_ENV_DEPS=CARGO_MANIFEST_DIR` for that compile.
This keeps the full value in the key and prevents the affected crate from
hitting across checkout paths.

## Proof

On Blacksmith, `test/prove.sh` builds the same locked Cargo workspace at two
paths with a fixed `CARGO_HOME` and separate local caches for stock v0.19.0
and the patched build. It logs sccache stats after each build, checks the Rust
hit rates and verifies a cache hit for the path-probe library specifically.
The replayed library supplies the source and panic locations. The fresh
binary passes its checkout directory to the library at runtime to read the
second checkout's fixture. The library also prints its baked manifest
directory to show where the first checkout's path survives.
