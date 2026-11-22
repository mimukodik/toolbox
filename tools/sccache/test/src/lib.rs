use std::{fs, io, path::Path};

// Give rustc an absolute source path so this exercises output remapping.
include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/location.rs"));

pub fn baked_manifest_dir() -> &'static str {
    env!("CARGO_MANIFEST_DIR")
}

pub fn read_fixture(runtime_manifest_dir: &Path) -> io::Result<String> {
    fs::read_to_string(runtime_manifest_dir.join("fixture.txt"))
}
