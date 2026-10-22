# google_photos_mcp

A small local MCP server that lets Claude Code pull photos from your Google Photos.

## What it is for

You take photos on your phone. They back up to Google Photos. Later, at your laptop, you ask Claude to work with them. Some examples:

- Take notes from photos of a slide deck.
- Turn a photo of a whiteboard or journal page into Mermaid or Markdown.
- Ingest a batch of shots of an object for photogrammetry.

You no longer have to download photos and paste file paths.

## How it works

1. You ask Claude for photos.
2. A Google Photos picker opens in your laptop browser.
3. You select the photos and click Done.
4. The server downloads the originals to a temp folder and gives Claude the paths, capture times, and camera details.
5. The files are deleted when the Claude session ends, or after 24 hours.

## Limits

- You pick the photos yourself. Since March 2025, Google only lets apps see photos the user selects in the picker. An app cannot search your library on its own.
- There is no location data. Google removes GPS from picker downloads. Type a place name into the picker's search box instead.
- It runs on macOS. It uses the `open` command, the Keychain, and `sips`.

## Setup

1. Create a Google Cloud project and enable the Photos Picker API.
2. In Google Auth Platform, set the audience to External and add yourself as a test user.
3. Create a Desktop app OAuth client. Save its JSON as `~/.config/gphotos-mcp/client_secret.json`.
4. Build the server:

   ```sh
   npm install
   npm run build
   ```

5. Register it with Claude Code:

   ```sh
   claude mcp add --scope user gphotos -e GPHOTOS_SOURCE=picker -- node "$PWD/dist/index.js"
   ```

6. In a new Claude Code session, ask for photos. On first use, a Google sign-in tab opens. The server stores the refresh token in your macOS Keychain.

While the OAuth app stays in Testing mode, Google makes you sign in again every 7 days.

## Tools

| Tool | What it does |
|---|---|
| `pick_photos` | Opens the picker, waits for Done, downloads the files, and returns a manifest |
| `list_picked` | Filters photos you already picked by time, camera, or type, without opening the picker again |
| `cleanup_photos` | Deletes the temp files now |

## Development

```sh
npm test
npm run lint
```

The `spe/` folder holds the design evals. It compares five tool designs, selected with `GPHOTOS_CONFIG=a` through `e`. Config `c` is the default.
