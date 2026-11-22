{
  description = "Patched developer tools for Linux x86_64";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/365f43543543080ad3ad85e5b90de58d86dd95f5";

  inputs.bun-src = {
    url = "github:oven-sh/bun/b15f51302d72e1cd9038ecd0cf33782c02ee7681";
    flake = false;
  };
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay/52db20539ec0ba063479d66092992d9efcf456ff";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    { nixpkgs, bun-src, rust-overlay, ... }:
    let
      system = "x86_64-linux";
      overlay = nixpkgs.lib.composeManyExtensions [
        (import ./tools/codex/overlay.nix)
        rust-overlay.overlays.default
        (import ./tools/bun/overlay.nix { inherit bun-src; })
      ];
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ overlay ];
      };
    in
    {
      overlays.default = overlay;
      packages.${system} = {
        inherit (pkgs) codex;
        bun = pkgs.toolbox-bun;
        bun-unpatched = pkgs.toolbox-bun-unpatched;
      };
    };
}
