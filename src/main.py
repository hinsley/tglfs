#!/usr/bin/env python3

from getpass import getpass
import json
import os

from telethon import TelegramClient

import telegram

# Load config data.
with open("config.json") as config_file:
    config_data = json.load(config_file)
    api_id = config_data["api_id"]
    api_hash = config_data["api_hash"]
    phone_number = config_data["phone"]

client = TelegramClient("tgfs", api_id, api_hash)

async def main():
    await client.start(phone=phone_number)

    while True:
        print()
        print("Enter a command:")
        print("1. Upload a file")
        print("2. Search for a file")
        print("3. Download a file")
        print("4. Exit")
        command = input().strip()
        try:
            if command == "1":
                print()
                file_path = input("Enter the file path: ")
                encryption_password = None
                while True:
                    encryption_password = getpass("Password for decryption (hidden & optional): ")
                    confirm = getpass("Confirm password: ")
                    if encryption_password == confirm:
                        break
                    print("Passwords do not match. Please try again.")
                tgfs_file = await telegram.store_file(client, file_path, encryption_password)
                print(tgfs_file)
            elif command == "2":
                print()
                query_file_name = input("Enter the file name to look up: ")
                tgfs_files = await telegram.lookup_file(client, query_file_name)
                for file_ufid in tgfs_files:
                    print()
                    print(tgfs_files[file_ufid])
                print(f"{len(tgfs_files)} file(s) found.")
            elif command == "3":
                print()
                file_ufid = input("Enter the UFID of the file to download: ")
                tgfs_files = await telegram.lookup_file(client, file_ufid) # Note: This method is a little inefficient.
                tgfs_file = tgfs_files[file_ufid]
                # Check if file with same name exists in current directory.
                file_name = tgfs_file.file_name
                if os.path.exists(file_name):
                    confirm = input(f"File {file_name} already exists. Overwrite? [y/n] ")
                    if confirm.lower().strip() != "y":
                        print("Download cancelled.")
                        continue
                    print("Overwriting file.")
                    os.remove(file_name)
                decryption_password = getpass("Password for decryption (hidden & optional): ")
                await telegram.download_file(client, tgfs_file, decryption_password)
            elif command == "4":
                break
            else: 
                print("Invalid command.")
        except Exception as e:
            print("An error occurred:", e)
            continue
    
    await client.disconnect()

with client:
    client.loop.run_until_complete(main())
