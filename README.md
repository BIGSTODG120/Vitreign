# Vitreign

Find the photo you’d go back for. See it again. Make sure you can get it back.

Vitreign is a self-hosted photo and video workspace for Immich. Open the airlock, browse in 3D, and give a reel its own sequence, captions, and pacing. Archive shows the storage available to your host. Restore Check compares a chosen original and restored copy byte for byte in your browser. You can explore the included sample library offline.

## Open Vitreign

1. Install [Node.js](https://nodejs.org/) 24.16 or newer and extract the source ZIP into a folder on your computer.
2. On Windows, double-click **Launch Vitreign.cmd**. On macOS or Linux, open the extracted folder in a terminal and run `npm run launch`.
3. Choose **Try the sample library** or **Connect Immich**. Keep the launcher window open while you use the gallery.

The launcher opens your browser. When you connect Immich, it checks the server and key, saves the connection locally, and opens the gallery with a one-time sign-in. Save the generated workspace key for later. Vitreign can start with the included sample library before you install Immich. An existing `.env` opens the gallery directly with its current settings.

For a terminal-only start, open the extracted folder and run:

```sh
npm run dev
```

Open the loopback address printed by the server. The default is `http://127.0.0.1:4173`. If the port is busy, startup tries the next 30 ports. The app has no third-party npm runtime dependencies. Docker is optional in sample mode.

Scroll through the airlock or select **Open library**. The opener supports normal scrolling, keyboard entry, and reduced motion. In **Library**, filter by filename, media type, and UTC capture dates. Select a photo or video and choose **Reels** to add it. In a reel, select **Edit sequence** to move frames and set per-frame captions and optional photo hold times. **Play reel** screens the full sequence. **Export index** downloads the ordered filenames, cues, and asset references as JSON. Keep indexes private when the content is sensitive.

Open **Commands** or press **Ctrl + K** on Windows and Linux or **⌘ + K** on Mac. Jump to a workspace view, replay the airlock, start the current reel, or type a photo filename to search the library.

To verify a restore, open **Restore Check** from the sidebar or Archive. Pick the original and a restored copy from separate locations, then select **Compare files**. The browser reads both files in bounded blocks on this device and identifies the first changed byte or a size difference. A match applies to the two selected files. The browser cannot establish that they came from independent storage.

Vitreign saves your favorites and reels in `.data/library.sqlite`. Stop Vitreign before copying that database as part of your backup. Back up Immich separately.

## Connect Immich

Start your Immich server first. In Immich’s **Account Settings → API Keys**, create a key with `asset.read`, `asset.view`, and `album.read`. Open the Vitreign launcher, enter the Immich address and key, then choose **Check and connect**. The setup page includes a link to Immich’s installer guide if you need it. [Immich setup](https://docs.immich.app/install/docker-compose/) · [Immich account settings](https://docs.immich.app/features/user-settings/)

## Manual configuration

Use these steps for an existing `.env`, optional originals and guest sharing, or a server deployment:

1. Start Immich by following its [official Docker Compose guide](https://docs.immich.app/install/docker-compose/). Use a patched release.
2. Sign in to Immich with the account whose library you want to browse. In account settings, create an API key with `asset.read`, `asset.view`, and `album.read` permissions.
3. Copy `.env.example` to `.env`. Set `IMMICH_URL` to the Immich server origin, without `/api`, and set `IMMICH_API_KEY` locally.
4. Generate a separate Vitreign workspace key with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Set `VITREIGN_ACCESS_KEY` to the result, restart Vitreign, and use that workspace key on the unlock screen.
5. Import or back up files through Immich. For a drive or NAS that already contains your originals, use an [Immich External Library](https://docs.immich.app/guides/external-library/) and follow the [storage guide](docs/storage.md).
6. Optional. Grant `asset.download` in Immich and set `VITREIGN_ORIGINALS=1` to show **Original** in the viewer. This downloads the original bytes through the authenticated session. The gallery uses Immich previews and browser-compatible playback. The original retains its source format and metadata.

Vitreign browses the Immich timeline and albums. Search matches filenames. Uploads, mobile backup, face recognition, and source album editing are available through Immich. Favorites and reels are Vitreign data, scoped to the configured Immich URL and API key. Changing either selects a separate set of saved items. Vitreign excludes archived, hidden, locked, trashed, and offline assets from its gallery.

If you already have an Immich Compose file, set `IMMICH_COMPOSE_FILE` to its absolute path so Vitreign can start that stack when Immich is offline.

## Share an item

Open a photo or video and choose **Share**. A Vitreign link requires access to the same workspace and server.

To offer 24-hour guest links, add `sharedLink.create` and `asset.share` to the Immich key and set `IMMICH_SHARE_ORIGIN` to your intended HTTPS Immich address. Make sure recipients can reach that address. The confirmation in Vitreign creates a guest link in Immich with uploads, original downloads, and metadata display disabled. Revoke it from Immich’s sharing screen.

## Network access

The Node server binds to `127.0.0.1`. For private network access through a local reverse proxy, configure its HTTPS origin as `VITREIGN_ORIGIN` and use a fixed `PORT`. Preserve the public Host header. In this mode the app accepts sign-ins only from the configured HTTPS origin and sets a Secure, HttpOnly, SameSite=Strict session cookie. Protect the proxy with your own network and identity controls.

Each Vitreign instance serves one trusted workspace and one Immich account. Anyone you give the access key can browse the configured library and change its Vitreign favorites and reels. Deploy separate instances and credentials for independent libraries. Store real secrets in environment configuration excluded from Git, and use TLS when crossing a network.

## Storage and license

- [Storage and offload guide](docs/storage.md)
- `npm run check` runs the automated tests.

Vitreign is an independent Immich companion and an open-source project from Nythis Obsidian AI Inc. Its source is licensed under [AGPL-3.0-only](LICENSE). The bundled font licenses are in [public/fonts](public/fonts).
