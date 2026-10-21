<p align="center">
  <img src="public/icons/TGLFS%20logo%20192.png" alt="TGLFS logo" width="96" height="96">
</p>
<h1 align="center">TGLFS</h1>
<p align="center">Large file storage on Telegram</p>

## What is this?

Telegram permits 2 GiB file storage for free users and 4 GiB for premium subscribers; however, they have no overall limit on the total amount of data stored on their servers.
TGLFS is a web app that allows you to upload, download, and send files to other people on Telegram, without a file size limit.
New uploads use independently compressed, authenticated AES-256-GCM blocks. Interrupted uploads resume from completed blocks when the same files and password are selected again. Multi-file batches and plain `.tar` uploads include an encrypted directory for browsing individual members.

TGLFS is live at https://tglfs.vercel.app.

The TGLFS web app is a fully offline client; it's served as a static single-page web app and only makes requests to the Telegram API via the [`gram.js`](https://github.com/gram-js/gramjs) library.
Your data is encrypted before it leaves your device. A nonempty password protects file contents; an omitted password is the empty string and provides no password-based secrecy. The outer file card still exposes its name, total size, and content UFID. Archive member names, paths, and contents are encrypted.
Feel free to run your own copy of the software locally so that you can verify the client's integrity.

## Getting started

Select an indexed tar archive and choose **Preview** to browse its folders and open individual members. For an older, completed `.tar`, choose **Upgrade archive** from the browser actions. An upgrade streams through memory, uploads a separate copy, reads it back to verify its size and UFID, and keeps the original card and data. It does not create a temporary local archive. Cancelling an upgrade preserves the original.

Existing file-card versions 1–4 remain readable. New file uploads use v5; explicit upgrades of older tar archives retain their established v4 format and preserve the source. Unknown future protocol versions are refused. Upgrading does not alter folder or sync protocols. Already-compressed archives such as `.tar.gz`, `.tgz`, ZIP, RAR, and 7z retain ordinary-file behavior. See [the storage protocol](doc/file_storage.md) for compatibility, resource limits, and recovery details.

## Dependencies

- All dependencies are managed via NPM and installed automatically. You do not need to manually install `telethon` or any Python encryption packages. This project uses the JavaScript `telegram` package (GramJS) and browser WebCrypto for encryption.

Install dependencies:

```sh
npm install
```

Build the app:

```sh
npm run build
```

Run the app locally with `npm run dev` and navigate to `http://localhost:5173` in your browser.

To preview the production build, run `npm run preview` after `npm run build`.

Likely only Chrome, Edge, and Opera are currently supported.
I have only tested on Chrome.

Resumable downloads of v5 files are supported in the CLI and browsers with the file save API, such as Chrome and Edge. Repeat the download using the same destination and password. Saved blocks are checked locally before more data is fetched. Other browsers retain streamed downloads with a notice that interrupted downloads must restart. Transfers stop when the tab closes; a background helper is deferred. Passwords and encryption keys are never saved in checkpoints.

New MP4/WebM preview copies use file-card v5 with a versioned encrypted media index. Scrubbing fetches the prior keyframe and nearby fragments. **Upgrade media preview** makes a lossless, separate copy of already fragmented/indexable media; unsupported layouts are refused and can use conversion instead. The original and its password are kept. Interrupted conversion restarts encoding; downloads of completed v5 copies resume normally.
