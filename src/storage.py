# storage.py
# Local file storage (not on Telegram)

import json
import os
from typing import Callable

from ufid import ufid

KB = 1024
MB = 1024 * KB
GB = 1024 * MB

# Load default chunk size from config.json.
with open("config.json") as config_file:
    config_data = json.load(config_file)
    CHUNK_SIZE_GB = config_data["chunk_size_gb"]


def get_chunk(
    file_path: str, chunk_index: int, chunk_size: int = int(CHUNK_SIZE_GB * GB)
) -> bytes:
    with open(file_path, "rb") as file:
        file.seek(chunk_index * chunk_size)
        chunk_data = file.read(chunk_size)
        return chunk_data


def save_chunk(
    file_ufid: str, chunk_index: int, chunk: bytes, dir_path: str = "."
) -> str:
    chunk_file_name = f"{file_ufid}_{chunk_index}.chunk"
    chunk_file_path = os.path.join(dir_path, chunk_file_name)
    chunk_file_path = os.path.join(dir_path, f"{file_ufid}_{chunk_index}.chunk")

    # Create the directory if it doesn't exist.
    os.makedirs(dir_path, exist_ok=True)

    # Write the chunk data to the file.
    with open(chunk_file_path, "wb") as chunk_file:
        chunk_file.write(chunk)

    # Return the path of the created chunk file.
    return chunk_file_path


def get_num_chunks(file_path: str, chunk_size: int = int(CHUNK_SIZE_GB * GB)) -> int:
    file_size = os.path.getsize(file_path)
    num_chunks = (file_size + chunk_size - 1) // chunk_size
    return num_chunks
