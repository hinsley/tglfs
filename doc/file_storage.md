# File storage protocol

In order to upload large files to Telegram, we subdivide them into smaller files Telegram will accept, sending these smaller chunks one at a time.

### Caption annotations to aid in search

```
tglfs <ufid> chunk <chunk_id>/<total_num_chunks> <filename>
```

### Procedure for encoding
- Compression: `Zstandard` using [zstd-codec](https://www.npmjs.com/package/zstd-codec).
- Encryption: `XChaCha20-Poly1305` using [`libsodium-wrappers-sumo`](https://www.npmjs.com/package/libsodium-wrappers-sumo).
- Chunking: Even-sized splitting, chunk sizes set in `config.json`.

Data is read through a compression and encryption stream (via the WebStreams API), chunking afterwards as necessary to be sent to Telegram.
This streaming approach prevents the need for a free parameter (chunk size) while chunking, which would be required if performing a subsequent compression and encryption.
Similarly, when decrypting and decompressing, a streaming approach is used.
