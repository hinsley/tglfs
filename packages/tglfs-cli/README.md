# tglfs

`tglfs` is a global CLI for authenticating with Telegram, uploading files, managing TGLFS file cards, transferring files between peers, searching mailboxes, and downloading current or legacy files by UFID.

## Install

```sh
npm install -g tglfs
```

## Commands

```sh
tglfs --help
tglfs help upload
tglfs help login
tglfs help search
tglfs help download
tglfs help convert-webm
tglfs help inspect
tglfs help sync
tglfs upload ./file.bin
tglfs upload ./a.txt ./b.txt
tglfs login
tglfs status
tglfs search [query]
tglfs search [query] --peer alice
tglfs rename <ufid> <new-name>
tglfs delete <ufid...> --yes
tglfs send <ufid...> --to alice
tglfs receive alice <ufid...>
tglfs unsend alice <ufid...> --yes
tglfs inspect <ufid>
tglfs sync init ./folder --name "My Folder"
tglfs sync push ./folder
tglfs sync pull <root-id> ./restore
tglfs sync status ./folder
tglfs sync list
tglfs logout
tglfs download <ufid>
tglfs download <ufid> --legacy
tglfs convert-webm <ufid> --source-password-env --json
```

On Unix-like systems, installed manpages are also available:

```sh
man tglfs
man tglfs-login
man tglfs-upload
man tglfs-search
man tglfs-download
man tglfs-convert-webm
man tglfs-rename
man tglfs-delete
man tglfs-send
man tglfs-receive
man tglfs-unsend
man tglfs-inspect
man tglfs-sync
```

## Auth Flow

Run `tglfs login` once to save:

- Telegram API ID
- Telegram API hash
- your phone number
- the resulting Telegram session

If you do not supply an API ID or API hash, the CLI defaults to the same bundled Telegram app credentials the web client currently uses. You can still override them with flags or environment variables.

The CLI stores config and session files in OS-standard app directories. Use `tglfs status` to inspect the current state.

## Upload And File Management

Upload one file directly:

```sh
tglfs upload ./report.pdf
```

Upload multiple files as a tar archive using the same archive naming convention as the web app:

```sh
tglfs upload ./notes.txt ./diagram.png ./draft.md
```

New uploads use file-card protocol v5 with independently compressed and authenticated encrypted blocks. Batches and individual `.tar` files include an encrypted member directory. Other archive formats remain ordinary files. Repeat `tglfs upload` with the original paths and password to resume, or use `--resume <transfer-id>` to select a session explicitly. Completed blocks are reused without rereading or recompressing their local source bytes; unfinished blocks must match the encrypted source plan. Changed file metadata refuses reuse. Keep the source unchanged until the upload finishes.

Optional upload password sources:

```sh
tglfs upload ./report.pdf --password 'secret'
TGLFS_UPLOAD_PASSWORD='secret' tglfs upload ./report.pdf
printf '%s\n' 'secret' | tglfs upload ./report.pdf --password-stdin
```

Owned-file management:

```sh
tglfs rename <ufid> "new-name.pdf"
tglfs delete <ufid...> --yes
tglfs send <ufid...> --to alice
```

TTY uploads render preparation and upload progress. New uploads scan the source once to establish its UFID, per-block hashes, and optional tar directory, then upload blocks from the same source. The encrypted plan and checkpoints are retained in Telegram on interruption. Each block is authenticated and hash checked when read. `--json` prints exactly one final object and never prompts. An omitted password is the empty string and uses the same encryption process; it provides no password-based confidentiality.

## Download Flow

Download a file by UFID:

```sh
tglfs download <ufid>
```

Optional flags:

```sh
tglfs download <ufid> --output ./file.bin
tglfs download <ufid> --password 'secret'
tglfs download <ufid> --password-env
printf '%s\n' 'secret' | tglfs download <ufid> --password-stdin
tglfs download <ufid> --legacy
```

Interactive TTY downloads render a progress bar. `--json` prints exactly one final JSON object to stdout, writes failures to stderr, and never prompts.

Downloads read file-card versions 1–5. V5 downloads retain an owned `.tglfs-<content-id>.part` file and versioned JSON checkpoint next to the output. Repeat the same command, destination, and password to verify the completed local blocks and fetch only unfinished blocks. The destination is published after full UFID verification; existing destinations require `--force`. A process lock prevents simultaneous writes; after an abnormal process exit, a stale lock can be recovered when its PID is no longer running. V1–V4 downloads retain their existing behavior. `--legacy` applies only to the old counter pipeline and is refused for v4/v5. Unknown future versions and mismatched checkpoints are refused without discarding the partial file.

