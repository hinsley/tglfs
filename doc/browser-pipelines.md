# Browser data pipelines: compression, encryption, upload, download

This document explains how TGLFS processes files entirely in the browser: how compression, encryption, uploads, downloads, decryption, and decompression work, and where Service Workers and OPFS fit in.

## TL;DR
- **Compression**: Browser-native `CompressionStream("gzip")`.
- **Encryption**: WebCrypto `AES-CTR` with a PBKDF2-derived 256-bit key (100k iterations, SHA-256), 16-byte salt, 16-byte initial counter.
- **Upload**: Gzip-compress → buffer into 1 MiB blocks → encrypt each block with AES-CTR and increment the counter per block → send 512 KiB parts to Telegram via GramJS → finalize 2 GiB chunks as messages.
- **Download**: Fetch encrypted parts from Telegram in 1 MiB slices → decrypt per 1 MiB block with AES-CTR and a rolling counter → stream through `DecompressionStream("gzip")` → pipe to a Service Worker `ReadableStream` that triggers the browser download with the correct filename.
- **Service Workers**: Yes. Dedicated SW at `src/service-worker.js` for download streaming; an additional offline SW exists for fallback pages.
- **OPFS**: Not used in the active upload/download pipelines (streaming avoids temporary files). Utilities remain for potential future use.

## Key source files
- `src/telegram.ts`: Upload and download pipelines, Telegram API calls, chunk/part logic, and progress updates.
- `src/web/encryption.ts`: AES key derivation (PBKDF2) and counter management for AES-CTR.
- `src/service-worker.js`: Download streaming bridge (page ↔ SW) returning a `ReadableStream` response with `Content-Disposition`.
- `src/web/app.ts`: UI wiring and SW registration for downloads.
- `src/index.html`: UI, an additional registration for an offline SW.
- `src/web/fileProcessing.ts`: Older OPFS utilities and UFID computation.

## On-wire format and metadata
- **File card**: A JSON message stored in Telegram (“Saved Messages”) that indexes a file’s chunk messages and metadata.
  - Fields: `name`, `ufid`, `size`, `uploadComplete`, `chunks` (message IDs), `IV`.
  - `IV` = base64(salt || initialCounter), each 16 bytes.
- **Chunk**: A Telegram message containing up to `config.chunkSize` bytes (default 2 GiB) assembled from 512 KiB parts.
- **Parts**: Telegram requires parts of size divisible by 1 KiB and dividing 512 KiB. The code uses `UPLOAD_PART_SIZE = 512 * 1024`.

## Constants and sizes
- `ENCRYPTION_CHUNK_SIZE`: 1 MiB blocks for encryption/decryption (`src/web/encryption.ts`).
- `UPLOAD_PART_SIZE`: 512 KiB parts uploaded to Telegram (`src/telegram.ts`).
- `DOWNLOAD_PART_SIZE`: 1 MiB slices fetched from Telegram (`src/telegram.ts`).
- `config.chunkSize`: 2 GiB default chunk boundary (`src/web/app.ts`).

## Upload pipeline (browser → Telegram)
1. User selects a file.
2. A random 16-byte salt and 16-byte initial counter are generated.
3. Derive a 256-bit AES-CTR key using PBKDF2 with the user’s password and the salt (`deriveAESKeyFromPassword`).
4. Create a file card message with `uploadComplete: false` and empty `chunks`.
5. Create the streaming pipeline:
   - `file.stream()` → `CompressionStream("gzip")`.
6. Accumulate compressed bytes into a 1 MiB `encryptionBuffer`:
   - When full: `subtle.encrypt(AES-CTR, key, encryptionBuffer)`.
   - After each full-block encryption: increment the 16-byte counter and reset the buffer.
7. Accumulate encrypted bytes into a 512 KiB `partBuffer`:
   - When full: send via `Api.upload.SaveBigFilePart(...)`.
   - Respect the current 2 GiB `chunkSize` boundary; finalize a chunk as needed by sending `Api.InputFileBig` and then `client.sendFile("me", ...)`.
   - Append the new chunk message ID to `fileCardData.chunks` and update the file card message.
8. Flush any remaining encryption and part buffers, finalize the last chunk, set `uploadComplete: true`, and update the file card.

Relevant code: `fileUpload` in `src/telegram.ts`.

## Download pipeline (Telegram → browser)
1. User provides the UFID and password.
2. Fetch the file card and derive the same AES-CTR key using the salt from `IV`.
3. Prepare decompression:
   - A `ReadableStream` with a controller that the page writes decrypted bytes into.
   - `DecompressionStream("gzip")` hooked to that `ReadableStream`.
4. Register and await the download Service Worker; post the file name to it (`SET_FILE_NAME`).
5. Trigger a fetch to `/download-file?ufid=...` to cause the SW to respond with a `ReadableStream` download (`Content-Disposition` set to the filename).
6. For each chunk message in `fileCardData.chunks`:
   - Iterate offsets and fetch encrypted bytes via `Api.upload.GetFile(...)` with `limit = DOWNLOAD_PART_SIZE` (1 MiB).
   - Fill a 1 MiB `decryptionBuffer`.
   - When full: `subtle.decrypt(AES-CTR, key, decryptionBuffer)`, then increment the 16-byte counter.
   - Enqueue decrypted bytes to the decompression controller, read decompressed output, and `postMessage` it to the SW as `PROCESSED_DATA` (transferring the `ArrayBuffer`).
7. Flush any remaining bytes through decrypt → decompress → SW.
8. Notify the SW with `DOWNLOAD_COMPLETE`.

Relevant code: `fileDownload` in `src/telegram.ts` and `src/service-worker.js`.

## Service Worker responsibilities
- `src/service-worker.js`:
  - Handles `fetch` for `/download-file` by returning a `ReadableStream` response.
  - Receives `SET_FILE_NAME` to set `Content-Disposition`.
  - Receives `PROCESSED_DATA` chunks from the page, and enqueues them into the response stream.
  - Receives `DOWNLOAD_COMPLETE` and closes the stream.
- `src/offline-page-sw.js`:
  - A separate offline page SW registered from `src/index.html` for PWA fallback.

## OPFS usage
- Current upload/download pipelines are fully streaming; they do not stage data in OPFS.
- Utilities remain (e.g., `prepChunk`) to write to OPFS if needed in future flows.
- `UFID` is computed by streaming the source file in 64 KiB pieces and iteratively hashing.

## Security notes
- AES-CTR provides confidentiality but not authenticity. There is no MAC. Wrong passwords are generally detected only when gzip decompression fails.
- The plan documented elsewhere mentions switching to `zstd` for compression and an authenticated streaming cipher (`crypto_secretstream_xchacha20poly1305`) via `libsodium`. Those are not in the current browser pipeline.

## Where to look in the code
- Upload: `src/telegram.ts` → `fileUpload`.
- Download: `src/telegram.ts` → `fileDownload`.
- SW bridge: `src/service-worker.js`.
- Key derivation/counter: `src/web/encryption.ts`.
- UI/SW registration: `src/web/app.ts` and `src/index.html`.
- Notes and future direction: `doc/compression_stream.md`, `doc/file_storage.md`, and `dev notes scratchpad.md`. 