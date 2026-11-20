# Store 20 TB on your own hardware

Vitreign reads your media through Immich. Your originals can live on a desktop disk, an attached USB drive, or a NAS mounted on the Immich server. The browser receives thumbnails and streams individual assets. Vitreign keeps favorites and reel order in a small SQLite database.

A 20 TB drive is about 18.2 TiB. A full 20 TB archive needs additional capacity for growth, generated previews, and a separate backup. Measure the bytes in your source archive and allocate the working copy and backup independently. Keep Immich’s PostgreSQL database on a suitable local SSD filesystem or a Docker-managed Linux volume, including when the media lives on a NAS. [Immich requirements](https://docs.immich.app/install/requirements/)

## An existing photo drive

1. Mount the drive on the Immich server. On Windows assign a stable drive letter in Disk Management. On Linux use a persistent mount path. For a NAS, mount the share on the server first and restrict its credentials to the storage that Immich needs.
2. Under `immich-server` in the official Compose file, add a new bind mount to the existing `volumes` list. Keep Immich’s existing `/data` mount. For a Windows library at `E:\Media`, the new item is:

   ```yaml
   - "E:/Media:/mnt/external/photos:ro"
   ```

   A Linux host can use `/srv/media:/mnt/external/photos:ro` when `/srv/media` is its persistent mount.
3. Recreate the service with `docker compose up -d` from the Immich Compose directory. In Immich, open **Administration → External Libraries**, create a library owned by the Immich account you will use with Vitreign, and add `/mnt/external/photos` as an import path. Run its scan while the drive is connected.
4. Verify a recent photo and a large video in Immich, then open them in Vitreign. Large imports can take time to index and transcode. Allow the initial scan to finish before judging missing previews. External drive changes may require a manual rescan, especially on network shares.
5. Before disconnecting a mounted drive, pause scheduled scans or stop Immich. Immich can send missing files to trash during a rescan. Reconnect the same source under the same container path before resuming scans. [Immich external libraries](https://docs.immich.app/features/libraries/)

## Track capacity in Archive

Configure a path that the Vitreign process can access. In Vitreign’s `.env` add one entry for each volume or mounted share. Choose distinct names. Paths and markers stay on the server.

```dotenv
VITREIGN_STORAGE_ROOTS='[{"name":"Photo archive","path":"E:/Media","marker":"studio-drive-01"}]'
```

For a verified identity check, place a UTF-8 text file named `.vitreign-volume` in that directory. Put the exact marker value on its only line. On Windows, with the correct drive connected:

```powershell
Set-Content -LiteralPath 'E:\Media\.vitreign-volume' -Value 'studio-drive-01' -Encoding ascii
```

Restart Vitreign and open **Archive**. **Volume verified** means the marker matched and the filesystem reported capacity. Without a marker, **Path reachable** means the path responded. Two paths on the same volume can show the same capacity. The display reflects the filesystem’s space available to the service.

If Immich and Vitreign run on different hosts, configure only mounts that the Vitreign host can access. Keep the Immich host responsible for its storage and uptime. Archive checks volume reachability and identity. File integrity and disaster recovery require a backup and a restore test.

## Offload an existing library safely

1. Identify the source type. For a folder-backed External Library, preserve its Immich container path and folder layout. For an Immich-managed library, preserve the full `UPLOAD_LOCATION` layout and the PostgreSQL database. Immich uses both.
2. Make an independent backup of the Immich database, existing originals, and Vitreign’s SQLite database. Save the current Compose and environment configuration privately. Keep a separate copy of irreplaceable media in another location.
3. Stop new uploads and stop Immich jobs while copying. Copy to the new drive, keeping the source intact. Verify file counts, byte totals, and content checksums before changing the mounted source.
4. Change the host storage path or `UPLOAD_LOCATION` to the verified copy. Keep the same container paths. Start Immich, then check counts, representative original downloads, and video seeks. Reconnect Vitreign’s Archive configuration if the path changed.
5. Use **Restore Check** to spot-check important original and restored file pairs. It compares their bytes on the device running the browser. For the entire archive, verify manifests or checksums with your backup tool and test a database restore. Keep the old media until both checks pass. Stop Vitreign before copying its SQLite database, or use a SQLite-compatible backup procedure. [Immich backup and restore](https://docs.immich.app/administration/backup-and-restore/)
