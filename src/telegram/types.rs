pub struct FileMetadata {
    pub name: String,
    pub size: u64,
    pub date: u64, // Unix timestamp or similar
    // ... other metadata ...
}

pub enum UploadResult {
    Success(String), // file ID
    Error(String), // error message
}
