# Background transfers

The optional native helper owns file reads, encryption, Telegram connections and download destinations. Once it acknowledges a job, closing the web tab or browser does not cancel it. The helper and computer must remain running; sleep or network loss can interrupt a transfer. The helper is a detached CLI process, not a browser worker or an installed startup service.

## Set up

Use Node.js 22 or later and build/install the current CLI:

```sh
npm run build --workspace tglfs
npm install -g ./packages/tglfs-cli
tglfs login
tglfs helper start --upload-root "/path/to/files"
```

The helper uses its own CLI Telegram login. Sign in to the same account as the web app. Each `--upload-root` grants read access to that folder and its regular files; repeat it for additional folders. No upload folders are exposed by default. Symbolic links and paths escaping those folders are refused. Stop the helper before changing its grants. On restart, omitted options reuse the previous configuration.

The default download folder is `~/Downloads/TGLFS`. Override it with `--download-dir`. Each download gets a separate job folder, and existing destination files are never overwritten. Downloads are decrypted files saved in that folder, just like ordinary downloads. The helper does not cache an extra full source or output copy for uploads.

In the app, open **Tools → Background transfers → Pair helper**, paste the code printed by `start`, and allow local network access if the browser asks. Pairing requires the same Telegram account. The pairing code grants access to the configured upload roots and transfer controls; share it only with your own TGLFS app. It stays in the tab's memory. `tglfs helper pair` displays it again. Each helper restart rotates it, so pair again after restarting.

The default permitted app origin is `https://tglfs.vercel.app`. For another deployment, repeat `--origin` with each exact trusted HTTPS origin. Local development accepts an explicit loopback HTTP origin:

```sh
tglfs helper start --upload-root "/path/to/files" --origin http://127.0.0.1:5173
```

The endpoint is always `127.0.0.1` and is not a remote server. Browser local-network restrictions can block pairing; this feature does not bypass browser permissions or disable security settings. See [Chrome's local network access documentation](https://developer.chrome.com/blog/local-network-access).

## Transfer and recover

While paired, the file browser's **Upload files** opens a picker for the helper's granted folders. Select files there, then supply the encryption password, including an empty password. Multiple files become a tar archive. Dropped files must be selected again through this picker because browser `File` objects do not expose native paths. The file browser's **Download** hands the selected complete file card and original password to the helper.

A transfer belongs to the helper only after acceptance. Transfers started before pairing remain browser transfers. Video conversion, archive-member downloads and archive/media upgrades remain in their existing tab or CLI workflows. Share-target uploads remain browser transfers. The panel states that video conversion requires an open tab; selecting a video through the helper uploads its original bytes without automatically converting it.

The panel shows progress, saved download paths, explicit cancellation and **Unlock and resume**. Disconnecting the tab leaves accepted jobs running. A lost acknowledgement offers **Retry handoff** with the same job ID, preventing duplicate execution. If the tab was closed before seeing the acknowledgement, pair again and inspect the queue before starting another copy.

```sh
tglfs helper status
tglfs helper status --json
tglfs helper stop
```

Stopping/restarting the helper clears its in-memory file passwords. Interrupted jobs remain saved and require the original password to resume; it is never changed by recovery. V5 uploads reuse verified remote blocks and downloads reuse locally verified blocks. Old file cards v1–v4 remain readable using their existing streaming decoder; an interrupted older download restarts its stream. Cancellation preserves remote upload checkpoints and local partial downloads. Originals and completed Telegram blobs are never deleted or migrated by the helper.

## Security and versions

The helper binds only to IPv4 loopback and verifies the HTTP Host and exact allowed Origin. Each request has a fresh nonce and timestamp, and request/response HMAC-SHA256 signatures authenticate the endpoint and body. Replays and unsigned requests are rejected. Passwords are additionally sealed with AES-256-GCM using an HKDF-derived key, a fresh IV and the job ID as authenticated context. The pairing token is never sent as an HTTP header or plaintext body. CORS has no wildcard. A browser disconnect is independent of the job's cancellation signal.

File passwords/keys are held only in process memory while jobs run or wait; they are absent from the private job ledger, logs, checkpoints and browser storage. The helper's pairing token and existing CLI Telegram session are private local credentials. Protect the local OS account; loopback authentication is not protection against malicious software already running as that user.

This change introduces local `tglfs:helper-config`, `tglfs:helper-job` and `tglfs:helper-process` records, each **v1**. The signed control envelope (`tglfs:helper-request` / `tglfs:helper-response`), pairing code and encrypted `tglfs:helper-secret` use **v1** too. Missing/unknown versions and malformed records are refused. Unknown durable fields are refused rather than discarded. Queue records bind jobs to their original Telegram account, source identities, destination and optional upload-session ID. On restart, queued/running records become `needs-password`; other records are preserved. Future records are never silently migrated or removed.

Telegram file storage is unchanged: read file-card **v1–v5**, write **v5** for new helper uploads; upload-session/block/manifest and download-checkpoint **v1** stay unchanged. There is no existing-file migration or protocol bump for the scheduling feature. Uploads stream bounded file ranges or generated tar ranges; downloads retain only their normal partial destination and small checkpoint. The queue and private JSON writes use owner-only file permissions on systems with POSIX permissions.
