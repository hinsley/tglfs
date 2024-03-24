# File storage protocol
In order to upload large files to Telegram, we subdivide them into smaller files Telegram will accept, sending these smaller chunks one at a time.

### Caption annotations to aid in search
```
tgfs <ufid> chunk <chunk_id>/<total_num_chunks> <filename>
```