The web app offers an explicit **Upgrade archive** action for completed `.tar` records in versions 1–3. It streams the original through the new encoder without creating a local archive file, verifies the new remote copy, and retains the original message and all original chunks. The new card records its source message and protocol version. Both copies remain independently selectable in the web app; an upgrade never edits sync roots or folder entries.

## Search Flow

Search Saved Messages or another peer mailbox for TGLFS file cards by filename or UFID:

```sh
tglfs search
tglfs search theorydesign
tglfs search e5d494acbfd03de2
tglfs search "project docs" --limit 10 --offset-id 170397
tglfs search "project docs" --peer alice --limit 10
tglfs search --sort name_asc --json
```

Plain-text output shows a table of `Name`, `Size`, `Date`, `UFID`, and `Status`. If a result page is full, the CLI prints the exact `--offset-id` command for the next page.

## Folder Sync

The first sync milestone supports backup and restore, not a background daemon. Initialize a folder once:

```sh
tglfs sync init ./Documents --name "Documents"
```

Push local changes into Telegram-backed storage:

```sh
tglfs sync push ./Documents
TGLFS_SYNC_PASSWORD='secret' tglfs sync push ./Documents
```

Restore a sync root elsewhere:

```sh
tglfs sync pull <root-id> ./restore
```

Sync stores one `tglfs:sync-manifest` record per root in Saved Messages. New sync roots write sync-manifest v2, which links the local root to a first-class TGLFS folder. Folder structure is represented with searchable `tglfs:folder` and `tglfs:folder-manifest` records, while file contents remain ordinary immutable TGLFS file cards. Pulls never silently overwrite divergent local files; they write conflict copies with deterministic `TGLFS conflict` names.

Useful sync inspection commands:

```sh
tglfs sync status ./Documents
tglfs sync list
```

## Peer Transfer And Inspection

Peer values for `--to`, `<source>`, and `--peer` are passed directly to Telegram/GramJS entity resolution. Users, groups, and channels can all work. In practice, use one of:

- a public username like `alice`, `@alice`, `@mygroup`, or `@mychannel`
- `me` for Saved Messages
- a phone number your Telegram account can already resolve, typically a saved contact

Private users, groups, and channels can also work if Telegram can already resolve them for the authenticated account, which usually means that account already has access to the dialog/entity.

If Telegram cannot resolve the peer value, the command fails.

Receive files from another peer into Saved Messages:

```sh
tglfs receive alice <ufid...>
```

For `receive` and `unsend`, `<source>` is the chat or mailbox that currently contains the TGLFS file card and chunk messages you want to operate on. It is not necessarily the original uploader's personal account.

Delete received files from another peer mailbox:

```sh
tglfs unsend alice <ufid...> --yes
```

Inspect file-card metadata and chunk references:

```sh
tglfs inspect <ufid>
tglfs inspect <ufid> --peer alice
```

Run the expensive full integrity probe only when you want it (current/legacy detection for v1–3, or authenticated block and UFID verification for v4/v5):

```sh
tglfs inspect <ufid> --probe
tglfs inspect <ufid> --password 'secret'
```

## WebM preview copies

Select a video in the app and choose **Create WebM preview copy** from its actions, or run:

```sh
tglfs convert-webm <ufid> --source-password-env --json
```

Set `TGLFS_WEBM_PASSWORD` to the source password. The new copy uses the same password, including an empty password, with fresh encryption randomness. The original remains untouched. Output uses file-card v5, `tglfs:media-preview` v1, and an encrypted `tglfs:media-index` v1 for indexed seeking. Supported file sources remain readable; archive and future protocols are refused. Each conversion creates a separate copy with the source password. Interrupted conversion restarts encoding.

The CLI requires FFmpeg 8+ with libvpx-vp9, libopus, SSIM, loopback decoding and bounded filter buffers, plus matching ffprobe. It checks installed capabilities before reading source bytes, inspects a metadata prefix of at most 64 MiB, then streams from the start for encoding and complete UFID verification. The browser uses WebCodecs and a bundled, pinned Mediabunny release, with one conversion pass and the same 64 MiB cap on metadata inspection. Both paths encrypt/upload generated output as it arrives and gate final publication on successful source verification, conversion and quality checks. Neither path writes video or sample clips to temporary files or OPFS, or retains a whole video in memory.

