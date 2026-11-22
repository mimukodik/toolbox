{ bun-src }:
final: prev:
let
  build = patched: final.callPackage ./package.nix { inherit bun-src patched; bootstrapBun = prev.bun; };
in
{
  toolbox-bun = build true;
  toolbox-bun-unpatched = build false;
}
