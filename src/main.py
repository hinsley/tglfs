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

client = TelegramClient("tglfs", api_id, api_hash)


async def main():
    await client.start(phone=phone_number)

    while True:
        print()
        print("Enter a command:")
        print("1. Upload a file")
        print("2. Search for a file")
        print("3. Send a file")
        print("4. Rename a file")
        print("5. Delete a file")
        print("6. Download a file")
        print("7. Exit")
        command = input().strip()
        try:
            if command == "1":
                print()
                file_path = input("Enter the file path: ")
                encryption_password = None
                while True:
                    encryption_password = getpass(
                        "Password for encryption (hidden & optional): "
                    )
                    confirm = getpass("Confirm password: ")
                    if encryption_password == confirm:
                        break
                    print("Passwords do not match. Please try again.")
                tglfs_file = await telegram.store_file(
                    client, file_path, encryption_password
                )
                print(tglfs_file)
            elif command == "2":
                print()
                query_file_name = input("Enter the file name to look up: ")
                tglfs_files = await telegram.lookup_file(client, query_file_name)
                for file_ufid in tglfs_files:
                    print()
                    print(tglfs_files[file_ufid])
                print(f"{len(tglfs_files)} file(s) found.")
            elif command == "3":
                print()
                file_ufid = input("Enter the UFID of the file to send: ")
                if len(file_ufid) != 64:
                    raise KeyError("Invalid UFID.")
                tglfs_files = await telegram.lookup_file(
                    client, file_ufid
                )  # Note: This method is a little inefficient.
                tglfs_file = tglfs_files[file_ufid]
                recipient_id = input("Enter the identifier of the recipient: ")
                await telegram.send_file(client, tglfs_file, recipient_id)
                print("File sent successfully.")
            elif command == "4":
                print()
                file_ufid = input("Enter the UFID of the file to rename: ")
                if len(file_ufid) != 64:
                    raise KeyError("Invalid UFID.")
                tglfs_files = await telegram.lookup_file(
                    client, file_ufid
                )  # Note: This method is a little inefficient.
                tglfs_file = tglfs_files[file_ufid]
                print(f"Current file name: `{tglfs_file.file_name}`")
                new_file_name = input("Enter new file name: ")
                await telegram.rename_file(client, tglfs_file, new_file_name)
                print("File renamed successfully.")
            elif command == "5":
                print()
                file_ufid = input("Enter the UFID of the file to delete: ")
                if len(file_ufid) != 64:
                    raise KeyError("Invalid UFID.")
                tglfs_files = await telegram.lookup_file(
                    client, file_ufid
                )  # Note: This method is a little inefficient.
                tglfs_file = tglfs_files[file_ufid]
                # Confirm deletion.
                print("Deletion candidate:")
                print(tglfs_file)
                print()
                confirm = input("Are you sure you want to delete this file? [y/n] ")
                if confirm.lower().strip() != "y":
                    print("Deletion cancelled.")
                    continue
                print("Deleting file.")
                await telegram.delete_file(client, tglfs_file)
                print("Deletion complete.")
            elif command == "6":
                print()
                file_ufid = input("Enter the UFID of the file to download: ")
                if len(file_ufid) != 64:
                    raise KeyError("Invalid UFID.")
                tglfs_files = await telegram.lookup_file(
                    client, file_ufid
                )  # Note: This method is a little inefficient.
                tglfs_file = tglfs_files[file_ufid]
                # Check if file with same name exists in current directory.
                file_name = tglfs_file.file_name
                if os.path.exists(file_name):
                    confirm = input(
                        f"File {file_name} already exists. Overwrite? [y/n] "
                    )
                    if confirm.lower().strip() != "y":
                        print("Download cancelled.")
                        continue
                    print("Overwriting file.")
                    os.remove(file_name)
                decryption_password = getpass(
                    "Password for decryption (hidden & optional): "
                )
                await telegram.download_file(client, tglfs_file, decryption_password)
                print("Download complete.")
            elif command == "7":
                break
            else:
                print("Invalid command.")
        except Exception as e:
            print("An error occurred:", e)
            continue

    await client.disconnect()


with client:
    client.loop.run_until_complete(main())
