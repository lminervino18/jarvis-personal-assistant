# Google Drive

JARVIS manages the owner's Google Drive:
- organizes what it keeps in a **Jarvis** folder;
- uploads files from the chat;
- shares files and folders with a public link or with a person;
- downloads files or whole folders from a link someone sent, so they can be forwarded by WhatsApp.

Status: *implemented* and *tested with fixtures*; connection *pending owner connection* until the personal Google account is reconnected with Drive access.

## Access

- Same Google account and OAuth client as Gmail. The connection now also asks for `https://www.googleapis.com/auth/drive`, full access, which reading files others shared needs.
- Drive counts as connected when the personal account's stored scopes include it. Configuración shows the "Google Drive" row, which reconnects the account.
- Google Cloud project `jarvis-asistente-515415`:
  - Drive API enabled;
  - the scope added under Data access;
  - the app is In production, so refresh tokens do not expire after 7 days (the unverified-app warning stays).

## Tools (`apps/server/src/tools/drive-tools.ts`)

| Tool | Kind | What |
| --- | --- | --- |
| `drive_search` | third-party content | Search by name, or list a folder (the Jarvis folder by default). |
| `drive_create_folder` | state change | New folder, inside Jarvis by default. |
| `drive_upload` | state change | Chat attachments into a folder. |
| `drive_update` | state change | Rename and/or move. |
| `drive_share` | state change | Anyone with the link can view, or one email as viewer or editor. |
| `drive_download` | third-party content | A file or a folder link into chat attachments: up to 30 files, 50 MB each and 200 MB in total. Docs and Slides are exported as PDF, Sheets as Excel. |
| `drive_trash` | state change | Moves a file to the trash, where it stays recoverable for 30 days. |

- Links are accepted as the owner pastes them: files, folders, Docs, `open?id=`, and `resourcekey` for old shared links.
- The Jarvis folder is found by a private `appProperties` mark, so renaming it does not lose it.
