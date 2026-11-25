# Images

JARVIS creates and edits images with the OpenAI Images API and leaves them in the chat. It can also send them by WhatsApp.

Status: *implemented* and *tested with fixtures*. The API key is *validated with real service*: OpenAI answered `insufficient_quota` on 2026-11-25 because the account has no credit yet.

## Flow

```
owner: "haceme una imagen de… (con esta foto) y mandásela a Ana"
  → image_create (returns at once; JARVIS keeps talking)
      → background: POST /v1/images/generations, or /v1/images/edits with the owner's photos as image[]
      → saved as an attachment → chat message with the image + push «Lista la imagen»
      → with sendTo: queued in wa_outbox with the image, sent at most once by the bridge
```

## Pieces

| Piece | Where |
| --- | --- |
| Service | `apps/server/src/images/image-service.ts` |
| Tool | `apps/server/src/tools/image-tools.ts`, `image_create` (state-changing: after third-party content it waits for the owner's OK) |
| Input | `toolInputs.image_create` in `packages/contracts/src/tools.ts` |

## Settings

| Variable | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | Restricted key with only Images allowed. Without it the tool says image generation is not configured. |
| `IMAGE_MODEL` | Optional, default `gpt-image-2`. |

## Cost

The API is billed apart from ChatGPT Plus, from prepaid credit. Estimates for gpt-image-2 at 1024×1024 (third-party figures, checked 2026-11-25):

| Quality | Per image |
| --- | --- |
| low | about USD 0.006 |
| medium (default) | about USD 0.05 |
| high | about USD 0.21 |

Reference photos add input cost. Set a monthly limit in OpenAI's Billing.

## Errors

OpenAI's answers are turned into a sentence the owner can act on:
- no credit: "cargalo en platform.openai.com › Billing";
- content policy;
- an invalid key;
- rate limits.
