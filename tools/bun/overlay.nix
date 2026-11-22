final: prev:
let
  build = patched: final.callPackage ./package.nix { inherit patched; bootstrapBun = prev.bun; };
in
{
  toolbox-bun = build true;
  toolbox-bun-unpatched = build false;
}
