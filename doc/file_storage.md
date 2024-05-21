# File storage protocol

In order to upload large files to Telegram, we subdivide them into smaller files Telegram will accept, sending these smaller chunks one at a time.

### Caption annotations to aid in search

```
tglfs <ufid> chunk <chunk_id>/<total_num_chunks> <filename>
```

### Procedure for encoding

Internal-Chunk -> Compress -> Encrypt ->  -> Chunk.

-   Compression: `GZip` using the [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API).
-   Encryption: `XChaCha20-Poly1305`.
-   Chunking: Even-sized splitting, chunk sizes set in `config.json`.
