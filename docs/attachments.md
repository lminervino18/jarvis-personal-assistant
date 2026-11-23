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

- 10 MB per file, 4 per message. The model only receives images and PDFs up to 5 MB; other files are still forwardable.
- Previews at `GET /api/attachments/:id` are owner only, `Content-Security-Policy: sandbox` and `nosniff`; anything that is not an image or a PDF is served as a download.

## Audio transcription

The owner uploads a WhatsApp voice note (or any audio) from their phone and JARVIS answers with the text. Status: *tested with fixtures*; not tried with a real provider yet.

```
owner uploads the audio file → POST /api/attachments/transcribe (owner only, raw body, Content-Type = audio type)
  → type and size validated (voice/audio-file-transcription.ts)
  → the same OpenAI-compatible STT as the calls (OpenAiCompatibleStt.transcribeFile → /audio/transcriptions)
  → { "text": "..." } or { "error": "<code>" }
```

- Types: `audio/ogg` (voice notes, `codecs=opus` is ignored), `audio/opus`, `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/x-wav`, `audio/wave`. Up to 10 MB.
- Errors, always without audio or text: `unsupported_type` (415), `empty_file` (400), `file_too_large` (413), `stt_unavailable` (503, no OpenAI-compatible STT configured), `transcription_failed` (502). Invalid files never reach the STT.
- The audio is not stored and not logged; the transcript is only in the response.
- The WhatsApp bridge still downloads no media: the owner has to save the voice note and upload it by hand.
