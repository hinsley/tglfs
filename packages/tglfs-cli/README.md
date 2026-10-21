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
```

On Unix-like systems, installed manpages are also available:

```sh
man tglfs
man tglfs-login
man tglfs-upload
man tglfs-search
man tglfs-download
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

Batch uploads and individual `.tar` uploads use file-card protocol v4. Their tar bytes are stored in independently compressed, authenticated encrypted blocks with an encrypted directory index, so the web app can browse and preview members without downloading the complete archive. Ordinary files, including `.tar.gz`, `.tgz`, ZIP, and other compressed archives, continue to use file-card v3; those inner archive formats are not indexed by this release.

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

TTY uploads render UFID and upload progress bars. Indexed archives compute the UFID during a single streaming upload pass, then read back the uploaded blocks to verify the complete tar before publishing a file card. `--json` prints exactly one final JSON object to stdout, writes failures to stderr, and never prompts. An omitted password is the empty string and uses the same encryption process; it provides no password-based confidentiality.

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

Downloads read file-card versions 1, 2, 3, and 4. A v4 archive is reconstructed as the exact original tar with bounded memory, and its full size and UFID are verified before replacing the destination file. `--legacy` applies only to the older counter-advance pipeline and is refused for v4 archives. Unknown future file-card or archive-content versions are refused.

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

Run the expensive full integrity probe only when you want it (current/legacy detection for v1–3, or authenticated block and UFID verification for v4):

```sh
tglfs inspect <ufid> --probe
tglfs inspect <ufid> --password 'secret'
```

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

Inspect:

- `TGLFS_INSPECT_PASSWORD`

Sync:

- `TGLFS_SYNC_PASSWORD`

## AI-Agent Use

The CLI is designed to work with interactive agents and terminal tools:

- Prefer direct subcommands instead of menus when automating.
- Use `--json` for machine-readable `status`, `search`, `upload`, `rename`, `delete`, `send`, `receive`, `unsend`, `inspect`, and `download` output. In JSON mode, the CLI prints one success object to stdout, prints failures to stderr, and disables prompts.
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
