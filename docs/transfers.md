# Transferencias

Files kept in their original quality for 24 hours, to pass them between the owner's phone and any computer, or to receive them from someone with a link.

Status: *implemented* and *tested with fixtures*. A real end-to-end run in Chromium against the real routes, tus and ffmpeg: a 40 MB file came back with the same SHA-256. Validation on a real iPhone is pending.

## How files get in

- **The owner, from the chat:** «+» › «Transferir en calidad original». It uploads the bytes as they are, unlike «Foto o archivo para Jarvis», which compresses images for the model.
- **The owner, from Transferencias:**
  - phone: «+» › «Ver transferencias», or the notification;
  - computer: the sidebar.
  - Files can be dropped on the page.
- **Someone else:** an upload link (`/subir/<token>`) created from Transferencias or by Jarvis (`transfer_upload_link`). It is a page with no account and lasts 24 hours.

Uploads are resumable (tus, 4 MB chunks, so a slow mobile connection fits Caddy's 3-minute body timeout):
- a dropped connection or a minimized app resumes on its own;
- choosing the same file again after a reload continues where it stopped;
- closing the page stops the upload, because no web page can upload after it is closed.

## How files get out

- Transferencias shows photos and videos as thumbnails, made once by ffmpeg (480 px, and 1600 px for the viewer). Music gets an icon and plays in the viewer; GIFs animate. Any other type shows its extension and downloads as is.
- Each thumbnail has its own buttons:
  - download: downloads the original without opening the file. On a phone it is a share button instead: it brings the original and opens the share sheet («Guardar video», «Guardar en Archivos»), because an installed web app on iOS cannot download;
  - delete: the first tap asks «¿Borrar?», the second deletes.
- In the viewer, a photo always fits the screen. «Ampliar», a double tap or a double click zooms it: a tall image fills the width and scrolls from the top, other photos grow up to three times. On a computer the arrows sit in the side margins, on a phone in the top bar, so they never cover the photo.
- Videos play from the original by ranges, so only what is watched is downloaded.
- «Bajar original» downloads the exact bytes; on a phone it is «Guardar o compartir», with the same share sheet.
- «Convertir a» in the viewer makes an MP3 of a video or song, or an iPhone version of a video, as a new file next to it. Details in `docs/media-downloads.md`.
- A share link (`/bajar/<token>`) lets anyone download one file while it exists.
- An upload from a computer or through a link notifies the phone: a push and a chat line, at most one per sender every two minutes. The notification opens `/transferencias`.

## Limits and security

- **Files and space:**
  - 20 GB per file and 20 GB in total per upload link.
  - An upload is refused if it would leave less than 10 GB free on the server.
  - Files, their previews and links are deleted after 24 hours: sweep every 15 minutes, plus a check on every request.
- **Who uploads and where:**
  - The server decides who is uploading: the owner's session, or the link's token sent in the `upload-link` header.
  - That decision is passed to the tus hooks keyed by the server's own request object, never through a client header.
  - Each uploader can only continue its own uploads.
- **Tokens:** link tokens are random, stored as SHA-256 hashes, and shown only when created.
- **Untrusted content:**
  - Names of files that arrived through a link are third-party content. They never go into the chat message; Jarvis reads them only through `transfer_list`, which marks the turn as untrusted.
  - Downloads are served as attachments with `nosniff` and a sandbox CSP.

Code:
- server: `apps/server/src/transfers/`, plus `tools/transfer-tools.ts`;
- web: `apps/web/src/transfers/`, `ui/TransfersScreen.tsx`, `ui/TransferViewer.tsx` and `ui/PublicPages.tsx`.
