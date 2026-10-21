# File storage protocol

TGLFS stores file-card JSON in Telegram messages and encrypted bytes in document messages referenced by `chunks`. Completed content is immutable. Folder and sync protocol versions are independent of file storage.

## Supported records

| Record type | Read | New writes | Meaning |
| --- | --- | --- | --- |
| `tglfs:file` | v1, v2, v3, v4 | v3 ordinary files; v4 indexed tar archives | File identity, storage references, and folder membership |
| `tglfs:archive-content` | v1 | v1 inside a v4 file card | Seekable compression and encryption descriptor |
| `tglfs:archive-index` | v1 | v1, encrypted | Tar members and plaintext/ciphertext block ranges |
| `tglfs:archive-source` | v1 | v1 for explicit upgrades | Informational provenance of the preserved source |

The shipped unversioned file-card shape is v1. Missing versions are not accepted for new record types. File-card v2 introduced explicit `type`/`version`, and v3 introduced `parentFolderId`. Versions 1–3 retain their existing gzip/AES-CTR content algorithm. The separate older counter-increment download pipeline is called `legacy`; file-card v1 does not imply that pipeline.

Existing incomplete v1–v3 uploads retain their established resume behavior and complete in their original protocol. Newly uploaded indexed archives use v4 and restart after cancellation; they do not reuse old compression or encryption state. Uploads and full downloads participate in the transfer tray, and explicit upgrades report task progress and cancellation there.

Unknown future record versions are refused. Metadata edits preserve supported record versions and unknown fields. Changing a durable algorithm requires a new version and an explicit compatibility design; do not change the algorithm behind an existing version. Old clients that do not support v4 cannot parse or rewrite its cards.

## Indexed tar storage

Multi-file batches produce tar streams. A single plain `.tar` can also be uploaded in this format. The exact tar bytes and existing content UFID algorithm are preserved on upgrades. Each encoding has a fresh random `archiveId`, salt, and nonce prefix, so multiple stored copies can share a content UFID without sharing encryption state.

A v4 card retains the ordinary base fields and `parentFolderId`, uses `IV: ""` as an unused compatibility field, and adds an `archive` descriptor:

```json
{
  "type": "tglfs:archive-content",
  "version": 1,
  "archiveId": "<32 lowercase hex characters>",
  "salt": "<base64 of 16 random bytes>",
  "noncePrefix": "<base64 of 8 random bytes>",
  "blockSize": 1048576,
  "indexOffset": 123456,
  "indexLength": 4096,
  "storedSize": 127552
}
```

The numbered chunk documents form one concatenated byte stream. Independently gzip-compressed and AES-256-GCM-encrypted blocks come first; the encrypted, gzip-compressed directory index comes last. Keeping the index in those same chunks lets forwarding and deletion operate on one explicitly selected file card without a separate attachment protocol.

Archive-content v1 fixes these parameters:

- PBKDF2-SHA256, 600,000 iterations, 16-byte random salt, AES-256-GCM, 128-bit authentication tags.
- A 12-byte nonce formed from the 8-byte random prefix and a big-endian 32-bit block ordinal. Ordinal `0xffffffff` is reserved for the index and is never used for a content block.
- Content-block associated data binds the content type/version, archive identity, block size, block ordinal, and uncompressed length. Index associated data binds the descriptor, including the index location and total stored length.
- Default plaintext blocks are 1 MiB. Supported block sizes are multiples of 512 bytes from 512 bytes to 4 MiB. Telegram attachment and multipart sizes are separate transport settings.

The authenticated index contains its own type/version, archive identity, exact tar size and UFID, directory members, and contiguous plaintext/ciphertext block ranges. A member has an ordinal ID within this immutable archive, path, kind, header/data offsets, size, and optional modification time or link target. Duplicate paths remain separate members. Readers verify authentication before decompressing or displaying a block. Index ranges and lengths are validated before use.

