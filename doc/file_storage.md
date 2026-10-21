# File storage protocol

TGLFS stores file-card JSON in Telegram messages and encrypted bytes in document messages referenced by `chunks`. Completed content is immutable. Folder and sync protocol versions are independent of file storage.

## Supported records

| Record type | Read | New writes | Meaning |
| --- | --- | --- | --- |
| `tglfs:file` | v1–v5 | v5 direct uploads; v3 sync; v4 explicit tar upgrades | File identity, storage references, and folder membership |
| `tglfs:archive-content` | v1 | v1 inside a v4 file card | Seekable compression and encryption descriptor |
| `tglfs:archive-index` | v1 | v1, encrypted | Tar members and plaintext/ciphertext block ranges |
| `tglfs:archive-source` | v1 | v1 for explicit upgrades | Informational provenance of the preserved source |
| `tglfs:block-content`, `tglfs:block-map`, `tglfs:block-manifest` | v1 | v1 with file-card v5 | Independent encrypted blocks and their manifest |
| `tglfs:upload-session`, `tglfs:upload-plan`, `tglfs:upload-block`, `tglfs:block-receipt` | v1 | v1 for raw uploads | Encrypted source plan and acknowledged-block checkpoints |
| `tglfs:tar-directory` | v1 | v1, encrypted | Directory inside a v5 tar archive |
| `tglfs:media-preview`, `tglfs:media-index`, `tglfs:media-source` | v1 | v1 for indexed media | Seek capability, encrypted time index, and retained-source provenance |
| `tglfs:download-state`, `tglfs:download-lock`, `tglfs:browser-download` | v1 | v1 in local state | Download checkpoint, process lock, and browser destination handle |

The shipped unversioned file-card shape is v1. Missing versions are not accepted for new record types. File-card v2 introduced explicit `type`/`version`, and v3 introduced `parentFolderId`. Versions 1–3 retain their existing gzip/AES-CTR content algorithm. The separate older counter-increment download pipeline is called `legacy`; file-card v1 does not imply that pipeline.

Existing incomplete v1–v3 uploads retain their established resume behavior and complete in their original protocol. V4 archive encoding used by explicit upgrades restarts after cancellation; new direct uploads use the v5 block protocol described below. Uploads and full downloads participate in the transfer tray, and explicit upgrades report task progress and cancellation there.

Unknown future record versions are refused. Metadata edits preserve supported record versions and unknown fields. Changing a durable algorithm requires a new version and an explicit compatibility design; do not change the algorithm behind an existing version. Old clients that do not support v4/v5 cannot parse or rewrite those cards.

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

Reusable preview routes require the unlocking browser client or an explicitly authorized child client. Downloads use a separately registered random token, valid for ten seconds and consumed by one complete GET; this permits browser download navigation without a client ID while denying ranges, reuse, and ownerless access to preview URLs. V4 whole-archive browser downloads verify the UFID before releasing the last bytes and restart after interruption. V5 download checkpoints are described below.

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

## Resumable block files (file-card v5)

New direct file and batch uploads write v5. Existing v1–v4 content is never rewritten. Sync's established v3 uploader and the explicit tar upgrade's v4 encoder keep their own algorithms. Version numbers identify storage algorithms, rather than requiring every existing record to be converted to the highest number.

A v5 card uses `IV: ""`, `uploadComplete: true`, and one `chunks` reference to a bounded JSON attachment. Its `content` descriptor is `{type:"tglfs:block-content",version:1,id,salt,blockSize,archive}`. The random identity is 32 lowercase hexadecimal characters; the salt is 16 random bytes encoded as canonical base64. Default blocks are 16 MiB, with supported multiples of 64 KiB up to 16 MiB. Each independently gzipped block is stored in its own Telegram document. Multipart transfer pieces remain 512 KiB.

The attachment is `tglfs:block-map` v1, containing the content identity, ordered block message IDs, and an encrypted manifest. Public IDs allow forwarding and deletion without knowing the password. Forwarding creates a new map with remapped IDs and preserves the encrypted manifest. Block IDs are intentionally outside authentication so remapping does not require decryption; substituting block bytes still fails authentication and their plaintext hash checks. The complete file card is published only after every block and its map have been acknowledged. Failed publication leaves all recovery records intact.

The encrypted `tglfs:block-manifest` v1 contains a `tglfs:upload-plan` v1 and each block's encryption IV and stored length. The plan binds content identity, original name, size, UFID, source metadata fingerprint, ordered SHA-256 hashes, and an optional `tglfs:tar-directory` v1. The tar directory keeps member names, kinds, and offsets encrypted. An optional `tglfs:media-index` v1 describes timed media segments. Plans/manifests have a 32 MiB metadata limit, tar member counts remain capped at 100,000, and excessive metadata is refused before publishing a card.

Encryption uses PBKDF2-SHA256 with 600,000 iterations and AES-256-GCM with a fresh random 12-byte IV for every encryption attempt. Associated data is UTF-8 JSON `[content.type,content.version,content.id,content.salt,content.blockSize,content.archive,purpose]`, so object property order and preserved optional fields cannot change authentication. Purposes are `plan`, `manifest`, `receipt:<index>`, or `block:<index>:<plaintextLength>:<SHA256>`. Encryption retries always choose fresh IVs; they do not assume gzip produces identical bytes across implementations. Readers authenticate before bounded decompression and verify the plaintext hash. Full reads also verify size and UFID. Nonempty files retain the shipped UFID algorithm. V5 defines the empty file's UFID as SHA-256 of zero bytes, avoiding the older accumulator's empty identifier.