Beginning, middle and end clips of up to one second are compared against decoded frames of the actual output at full resolution. Every clip must reach luma SSIM 0.98. The browser compares up to about eight frames per second within those clips; the CLI compares all their frames. The report is sampled evidence, not a guarantee for every frame or audio quality, and the scores are not an interchangeable perceptual-quality percentage. Failed checks publish no new file card. An uncertain final Telegram response retains new chunks so a possibly published copy remains readable.

Supported containers are MP4, MOV, M4V, MKV and WebM, subject to decoder/encoder availability. MP4/MOV metadata must precede media data. Layouts requiring backward seeks or excessive buffers fail without a disk fallback. To avoid silently losing presentation or tracks, conversion refuses HDR, high bit depth, alpha, interlacing, rotation, non-square pixels, extra tracks, unsupported timing and unsupported audio. Browser decoding is conservatively limited to supported 8-bit AVC/VP8/VP9, including AVC sequence-header checks and rejection of custom AVC scaling matrices. The browser checks the actual decoded pixel format; CLI inspection checks interlacing metadata. Resolution and variable frame timing are kept, up to 4096 pixels per side and 4096 × 2304 pixels per frame. Audio becomes mono/stereo Opus at 48 kHz (44.1 kHz sources are resampled). Append-only WebM can have limited duration/seeking information.

Browser conversion uses two 32 MiB stream caches and a 64 MiB limit for pending quality-reference pixels, plus bounded metadata buffers and codec/frame memory. The CLI uses two encoding threads, no lookahead, a 16-frame filter-buffer limit and bounded metadata/log capture. High-resolution or poorly interleaved files can be refused when these limits are reached. No conversion service receives plaintext: processing stays on the device running TGLFS.

For browser smoke testing, `http://localhost:5173/?mock=folder-browser&run=webm` seeds small synthetic fixtures in a fake Telegram session. Its protected sample password is `webm-test`. No real Telegram data is accessed.

## Environment Variables

Login:

- `TGLFS_API_ID`
- `TGLFS_API_HASH`
- `TGLFS_PHONE`
- `TGLFS_LOGIN_CODE`
- `TGLFS_2FA_PASSWORD`

If `TGLFS_API_ID` and `TGLFS_API_HASH` are unset, `tglfs login` falls back to the bundled web-client credentials.

Upload:

- `TGLFS_UPLOAD_PASSWORD`

Download:

- `TGLFS_DOWNLOAD_PASSWORD`

WebM conversion:

- `TGLFS_WEBM_PASSWORD`
- `TGLFS_FFMPEG`
- `TGLFS_FFPROBE`

Inspect:

- `TGLFS_INSPECT_PASSWORD`

Sync:

- `TGLFS_SYNC_PASSWORD`

## AI-Agent Use

The CLI is designed to work with interactive agents and terminal tools:

- Prefer direct subcommands instead of menus when automating.
- Use `--json` for machine-readable `status`, `search`, `upload`, `rename`, `delete`, `send`, `receive`, `unsend`, `inspect`, `download`, and `convert-webm` output. In JSON mode, the CLI prints one success object to stdout, prints failures to stderr, and disables prompts.
- Use `--json` for sync commands when automating folder backup/restore.
- Use `--no-interactive` on TTY runs when you want prompt-free behavior without JSON output.
- Use stdin or env vars for secrets in non-interactive runs.
- Pass `--yes` for destructive commands such as `delete` and `unsend` in non-interactive runs.
- If Telegram asks for an SMS or in-app code or a 2FA password and no secret source was supplied, the agent should hand off to the user to provide it.

Examples:

```sh
tglfs status --json
tglfs search --json
tglfs upload ./report.pdf --json
tglfs send <ufid> --to alice --json
tglfs inspect <ufid> --json
printf '%s\n' "$TGLFS_DOWNLOAD_PASSWORD" | tglfs download <ufid> --password-stdin --json
```

Use `tglfs upgrade-media-preview <ufid>` to create a separate seekable copy of fragmented MP4 or WebM without changing the encoded video bytes. It streams the original into v5 authenticated blocks with an encrypted time index, keeps the original and its password, and refuses layouts that cannot be indexed safely. Use `make-previewable` or `convert-webm` for those layouts. The browser provides **Upgrade media preview** in its file actions.