## Browsing and privacy

Opening an archive retrieves its encrypted index and unlocks it locally. Selecting a member retrieves only the blocks covering that member. Browser media ranges use a temporary service-worker route with `Cache-Control: no-store`; plaintext and passwords are not written to a persistent preview cache. Closing the preview releases its reader and temporary route. File previews are limited by the browser's supported codecs and formats.

Reusable preview routes require the unlocking browser client or an explicitly authorized child client. Downloads use a separately registered random token, valid for ten seconds and consumed by one complete GET; this permits browser download navigation without a client ID while denying ranges, reuse, and ownerless access to preview URLs. Whole-archive browser downloads verify the UFID before releasing the last bytes and do not support resuming a partial download.

Empty and nonempty passwords use the same algorithm. The empty string can unlock automatically and offers no password-based confidentiality. The encrypted index protects internal names and paths when a secret password is used. The outer card's name, size, UFID, provenance, storage sizes, and request patterns remain visible to parties with access to the Telegram records. A content UFID can also identify matching known content.

Content buffers are bounded by block and transport sizes. Directory/block metadata uses memory proportional to archive size and member count. The initial implementation caps the decompressed index at 32 MiB, tar extension records at 1 MiB, and member count at 100,000. It does not implement a paged index. Exceeding a limit fails the operation; it does not truncate or publish an incomplete archive. Unsafe paths and unsupported sparse or special tar formats are refused. Links are listed as links rather than followed for extraction or preview.

## Explicit upgrades and recovery

Only completed tar archives in explicitly supported file-card versions 1, 2, or 3 are offered an upgrade. Filename detection selects a candidate; the streamed tar parser validates its contents. A version number being lower than the newest version is not sufficient evidence of compatibility.

An upgrade normally performs one sequential read of the original gzip/AES-CTR bytes, decrypts and decompresses through bounded streams, parses tar metadata, and uploads new indexed blocks. If decoding or source-integrity checks fail, it can retry once with the older `legacy` counter pipeline, using fresh encryption state and cleaning the failed attempt's staging chunks first. This fallback is independent of file-card version; cancellation, transport failures, cleanup failures, replacement-verification failures, and uncertain publication do not trigger it.

The upgrader checks the original tar size and UFID, then reads the new stored copy back and checks its authentication, reconstructed size, and UFID. Only after verification does it publish the completed v4 card. This uses no temporary archive file, OPFS staging, or whole-archive memory buffer. It requires transfer bandwidth for the source read, replacement upload, and replacement readback, plus a possible source retry for older encryption. The original remains stored, so the upgrade also consumes space for a second copy.

The new card's optional `upgradedFrom` object is `tglfs:archive-source` v1 and records `messageId`, `fileVersion`, `peer`, and `ufid`. It describes ancestry in the original account's message namespace; it does not authorize changing or deleting that source. A literal `peer: "me"` is not an actionable restore location after transferring a card to another account. Source cards and chunks remain untouched, and the browser shows both copies with their versions. Rollback consists of selecting the original card in the source account. There is no automatic migration, source hiding, or garbage collection.

On cancellation or a known failure before publication, the implementation attempts to remove only the new operation's staging chunks. Cleanup failure reports those chunk IDs. An ambiguous final publication result preserves the new chunks because a complete card may already reference them. Retrying is safe for the original, but can produce another complete copy; uploads do not resume after closing the page.

Future versions must add explicit readers and upgrade eligibility rules for each supported source format. They should use the same create-copy, verify, publish, preserve-source procedure, recording the immediate predecessor so ancestry can form a chain. Never repurpose a content UFID as a storage-instance identifier or silently upgrade the bytes behind an existing completed card.

Already-compressed `.tar.gz`/`.tgz` and ZIP/RAR/7z archives are stored as ordinary files. They are not offered this tar upgrade. Supporting their internal seek/index behavior requires a separate implementation and compatibility discussion.
