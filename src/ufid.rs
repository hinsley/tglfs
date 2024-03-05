// Unique file identifiers
// We use a SHA-256 hash of the file's contents as its identifier.

use std::fs::File;
use std::io::{BufReader, Read};
use sha2::{Sha256, Digest};

// Unique File IDentifier
pub fn ufid(file_path: &str) -> Result<String, std::io::Error> {
    let file = File::open(file_path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();

    // Feed in 1024 bytes of the file's contents at a time to the hasher.
    let mut buffer = [0; 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}
