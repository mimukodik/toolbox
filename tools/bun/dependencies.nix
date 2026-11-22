{ lib, fetchurl, runCommand }:
let
  # The URL keys are those used by scripts/build/download.ts at the Bun pin.
  archives = [
    [ "c-ares/c-ares" "0b88066f79ac9745d6819899f1794df91b73c873" "3707c13c56a164ca84d18d7800c7efb5fc23ab73b74a67a34063667ebfbae96e" ]
    [ "google/highway" "2607d3b5b0113992fe84d3848859eae13b3b52c1" "741d705781e0b3e406beda8f1f994fbae01321237ce8023a1ad90fbaf7940c25" ]
    [ "oven-sh/lol-html" "725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e" "afd83edbe1a2d4accb72e869cd4218bb8665fda2b7cb2c5106fc4be80001a748" ]
    [ "sru-systems/rust-argon2" "ed81866f163f0c7026aa6fd8388adf37242eb32a" "e77c797444f191faf488d49c76c4f45c10b3d9275e0364ee10b6d05cfbe57baf" ]
    [ "litespeedtech/ls-qpack" "91567706c41c0d97ab8dc576873ecd472d7869fa" "1e8f7a69a9aee3970cb3fa8fbc22e2df00b7daf8f2b51daf35f50001e6c6943c" ]
    [ "oven-sh/mimalloc" "5945551d9ea1e3c83dbf5b198b00a3ec51aee395" "da1ce8c714ec7e5a11d2074eacdc13d943954a5798b25ed900098b1bc886ebc4" ]
    [ "oven-sh/tinycc" "05f0fafaa3be31e31d7b4b5c17dc60f62c991171" "50750680312923a59fdd36ae41f7091d8e35e51909d0e0b25b0b33ea9534bc08" ]
    [ "oven-sh/boringssl" "fe703e9faa3bfd22b04eb192066856557b7e015c" "a528428eca361764a60a3f82f637239bf46dc36b7d5b03500ad870675e3cd02f" ]
    [ "litespeedtech/lsquic" "f52c00172e04f9b889ab9e28d21e5d1805133cfb" "c569b3c48b59f3dfa0b8e8efde181c599317b7b969e9818ad7b7c37931e3b514" ]
  ];
  github = map (archive:
    let
      repo = builtins.elemAt archive 0;
      rev = builtins.elemAt archive 1;
    in {
      url = "https://github.com/${repo}/archive/${rev}.tar.gz";
      file = fetchurl {
        url = "https://codeload.github.com/${repo}/tar.gz/${rev}";
        name = "${lib.last (lib.splitString "/" repo)}-${rev}.tar.gz";
        sha256 = builtins.elemAt archive 2;
      };
    }
  ) archives;
  prebuilt = map (spec: { inherit (spec) url; file = fetchurl spec; }) [
    {
      url = "https://nodejs.org/dist/v26.12.1/node-v26.12.1-headers.tar.gz";
      sha256 = "a983cdcea96e85d137b9b807cc776bb5564fc9e3e1c9185d59bbfaa781efd08f";
    }
    {
      url = "https://github.com/oven-sh/WebKit/releases/download/autobuild-499846f18f75962fd6e2ba01065d00305ce72c4a/bun-webkit-linux-amd64-aot.tar.gz";
      sha256 = "f4296ee157afb6fc4343f30f898de90e5294eab67d4960e87d1dca4d3a949119";
    }
  ];
  key = url: builtins.substring 0 32 (builtins.hashString "sha256" url);
in
runCommand "bun-build-prefetch" { } ''
  mkdir -p "$out/by-url"
  ${lib.concatMapStringsSep "\n" (dep: "ln -s ${dep.file} $out/by-url/${key dep.url}") (github ++ prebuilt)}
''
