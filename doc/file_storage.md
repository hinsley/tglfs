# File storage protocol

In order to upload large files to Telegram, we subdivide them into smaller files Telegram will accept, sending these smaller chunks one at a time.

### Caption annotations to aid in search

```
tglfs <ufid> chunk <chunk_id>/<total_num_chunks> <filename>
```

### Procedure for encoding

Compress -> Encrypt -> Chunk.

-   Compression: `Zstandard` default (compression level 3).
-   Encryption: `XChaCha20-Poly1305`.
-   Chunking: Even-sized splitting, chunk sizes set in `config.json`.
