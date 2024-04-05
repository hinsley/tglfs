# tglfs
Large file storage on Telegram

## Getting started
Install dependencies:
```sh
pip3 install cryptography encryption telethon
```

Edit `config.json` (you need to get an API key [from Telegram](https://my.telegram.org) first).

Run `src/main.py`.

## Notes
If you have Telegram premium, you can increase the `chunk_size_gb` field in `config.json` to a larger number.
Once encrypted, files are usually larger, so do leave a small buffer beyond your chunk size to accommodate Telegram's file size limit.
I have personally not had success using a chunk size greater than `0.25` gigabytes, despite this only encrypting to roughly `0.4096` gigabytes and my having a Telegram Premium file size limit of 4 gigabytes.
YMMV.

