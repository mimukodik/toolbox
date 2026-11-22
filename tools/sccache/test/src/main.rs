use std::{panic, path::Path};

fn main() -> std::io::Result<()> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    println!("Binary manifest dir: {manifest_dir}");
    println!(
        "Cached library manifest dir: {}",
        path_probe::baked_manifest_dir()
    );
    println!("Source file: {}", path_probe::source_location());
    assert!(panic::catch_unwind(path_probe::panic_at_source_location).is_err());
    let fixture = path_probe::read_fixture(Path::new(manifest_dir))?;
    println!("Fixture: {}", fixture.trim());
    Ok(())
}
