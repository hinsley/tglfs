pub mod auth;
pub mod file_manager;
pub mod types;

use crate::telegram::auth::TelegramAuth;
use crate::telegram::file_manager::TelegramFileManager;
use crate::telegram::types::{FileMetadata, UploadResult};

pub struct TelegramClient {
    auth: TelegramAuth,
    file_manager: TelegramFileManager,
}

impl TelegramClient {
    pub fn new(api_id: i32, api_hash: &str) -> Self {
        let auth = TelegramAuth::new(api_id, api_hash);
        let file_manager = TelegramFileManager::new();
        Self { auth, file_manager }
    }

    pub fn authenticate(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        self.auth.authenticate()
    }

    pub fn upload_file(&self, file_path: &str) -> Result<UploadResult, Box<dyn std::error::Error>> {
        self.file_manager.upload_file(&self.auth, file_path)
    }

    pub fn download_file(&self, file_id: &str, destination_path: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.file_manager.download_file(&self.auth, file_id, destination_path)
    }

    pub fn list_files(&self) -> Result<Vec<FileMetadata>, Box<dyn std::error::Error>> {
        self.file_manager.list_files(&self.auth)
    }

    pub fn delete_file(&self, file_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.file_manager.delete_file(&self.auth, file_id)
    }
}
