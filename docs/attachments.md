# Chat attachments

The owner attaches photos and files from the composer. They show as thumbnails (with a remove button) before sending, travel with the message, and stay in the owner's bubble. JARVIS sees photos and PDFs directly and can forward any attachment.

Status: *implemented*, *tested with fixtures*. Pending the first deploy and a real try from the iPhone.

## Flow

```
owner picks a photo → the phone redraws it as a JPEG of at most 1600 px → POST /api/attachments (owner only)
  → stored in DATA_DIR/attachments/<id> (mode 600) + attachments row
  → thumbnail in the composer; sending puts the ids in user.text (text may be empty)
turn → user message with attachment cards
     → the model gets photos (jpeg, png, webp, gif) and PDFs up to 5 MB as content blocks,
       plus a line "[adjuntos del dueño: <id> «name» (type, size)]" so tools can reuse the ids
```

## Uses

| Use | Tool | Notes |
| --- | --- | --- |
| Analyze | none | Photos and PDFs are part of the prompt. Their content is third-party data. |
| WhatsApp | `whatsapp_send`, `whatsapp_to_me` with `attachmentId` | The outbox stores the id; the bridge sends a photo with caption, or a document with its name, in its single `sendMessage` call. |
| Gmail | `gmail_send` with `attachmentIds` | multipart/mixed with base64 parts; file names are encoded words without quotes or line breaks. The card lists the files. |
| Pages | `page_create`, `page_update` with `attachmentIds` | Photos only. They are linked to the page (`page_assets`) and served at `p.lminervino18.com/<slug>/f/<id>`; another page's id answers 404. |
| Tasks | `task_create` with `attachmentIds` | The agent gets a copy in the work inbox, never the personal file. |

Instagram has no sending: JARVIS offers WhatsApp or mail instead.

## Limits

- 64 MB per file, 4 per message. The model sees images and PDFs up to 5 MB directly; audio, video, Excel, Word and text files are read first (see below); anything else is still forwardable.
- Previews at `GET /api/attachments/:id` are owner only, `Content-Security-Policy: sandbox` and `nosniff`; anything that is not an image or a PDF is served as a download.

## Audio transcription

The owner uploads a WhatsApp voice note (or any audio) from their phone and JARVIS answers with the text. Status: *tested with fixtures*; not tried with a real provider yet.

```
owner uploads the audio file → POST /api/attachments/transcribe (owner only, raw body, Content-Type = audio type)
  → type and size validated (voice/audio-file-transcription.ts)
  → the same OpenAI-compatible STT as the calls (OpenAiCompatibleStt.transcribeFile → /audio/transcriptions)
  → { "text": "..." } or { "error": "<code>" }
```

- Types: `audio/ogg` (voice notes, `codecs=opus` is ignored), `audio/opus`, `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/x-wav`, `audio/wave`. Up to 25 MB (the provider's limit).
- Errors, always without audio or text: `unsupported_type` (415), `empty_file` (400), `file_too_large` (413), `stt_unavailable` (503, no OpenAI-compatible STT configured), `transcription_failed` (502). Invalid files never reach the STT.
- The audio is not stored and not logged; the transcript is only in the response.
- Voice notes received on WhatsApp no longer need uploading by hand: see "WhatsApp files" below.

## Reading any file

`files/file-analysis.ts` turns a file into something the model can read, for chat attachments and WhatsApp files alike.

| Kind | What the model gets |
| --- | --- |
| Photos (jpeg, png, webp, gif, stickers) | The image, up to 5 MB |
| Audio | Groq Whisper transcript |
| Video | 4 frames spread over the video (ffmpeg, 768 px) plus the transcript of its sound |
| PDF | Text of the first 40 pages (`pdftotext`); chat PDFs up to 5 MB still go to the model as documents |
| Excel (xlsx) | Up to 5 sheets × 300 rows as text (`read-excel-file`) |
| Word (docx) | Paragraph text |
| CSV, TXT, JSON, MD, XML, HTML | The text |
| Anything else | A note: it can be forwarded or shared, not read |

Text is capped at 30 000 characters. Everything read from a file is third-party content.

## WhatsApp files

- **When a media message arrives**, the bridge stores its kind, name, type, size and length in `wa_media`. It also stores the decryption key and CDN path, encrypted with `TOKEN_ENCRYPTION_KEY`; the file itself is not downloaded. Messages from before 2026-11-23 have no key, so their files cannot be fetched.
- **`whatsapp_get_messages` and `whatsapp_search`** show `file` on those messages.
- **`whatsapp_get_file`** downloads and decrypts the file with Baileys (a read-only fetch from WhatsApp's CDN, with no receipt or request to the phone).
  - The file is kept as a chat attachment (up to 64 MB), so later uses do not download it again.
  - The tool returns the attachment id and the reading above. Photos and video frames are handed to the model as images.
  - WhatsApp deletes old media from its CDN. Those files answer "expired", and the owner has to forward them again.
- **Forwarding:**
  - WhatsApp: photos and videos go with the text as caption. Audios go as a voice note (ogg) right after the text, since audios carry no caption. Anything else goes as a document.
  - Gmail: attachments up to 20 MB in total.

## Share links

- **`file_share_link`** creates an unguessable public link at `p.lminervino18.com/d/<token>` that stops working after 7 days.
  - Photos, videos, audio and PDFs open in the browser; anything else downloads.
  - Responses use byte ranges (iPhones need them to play video) and the original quality.
  - Headers: `Content-Security-Policy: sandbox`, `nosniff`, `noindex`.
- It is a state change: after the turn read third-party content, it waits for the owner's confirmation.
- Expired links are purged every 6 hours.
- Pages can show the owner's videos as well as photos (`page_create` / `page_update` with `attachmentIds`; served with ranges, CSP `media-src 'self'`).
