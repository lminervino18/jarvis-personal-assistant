# Google Drive

JARVIS manages the owner's Google Drive:
- organizes what it keeps in a **Jarvis** folder;
- uploads files from the chat and from Transferencias, of any size;
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
| `drive_upload` | state change | Chat attachments (`attachmentIds`) and Transferencias files (`transferIds`) into a folder (`folderId`, Jarvis by default) and a path of subfolders inside it (`folderPath`, «Solares/Fecha 3»), created when missing. `name` renames a single file. |
| `drive_upload_status` | third-party content | State, progress and link of the latest Transferencias uploads, or of one. |
| `drive_update` | state change | Rename and/or move. |
| `drive_share` | state change | Anyone with the link can view, or one email as viewer or editor. |
| `drive_download` | third-party content | A file or a folder link into chat attachments: up to 30 files, 50 MB each and 200 MB in total. Docs and Slides are exported as PDF, Sheets as Excel. |
| `drive_trash` | state change | Moves a file to the trash, where it stays recoverable for 30 days. |

- Links are accepted as the owner pastes them: files, folders, Docs, `open?id=`, and `resourcekey` for old shared links.
- The Jarvis folder is found by a private `appProperties` mark, so renaming it does not lose it.

## Uploads from Transferencias (`apps/server/src/integrations/drive/drive-uploads.ts`)

- They run in the background, one at a time, with Drive's resumable protocol in 32 MB chunks. The session address is saved in `drive_uploads` (migration 022), so a dropped connection, a deploy or a restart resumes where it stopped. Drive keeps a session about a week; an expired one starts over.
- Each upload keeps a hard link to the file in `/data/drive-uploads/`, so it survives the 24-hour Transferencias expiry. The link is removed when the upload ends.
- **No duplicates:** the file carries an `appProperties` key made of its size and a hash of its first and last 8 MB. When that key is already in the destination folder, nothing is uploaded and the owner gets the existing link.
- **Retries:** a failure retries after 1, 5, 15, 60 and 180 minutes. A missing connection or a refused operation fails at once.
- **Notice:** a push and a chat message with the Drive link when it ends or fails. The chat message never carries the file name, which may come from a third party.
