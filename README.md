# tglfs
Large file storage on Telegram

## Getting started
Install dependencies:
```sh
pip3 install encryption telethon
```

Edit `config.json` (you need to get an API key from Telegram first).

Run `src/main.py`.

## Notes
If you have Telegram premium, you can increase the `chunk_size_gb` field in `config.json` to a larger number.
Once encrypted, files are usually larger, so do leave a small buffer beyond your chunk size to accommodate Telegram's file size limit.
