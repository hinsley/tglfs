# tglfs

Large file storage on Telegram

## What is this?

Telegram permits 2 GiB file storage for free users and 4 GiB for premium subscribers; however, they have no overall limit on the total amount of data stored on their servers.
TGLFS is a web app that allows you to upload, download, and send files to other people on Telegram, without a file size limit.
All files are `gzip`-compressed (for fast upload/download speeds) and AES-256-CTR encrypted with optional passwords (to prevent Telegram from reading your files).

TGLFS is live at https://tglfs.vercel.app.

The TGLFS web app is a fully offline client; it's served as a static single-page web app and only makes requests to the Telegram API via the [`gram.js`](https://github.com/gram-js/gramjs) library.
Your data is encrypted before it ever leaves your device, so nobody can read your files without the password (as long as the client you are using has not been tampered with).
Feel free to run your own copy of the software locally so that you can verify the client's integrity.

## Getting started

Install dependencies:

```sh
npm install
```

Build the app:

```sh
npm run build
```

Run the app, either by navigating to `dist/index.html` in your browser, or running the command `npm run run` and navigating to `http://localhost:1234` in your browser.

Likely only Chrome, Edge, and Opera are currently supported.
I have only tested on Chrome.