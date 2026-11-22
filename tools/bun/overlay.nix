final: prev:

let
  packages = import ./package.nix { pkgs = prev; };
in
{
  inherit (packages) bun bun-unpatched;
}
