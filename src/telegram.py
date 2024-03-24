from dataclasses import dataclass
from typing import Dict
import os
import tempfile
import time

from telethon.client.telegramclient import TelegramClient

from ufid import ufid
import storage

@dataclass
class TgfsFile:
    ufid: str
    file_name: str
    file_size: int # In bytes.
    num_chunks: int
    time: int # Unix timestamp.

async def store_file(client:TelegramClient, file_path:str) -> TgfsFile:
    file_ufid = ufid(file_path)
    num_chunks = storage.get_num_chunks(file_path)
    tgfs_file = TgfsFile(
        ufid=file_ufid,
        file_name=os.path.basename(file_path),
        file_size=os.path.getsize(file_path),
        num_chunks=num_chunks,
        time=int(time.time())
    )
    for i in range(num_chunks):
        # Store a chunk in a local file.
        chunk = storage.get_chunk(file_path, i)
        chunk_file_path = storage.save_chunk(file_ufid, i, chunk)

        # Send the chunk to Telegram.
        file_caption = f"tgfs {file_ufid} chunk {i+1}/{num_chunks} {os.path.basename(file_path)}"
        await client.send_message(
            "me",
            file_caption,
            file=chunk_file_path
        )
        
        # Remove the chunk file locally.
        os.remove(chunk_file_path)
        print(f"Sent file {file_ufid} chunk {i+1}/{num_chunks}.")
    
    return tgfs_file

async def lookup_file(client:TelegramClient, query_file_name:str) -> Dict[str, TgfsFile]:
    files: Dict[str, TgfsFile] = {}
    search_query = f"tgfs {query_file_name} chunk"

    async for message in client.iter_messages("me", search=search_query):
        msg = message.message
        file_ufid = msg[5:69]
        chunk_size = message.document.size
        chunk_index = msg[70:70+msg[70:].index("/")]
        num_chunks = int(msg[70+msg[70:].index("/")+1:76+msg[76:].index(" ")])
        file_name = msg[76+msg[76:].index(" ")+1:]
        chunk_time = int(message.date.timestamp())

        if file_ufid not in files:
            files[file_ufid] = TgfsFile(
                ufid=file_ufid,
                file_name=file_name,
                file_size=chunk_size,
                num_chunks=num_chunks,
                time=chunk_time
            )
        else:
            files[file_ufid].file_size += chunk_size
            if chunk_time < files[file_ufid].time:
                files[file_ufid].time = chunk_time
    
    return files

async def download_file(client:TelegramClient, tgfs_file:TgfsFile) -> bytes:
    # Download file chunk-by-chunk and stream to a file locally.
    for i in range(tgfs_file.num_chunks):
        search_query = f"tgfs {tgfs_file.ufid} chunk {i+1}/{tgfs_file.num_chunks} {tgfs_file.file_name}"
        async for message in client.iter_messages("me", search=search_query):
            chunk_file_name = await message.download_media()
            with open(chunk_file_name, "rb") as chunk_file:
                chunk_data = chunk_file.read()
                with open(tgfs_file.file_name, "ab") as file:
                    file.write(chunk_data)
            os.remove(chunk_file_name)
            print(f"Finished downloading chunk {i+1}/{tgfs_file.num_chunks} of file `{tgfs_file.file_name}`.")
