mod chunks;
mod ufid;
use ufid::ufid;

fn main() {
    let file_path = "README.md";
    match ufid(file_path) {
        Ok(hash) => println!("SHA-256 hash: {}", hash),
        Err(e) => println!("Error: {}", e),
    }
}
