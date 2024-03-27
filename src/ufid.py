# ufid.py
# Unique file identifiers

import hashlib
import os

KB = 1024
MB = 1024 * KB
GB = 1024 * GB


def ufid(file_path: str, chunk_size: int = MB) -> str:
    # `chunk_size` defaults to 1MB.
    # The hash is calculated from the filename prepended to the file contents.

    sha256_hash = hashlib.sha256()
    sha256_hash.update(os.path.basename(file_path).encode("utf-8"))  # Read in filename.
    with open(file_path, "rb") as file:
        for chunk in iter(lambda: file.read(chunk_size), b""):
            sha256_hash.update(chunk)  # Read in chunk contents.
        return sha256_hash.hexdigest()
