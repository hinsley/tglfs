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

TTY uploads render separate UFID and upload progress bars. `--json` stays quiet until the final result so agents can parse the output safely.

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

Interactive TTY downloads render a progress bar. `--json` stays quiet until the final result so agents can parse the output safely.

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

## Peer Transfer And Inspection

Receive files from another peer into Saved Messages:

```sh
tglfs receive alice <ufid...>
```

Delete received files from another peer mailbox:

```sh
tglfs unsend alice <ufid...> --yes
```

Inspect file-card metadata and chunk references:

```sh
tglfs inspect <ufid>
tglfs inspect <ufid> --peer alice
```

Run the expensive full current-vs-legacy integrity probe only when you want it:

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

## AI-Agent Use

The CLI is designed to work with interactive agents and terminal tools:

- Prefer direct subcommands instead of menus when automating.
- Use `--json` for machine-readable `status`, `search`, `upload`, `rename`, `delete`, `send`, `receive`, `unsend`, `inspect`, and `download` output.
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
