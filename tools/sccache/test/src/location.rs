pub fn source_location() -> &'static str {
    file!()
}

pub fn panic_at_source_location() {
    panic!("path probe");
}
