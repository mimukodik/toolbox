# Toolbox

Patched developer tools for CI and sandboxes. The workflow builds for Linux
x86_64 on Blacksmith and publishes pinned runtime closures as GitHub Releases.
Toolbox ships [Codex](tools/codex/README.md) and [Bun](tools/bun/README.md).

## Install a release

Use a tagged release and copy the digest from its `.tar.zst.sha256` file into
your image or CI configuration. Get `install.sh` from the same tag. The
installer needs root, curl, CA certificates, jq, GNU tar, zstd and coreutils.

```sh
url=https://github.com/mimukodik/toolbox/releases/download/codex-0.170.0-p1/codex-0.170.0-p1-x86_64-linux.tar.zst
sudo sh ./install.sh "$url" "$sha256"
codex --version
```

The installer checks the pinned digest before unpacking the runtime closure
under `/nix/store`. It links the binaries listed in the archive's manifest
into `/usr/local/bin`. It works without Nix.

## Add a tool

1. Put the tool's overlay, patches, patch level and maintenance notes under
   `tools/<name>/`.
2. Include the overlay in the root flake's composition and expose the package
   under `packages.x86_64-linux`.
3. Add the tool's Blacksmith build, patch tests and Ubuntu install smoke check.
   Publish a tagged runtime closure, its SHA-256 file and its release manifest.
   The archive must include an install manifest with `store_path` and `bins`.
4. When a change alters a published archive, bump the tool's patch level. A
   published tag can only be reused when the archive digest is identical.

## License

Licensed under either of Apache License 2.0 or MIT at your option.
Patches to upstream tools under `tools/*/patches/` are also subject to the
upstream tool's license (Codex Apache-2.0, Bun MIT).
