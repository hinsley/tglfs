# tgfs
File storage on Telegram

## Getting started
Install dependencies:
```sh
pip3 install encryption telethon
```

Edit `config.json` (you need to get an API key from Telegram first).

Run `src/main.py`.

## Notes
If you have Telegram premium, you can increase the `chunk_size_gb` field in `config.json` to `4`.
