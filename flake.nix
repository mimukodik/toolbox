{
  description = "Patched developer tools for Linux x86_64";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/365f43543543080ad3ad85e5b90de58d86dd95f5";

  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay/52db20539ec0ba063479d66092992d9efcf456ff";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    { nixpkgs, rust-overlay, ... }:
    let
      system = "x86_64-linux";
      overlay = nixpkgs.lib.composeManyExtensions [
        rust-overlay.overlays.default
        (import ./tools/codex/overlay.nix)
        (import ./tools/bun/overlay.nix)
        (import ./tools/sccache/overlay.nix)
      ];
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ overlay ];
      };
    in
    {
      overlays.default = overlay;
      packages.${system} = { inherit (pkgs) bun bun-unpatched codex sccache; };
    };
}
