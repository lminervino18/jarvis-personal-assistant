# Web pages

JARVIS writes small public web pages for the owner: invitations, surveys, sign-up forms and landings. They are served at `https://p.lminervino18.com/<slug>`, are designed for phones first, and tell the owner whenever someone answers.

Status: *implemented*, *tested with fixtures*, and the generator *validated with real service* (Sonnet 5.5, 21 s, 9 KB page, no validation problems, 2026-11-22). The public host is pending its first deploy.

## Flow

```
owner: "armá una invitación para la cena del viernes y preguntá si vienen"
  → page_create (returns the link at once; JARVIS keeps talking)
      → background: one-shot model call with the "Pulso" design guide → checks → stored in jarvis.db
      → chat message with the link + push ("La página «…» está lista"); spoken aloud if the owner is in a call
visitor answers → POST /r/<slug> on the page host → stored → chat message with the answer + push (no content in the push)
owner: "¿qué respondieron?" → page_responses (third-party content, taints the turn) → show_table
```

## Pieces

| Piece | Code | Notes |
| --- | --- | --- |
| Design guide | `apps/server/src/pages/design-guide.ts` | The owner's "Pulso" identity: white, ultraviolet and black, a breathing three.js orb behind a glass card. Phone-first rules, the allowed script URLs and the answer contract. |
| Checks | `pages/page-html.ts` | Extracts the HTML, refuses scripts outside the allowlist, foreign stylesheets, iframes, `base` and refresh redirects, and anything over 200 KB. One retry tells the model what was wrong. |
| Service | `pages/page-service.ts` | Background generation, versions (a failed change keeps the published version online), answers with limits (30 keys, short values, 500 per page), notifications through the outbox. |
| Public host | `pages/pages-server.ts`, port 8081 | Its own origin, so page scripts never see the assistant's cookies or storage. Strict CSP: only the allowlisted CDNs and Google Fonts, `connect-src 'self'`, no framing. Answers are limited to 10 per minute per visitor and page. |
| Tools | `tools/page-tools.ts` | `page_create`, `page_update`, `page_list`, `page_responses`. Creation and changes are state-changing (blocked behind a card after untrusted content); answers are untrusted. |
| Background voice | `ConversationHub.announce`, `ClientConnection.announce` | News that arrives in the background (pages, tasks, reminders) is spoken aloud to a client in a call when nothing else is talking or listening. |

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `PAGES_DOMAIN` | `/opt/jarvis/.env` (Caddy) | Host name of the public page site. |
| `PAGES_BASE_URL` | `/opt/jarvis/.env` (server) | Public base URL; pages are disabled when unset. |
| `PAGES_PORT` | server env | Internal port of the page host, default 8081. |
| `PAGES_MODEL` | server env | Model that writes pages, default the chat model. |

DNS: `p` A and AAAA records point at the VPS (Vercel DNS). The apex CAA allows Let's Encrypt, so Caddy issues the certificate on the first request.

## Checking the guide

`pnpm --filter @jarvis/server exec tsx scripts/page-probe.ts <out.html>` writes one sample invitation with the real model and the production guide, using the local Claude login. It costs one page generation.

## Not yet

- Visitors cannot upload files; answers are text, numbers, booleans and lists.
- Pages are public to anyone with the link; there is no password or expiry.
