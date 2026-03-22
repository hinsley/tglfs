# tglfs

`tglfs` is a global CLI for authenticating with Telegram and downloading current-format TGLFS files by UFID.

## Install

```sh
npm install -g tglfs
```

## Commands

```sh
tglfs --help
tglfs help login
tglfs help download
tglfs login
tglfs status
tglfs logout
tglfs download <ufid>
```

On Unix-like systems, installed manpages are also available:

```sh
man tglfs
man tglfs-login
man tglfs-download
```

## Auth Flow

Run `tglfs login` once to save:

- Telegram API ID
- Telegram API hash
- your phone number
- the resulting Telegram session

If you do not supply an API ID or API hash, the CLI defaults to the same bundled Telegram app credentials the web client currently uses. You can still override them with flags or environment variables.

The CLI stores config and session files in OS-standard app directories. Use `tglfs status` to inspect the current state.

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
```

Interactive TTY downloads render a progress bar. `--json` stays quiet until the final result so agents can parse the output safely.

## Environment Variables

Login:

- `TGLFS_API_ID`
- `TGLFS_API_HASH`
- `TGLFS_PHONE`
- `TGLFS_LOGIN_CODE`
- `TGLFS_2FA_PASSWORD`

If `TGLFS_API_ID` and `TGLFS_API_HASH` are unset, `tglfs login` falls back to the bundled web-client credentials.

Download:

- `TGLFS_DOWNLOAD_PASSWORD`

## AI-Agent Use

The CLI is designed to work with interactive agents and terminal tools:

- Prefer direct subcommands instead of menus when automating.
- Use `--json` for machine-readable `status` and `download` output.
- Use stdin or env vars for secrets in non-interactive runs.
- If Telegram asks for an SMS/in-app code or 2FA password and no secret source was supplied, the agent should hand off to the user to provide it.

Examples:

```sh
tglfs status --json
printf '%s\n' "$TGLFS_DOWNLOAD_PASSWORD" | tglfs download <ufid> --password-stdin --json
```
