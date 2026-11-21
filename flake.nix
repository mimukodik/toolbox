{
  description = "Patched developer tools for Linux x86_64";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/365f43543543080ad3ad85e5b90de58d86dd95f5";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      overlay = nixpkgs.lib.composeManyExtensions [
        (import ./tools/codex/overlay.nix)
      ];
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ overlay ];
      };
    in
    {
      overlays.default = overlay;
      packages.${system} = { inherit (pkgs) codex; };
    };
}
