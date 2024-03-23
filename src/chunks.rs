// Divide a file into chunks of a fixed size.
// We should be able to start at an arbitrary byte index in the file when
// chunking. In particular, one should be able to reference the index of a
// chunk so as to continue an intermediate chunking operation from a halted
// sequence of chunkings.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use sha2::{Digest, Sha256};

/// Reads a chunk of bytes from a file starting at a specified chunk index.
///
/// This function divides a file into chunks of a fixed size and allows reading
/// a specific chunk by providing the chunk index.
///
/// # Arguments
///
/// * `file_path` - The path to the file to read the chunk from.
/// * `chunk_size` - The size of each chunk in bytes.
/// * `chunk_index` - The index of the chunk to read (0-based).
///
/// # Returns
///
/// A `Result` containing a vector of bytes (`Vec<u8>`) representing the read
/// chunk on success, or an `std::io::Error` if an I/O error occurs.
///
/// # Examples
///
/// ```
/// let file_path = "path/to/file.txt";
/// let chunk_size = 1024;
/// let chunk_index = 2;
///
/// match chunk(file_path, chunk_size, chunk_index) {
///     Ok(chunk_data) => {
///         println!("Read chunk {} of size {} bytes", chunk_index, chunk_data.len());
///         // Process the chunk data
///     }
///     Err(err) => {
///         eprintln!("Error reading chunk: {}", err);
///     }
/// }
/// ```
pub fn chunk(file_path: &str, chunk_size: u64, chunk_index: u64) -> Result<Vec<u8>, std::io::Error> {
    let mut file = File::open(file_path)?;
    let offset = chunk_size * chunk_index;
    file.seek(SeekFrom::Start(offset))?;

    let mut buffer = vec![0; chunk_size as usize];
    let bytes_read = file.read(&mut buffer)?;

    buffer.truncate(bytes_read);

    Ok(buffer)
}

/// Saves a chunk of bytes to a file with a filename derived from the chunk
/// index and content hash.
///
/// This function computes a hash of the chunk contents and appends the chunk
/// index and content hash to the original file name to generate a unique
/// filename for the chunk. It then saves the chunk contents to the generated file.
///
/// # Arguments
///
/// * `file_path` - The path to the original file from which the chunk is derived.
/// * `chunk_index` - The index of the chunk (0-based).
/// * `chunk_contents` - A vector of bytes representing the chunk contents.
///
/// # Returns
///
/// A `Result` indicating the success or failure of the operation. Returns `Ok(())` if the chunk is
/// successfully saved, or an `std::io::Error` if an I/O error occurs.
///
/// # Examples
///
/// ```
/// let file_path = "path/to/file.txt";
/// let chunk_index = 2;
/// let chunk_contents = vec![1, 2, 3, 4, 5];
///
/// match save_chunk(file_path, chunk_index, chunk_contents) {
///     Ok(()) => {
///         println!("Chunk saved successfully");
///     }
///     Err(err) => {
///         eprintln!("Error saving chunk: {}", err);
///     }
/// }
/// ```
pub fn save_chunk(file_path: &str, chunk_index: u64, chunk_contents: Vec<u8>) -> Result<(), std::io::Error> {
    // Compute the hash of the chunk contents
    let mut hasher = Sha256::new();
    hasher.update(&chunk_contents);
    let chunk_hash = hasher.finalize();

    // Generate the chunk filename
    let file_stem = Path::new(file_path).file_stem().unwrap().to_str().unwrap();
    let chunk_filename = format!("{}_{}_{:x}.chunk", file_stem, chunk_index, chunk_hash);

    // Create and write the chunk file
    let mut chunk_file = File::create(chunk_filename)?;
    chunk_file.write_all(&chunk_contents)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::NamedTempFile;

    #[test]
    fn test_chunk_valid_file() {
        // Create a temporary file with some content
        let file_contents = "Hello, World!";
        let temp_file = NamedTempFile::new().unwrap();
        fs::write(temp_file.path(), file_contents).unwrap();

        // Test chunk function with valid parameters
        let chunk_size = 5;
        let chunk_index = 1;
        let result = chunk(
            temp_file.path().to_str().unwrap(),
            chunk_size,
            chunk_index
        );

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), b", Wor");
    }

    #[test]
    fn test_chunk_invalid_file() {
        // Test chunk function with an invalid file path
        let invalid_file_path = "path/to/nonexistent/file.txt";
        let chunk_size = 1024;
        let chunk_index = 0;
        let result = chunk(invalid_file_path, chunk_size, chunk_index);

        assert!(result.is_err());
    }

    #[test]
    fn test_save_chunk() {
        // Create a temporary file
        let temp_file = NamedTempFile::new().unwrap();
        let file_path = temp_file.path().to_str().unwrap();

        // Test save_chunk function with valid parameters
        let chunk_index = 0;
        let chunk_contents = vec![1, 2, 3, 4, 5];
        let result = save_chunk(file_path, chunk_index, chunk_contents.clone());

        assert!(result.is_ok());

        // Check if the chunk file is created and has the correct content
        let file_stem = Path::new(file_path).file_stem().unwrap().to_str().unwrap();
        let mut hasher = sha2::Sha256::new();
        hasher.update(&chunk_contents);
        let chunk_hash = hasher.finalize();
        let chunk_filename = format!(
            "{}_{}_{:x}.chunk",
            file_stem,
            chunk_index,
            chunk_hash
        );
        let saved_chunk_contents = fs::read(&chunk_filename).unwrap();

        assert_eq!(saved_chunk_contents, chunk_contents);

        // Clean up the created files. (Not sure why we have to.)
        fs::remove_file(&chunk_filename).unwrap();
    }
}
