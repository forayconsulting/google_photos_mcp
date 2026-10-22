# Phase 0 spike findings (2026-10-22)

## Setup done

- GCP project `gphotos-mcp-cc1022` under the personal Gmail account. Photos Picker API enabled.
- Google Auth Platform: External audience, app name `gphotos-mcp`, personal Gmail as support and contact email.
- Desktop OAuth client created. Its JSON is at `~/.config/gphotos-mcp/client_secret.json` (mode 600, directory 700).
- The personal Gmail account is the only test user.
- Refresh token stored in the macOS Keychain, service `gphotos-mcp`, account `refresh_token`.

## Results

| Check | Result |
|---|---|
| Picker scope classification | Non-sensitive (console Data Access page) |
| Publish to Production | Blocked. The console disables "Publish app" until the Branding page is complete. Home page and privacy policy links are empty. |
| Refresh token life in Testing | 7 days (Google OAuth docs). Re-auth weekly until published. |
| Loopback OAuth with PKCE and random state | Works. Scope granted as requested. |
| Session `expireTime` | 7 days after creation |
| `pollingConfig` | `pollInterval` 5s, `timeoutIn` about 1800s (30 min) |
| `/autoclose` | The tab did not close after Done when the tab was opened by `open` or driven by Playwright. Not a blocker. |
| Picker page in a Playwright-driven tab | Stuck loading in the attached tab. The tab opened by `open` loaded normally. |
| `=d` photo download | HTTP 200. File keeps EXIF DateTimeOriginal, Make, Model. GPS IFD absent. |
| `=dv` video download | HTTP 200, 78 MB 4K mp4. `processingStatus` READY. |
| PickedMediaItem metadata | createTime, type, mimeType, filename, width, height, cameraMake, cameraModel, focalLength, apertureFNumber, isoEquivalent, exposureTime, fps |
| Library account | The picker showed same-day phone uploads, so this account holds the phone backup. |

## Open

- Production publishing needs a home page and privacy policy URL on an authorized domain. This needs the user's decision.

## Blocking call in Claude Code

- `claude -p` (Claude Code 2.1.308) with a stdio stub whose tool blocks 600 s: the call returned "waited 600s" after 604 s. No timeout. Cost $0.12.
- Config C (one blocking `pick_photos`) stays the baseline. Config E stays as an eval arm.

## Built server, live

- `dist/index.js` config C, source `picker`, real account: picker opened, 3 photos picked, downloaded in 33 s including picking, `list_picked` filtered them, session deleted, temp folder removed on server exit.