### Upload interruption and recovery

Preparation scans a seekable source once to establish its block hashes, UFID, and optional tar directory. A `tglfs:upload-session` v1 document stores the encrypted plan; its caption records content descriptor, source size, and parent folder. Each acknowledged block has a `tglfs:upload-block` v1 caption containing an authenticated encrypted `tglfs:block-receipt` v1. Receipts bind the planned block hash, encryption IV, and stored length. Source filenames inside a batch are never put in plaintext captions. Outer metadata such as total size, salt, block count, timing, and parent folder remains visible.

Repeat the upload with the same source files and password, or select a transfer ID explicitly in the CLI. Recovery checks the encrypted plan and source metadata fingerprint, scans acknowledged block receipts (including blocks whose successful send response was lost), and seeks directly to missing source blocks. It checks the hash of every remaining block before uploading it. Completed source blocks are not reread or recompressed. This deliberately preserves the original prepared snapshot: callers must keep selected files unchanged; a deliberately modified completed prefix with forged unchanged timestamps is not reread. Batch tar range generation skips earlier members without opening their data streams. Missing, malformed, future-version, or conflicting authenticated metadata is refused. An uncertain final publish response is recovered by finding its complete card.

Interrupted upload sessions and their blocks are retained. They contain no stored password or key. Automatic deletion of abandoned transfer records is deferred; deleting a complete file removes that file's blocks/map/card, while source upgrade records remain independently selectable. A generated media encoding can stream directly into the same v5 block representation; because its source is a live encoder, retrying an interrupted encoding restarts encoding rather than claiming a seekable encoder checkpoint.

### Download interruption and recovery

The CLI writes an owned `.tglfs-<content-id>.part` file and a `tglfs:download-state` v1 JSON checkpoint next to the destination. It flushes block bytes before atomically publishing the next checkpoint. Resuming validates the content identity, UFID, size, block size, and count, then checks each saved local block against the authenticated plan while rebuilding the UFID. It fetches only missing remote blocks. An uncheckpointed tail may be truncated after the committed prefix is verified. A mismatched, corrupted, or unsupported checkpoint is refused with its partial file preserved. A `tglfs:download-lock` v1 file prevents concurrent writers; active PIDs are refused and terminated PIDs permit stale-lock recovery. The destination is only replaced after complete verification, and existing destinations require explicit overwrite authorization.

Browsers with `showSaveFilePicker` use the chosen destination handle and an IndexedDB `tglfs:browser-download` v1 record wrapping the same download checkpoint. Each checkpoint closes the writable before persisting its count. The browser may use a swap file or copy existing bytes internally when reopening a writable. The app neither stores a password/key nor creates a second full plaintext download in its own cache. Permission is requested again when necessary. Browser locks prevent concurrent tabs writing the same content. A browser without cross-tab locking is refused for resumable saving. Browsers without the save API retain a streamed download and display that interrupted downloads must restart; the CLI provides resumable saving there. Closing a tab stops browser-owned network activity. The optional [native background helper](background_helper.md) owns accepted uploads/downloads in a separate process; it reuses v5 storage without changing Telegram records. Its versioned local queue stores no file passwords and requires unlocking after restart.

Unknown future versions of all records above fail closed. New record types always include explicit `type` and `version`. Metadata edits preserve known record versions and unknown optional fields; neither a rename nor a move changes encrypted block parameters. Folder protocol v2 and sync-manifest v1/v2 compatibility is unchanged.

### Versioned media previews

New conversion and media-upgrade copies write file-card v5 with `mediaPreview:{type:"tglfs:media-preview",version:1,container:"mp4"|"webm",seeking:"byte-range"}`. Optional provenance is `tglfs:media-source` v1 with the source message ID, file-card version, and UFID. Older file cards remain previewable through their established readers; they are not reinterpreted as a new unversioned media record.

The authenticated plan's `tglfs:media-index` v1 records duration, initialization prefix length, and ordered container fragments with times, byte offsets/lengths, and keyframe markers. The browser initializes a media buffer, selects the last keyframe before the requested time, and requests nearby fragments through the authenticated block reader. It can therefore scrub to a distant position without downloading preceding media. Buffer windows and fragment sizes are bounded. Unsupported codecs, malformed timelines, unsafe metadata, and fragments exceeding the preview limits are refused.

**Upgrade media preview** and `tglfs upgrade-media-preview` stream a separate copy of an already indexable fragmented MP4 or WebM. They verify the original bytes' size/UFID, create a fresh encrypted index, and retain the original card and chunks. Encoded video bytes and password are preserved, including an empty password. Unindexable layouts require explicit MP4/WebM conversion instead. Conversion writes the same versioned format, preserves the password, and keeps the source; interrupted encoding restarts while completed copies support ordinary v5 download resumption. Future media-index or preview versions are refused instead of being rewritten.
