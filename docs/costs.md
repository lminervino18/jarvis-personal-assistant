# Costs

Every price below was read from the vendor page linked in its row on 2026-10-24 (the voice rows reuse the values already sourced in `docs/voice.md`, retrieved the same day). Prices change: re-check the page before approving any spending. Anything not marked "page" is an estimate or an assumption of mine and says so. No account was created and nothing was bought.

Currencies are kept as published (EUR for Hetzner, USD for the rest). Where a single total is needed I assume 1 EUR = 1.15 USD. That rate is an assumption, not a retrieved figure.

Taxes: Hetzner prices are published excluding VAT. Whether VAT applies to a customer in Argentina, and which Argentine taxes or perceptions a card statement adds to foreign-currency purchases, was not retrieved. Treat every figure here as pre-tax and check the first real statement.

## Scenarios

Assumptions: 30 days per month, 8 s of owner speech and 12 s of reply per turn.

| Turns per day | Turns per month | Speech in (minutes) | Reply out (minutes) | Reply characters (180 per reply) |
| --- | --- | --- | --- | --- |
| 10 | 300 | 40 | 60 | 54,000 |
| 30 | 900 | 120 | 180 | 162,000 |
| 60 | 1,800 | 240 | 360 | 324,000 |

180 characters per reply comes from `docs/voice.md`: Spanish speech from Piper ran at 15 characters per second, so 12 s is 180 characters. A second check with eight Spanish sample replies of about 28 words each (written for this document, synthetic) measured 153 to 162 characters, mean 157. The budget keeps 180 so it errs high.

## Claude (separate, not a per-query price)

| Plan | Price | Source (page, 2026-10-24) |
| --- | --- | --- |
| Pro | $20 per month, or $200 billed up front ($17 per month equivalent) | [claude.com/pricing](https://claude.com/pricing) |
| Max | from $100 per month | same |

Claude Code is listed as included in Pro and Max. The assistant runs on the owner's subscription through the Agent SDK, so the cost is the subscription itself. How many turns a plan allows depends on usage limits that Anthropic changes and that vary with model, effort and conversation length; this document does not turn the subscription into a number of queries and nobody should plan on one. If the limit is reached, the runtime reports it (see `docs/claude-runtime.md`) and the owner decides whether to raise the plan. Claude is not part of the totals below.

## Server

Needs for the stack with external voice: the server idles near 70 MB, the worker near 30 MB, Caddy near 20 MB (measured in the local compose test). Even a 2 GB machine is comfortable. Running faster-whisper and Piper on the same machine is the only reason to go larger (see "Voice on the VPS").

| Option | Specs | Price | Notes |
| --- | --- | --- | --- |
| Hetzner Cloud CX23 (cost-optimized) | 2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB traffic | EUR 5.99 per month excl. VAT | [hetzner.com/cloud/cost-optimized](https://www.hetzner.com/cloud/cost-optimized). Locations on the page: Nuremberg and Helsinki. The page rendered the product as "currently unavailable" (a dynamic widget; confirm in the console). |
| Hetzner primary IPv4 | per address | EUR 0.50 per month excl. VAT | [docs.hetzner.com/cloud/servers/overview](https://docs.hetzner.com/cloud/servers/overview/). Primary IPv6 is free. A phone on an IPv4-only network needs the IPv4, so budget it: CX23 = EUR 6.49. |
| Hetzner CX33 | 4 vCPU, 8 GB, 80 GB, 20 TB | EUR 8.99 excl. VAT (+0.50 IPv4) | same cost-optimized page. |
| Hetzner CPX21, US East (Ashburn) | 3 vCPU, 4 GB, 80 GB, 2 TB | EUR 32.49 | [hetzner.com/cloud/regular-performance](https://www.hetzner.com/cloud/regular-performance). The page says "Price incl. IPv4". Listed as unavailable on fetch. Closer to South America than Europe, but expensive. |
| AWS Lightsail, 2 GB bundle | 2 vCPU, 2 GB, 60 GB SSD, 3 TB transfer, IPv4 included | $12 per month | [aws.amazon.com/lightsail/pricing](https://aws.amazon.com/lightsail/pricing/) |
| AWS Lightsail, 4 GB bundle | 2 vCPU, 4 GB, 80 GB SSD, 4 TB transfer, IPv4 included | $24 per month | same |
| AWS Lightsail IPv6-only 2 GB | 2 vCPU, 2 GB, 60 GB | $10 per month | same. Not recommended: the PWA and push must be reachable from IPv4-only mobile networks. |
| Lightsail extras | snapshots $0.05 per GB-month; transfer over the allowance $0.09 per GB (the page's example) | | same. The restic backups replace snapshots. |
| Lightsail region | South America (Sao Paulo) `sa-east-1` is supported | | [Regions and Availability Zones](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html). The pricing page shows one table and does not say whether Sao Paulo is priced differently: confirm in the console before ordering. |

### Latency to Buenos Aires versus the Claude API

Hetzner offers no South American location. From Buenos Aires, Nuremberg or Helsinki is roughly 230 to 280 ms round trip and Sao Paulo roughly 30 to 50 ms (estimates from general experience, not measured here). A voice turn crosses the WebSocket a few times (speech chunks up, text and audio chunks down), so Europe adds on the order of half a second to the time to first audio, while the Claude call itself takes seconds. The Claude API is served from the United States, so Sao Paulo and Frankfurt are in the same ballpark for that leg. The owner can measure real round trips from the phone with a ping or a speed-test host of each provider before ordering. The decision is: pay about $6 more per month for Sao Paulo to save latency on every turn, or accept the extra delay for the cheapest option.

## Voice

Rates for the external providers (all USD, API pay-as-you-go):

| Item | Rate | Source |
| --- | --- | --- |
| Groq `whisper-large-v3-turbo` | $0.04 per hour of audio, 10 s minimum per request | [console.groq.com/docs/speech-to-text](https://console.groq.com/docs/speech-to-text) |
| Groq `whisper-large-v3` | $0.111 per hour | same |
| OpenAI `gpt-4o-mini-transcribe` | $0.003 per minute (estimated by the page) | [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI `gpt-4o-transcribe` | $0.006 per minute | same |
| Deepgram Nova-3 multilingual, streaming | $0.0058 per minute (a limited-time rate; the page lists $0.0092 as the previous one); pre-recorded $0.0052 | [deepgram.com/pricing](https://deepgram.com/pricing). $200 free credit for new pay-as-you-go accounts. |
| ElevenLabs Flash v2.5 (TTS) | $0.04 per 1,000 characters | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) |
| ElevenLabs Multilingual v2 (TTS) | $0.08 per 1,000 characters | same |
| ElevenLabs plans | Free $0 (10,000 characters), Starter $6, Creator $22, Pro $99, Scale $299 per month | same. The page lists included characters (10,000 / 75,000 / 275,000 / 1,238,000 / 3,738,000) without labeling each row, so the plan mapping is inferred; the characters are for the newest model and other models may count differently. Plans are shown for reference. The totals use the per-character API rate. |
| OpenAI `tts-1` | $15 per 1M characters | developers.openai.com pricing page above |
| Piper, faster-whisper on the VPS | no usage fee | see "Voice on the VPS" |

Monthly voice cost by scenario (USD):

| Turns per day | Groq turbo STT (10 s billed per turn) | OpenAI mini STT | Deepgram streaming STT | ElevenLabs Flash TTS | ElevenLabs Multilingual v2 TTS | Groq + Flash total |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 0.03 | 0.12 | 0.23 | 2.16 | 4.32 | 2.19 |
| 30 | 0.10 | 0.36 | 0.70 | 6.48 | 12.96 | 6.58 |
| 60 | 0.20 | 0.72 | 1.39 | 12.96 | 25.92 | 13.16 |

Groq bills a minimum of 10 s per request, and an 8 s utterance is billed as 10 s: 300 turns are 3,000 s (0.83 h) and so on. The text-to-speech line is the dominant cost; STT is cents. If the voice is a clone or a premium voice, ElevenLabs may price it differently: the model chosen for the final voice sets the rate.

### Voice on the VPS

Piper (about 770 MB limit in compose) and faster-whisper `small` int8 (about 2 GB limit) run CPU-only with no per-use fee. They make the 2 vCPU / 4 GB machine tight once the server is counted, and STT latency on 2 vCPU is slow. Practical sizing for the `voice` profile is 4 vCPU / 8 GB: Hetzner CX33 EUR 8.99 + 0.50 IPv4, or Lightsail 8 GB at $44 (2 vCPU only, so a poor fit). Measured latencies for both sidecars are in `docs/voice.md`.

## Other services

| Item | Price | Source |
| --- | --- | --- |
| YouTube Data API v3 | free; default 10,000 units per day for all endpoints except `search.list`, which has its own default limit of 100 calls per day (each costs 1 unit); `videos.list`, `channels.list`, `playlistItems.list` cost 1 unit per call | [developers.google.com/youtube/v3/determine_quota_cost](https://developers.google.com/youtube/v3/determine_quota_cost) (page last updated 2026-10-15) |
| Web Push | no vendor charge (browser push services); the cost is the VAPID keys the owner generates | project design, no price page |
| Gmail API, Google OAuth | no charge for personal use at this volume (not researched in detail) | not retrieved |
| Domain, `.com` at Porkbun | $11.08 per year registration and renewal, ICANN fees included | [porkbun.com/products/domains](https://porkbun.com/products/domains). Tax not stated. |
| Domain, Cloudflare Registrar | sold at cost, no markup; the page shows no price | [cloudflare.com/products/registrar](https://www.cloudflare.com/products/registrar/) |
| Backblaze B2 | $6.95 per TB per month, free egress up to 3x stored data, no minimum storage duration, S3-compatible; the page lists API calls A, B and C as free for pay-as-you-go | [backblaze.com/cloud-storage/pricing](https://www.backblaze.com/cloud-storage/pricing) |
| Cloudflare R2 Standard | $0.015 per GB-month, Class A $4.50 and Class B $0.36 per million, egress free, free tier 10 GB-month, 1M Class A, 10M Class B | [developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/) |

Backup size estimate: the synthetic database in the restore test is 340 KB with 200 messages. A year of heavy use is likely tens of MB; restic deduplicates, so 30 daily snapshots (the default `BACKUP_RETENTION_DAYS=30`) stay well under 1 GB. That is under the R2 free tier (10 GB) and about $0.007 per month on B2. Choose either; both speak S3 and the commands in `docs/deploy.md` cover both.

## Totals

Recommended configuration: a 2 GB machine, external voice (Groq turbo STT + ElevenLabs Flash TTS), R2 or B2 backups, a `.com` domain.

| | 10 turns per day | 30 turns per day | 60 turns per day |
| --- | --- | --- | --- |
| Server, Lightsail Sao Paulo 2 GB | $12.00 | $12.00 | $12.00 |
| Voice (Groq + Flash) | $2.19 | $6.58 | $13.16 |
| Backups | about $0.01 | about $0.01 | about $0.02 |
| Domain ($11.08 per year) | $0.92 | $0.92 | $0.92 |
| Total without Claude | about $15.1 | about $19.5 | about $26.1 |

The cheaper server variant, Hetzner CX23 with IPv4 at EUR 6.49 (about $7.46 at the assumed rate), lowers each total by about $4.5 at the cost of the latency discussed above. Add the Claude subscription (from $20 per month, separate) for the all-in figure. Voice on the VPS (profile `voice`) replaces the voice line with $0 but requires the 4 vCPU / 8 GB class (Hetzner CX33 EUR 9.49 with IPv4, about $10.9), which gives roughly $11.8 per month without Claude (server, domain and backups) for any turn volume, with slower and less natural voice.

Free tiers (for example an always-free cloud instance) were not researched or priced. They are acceptable only for experiments: instances can be reclaimed or throttled, and the assistant holds private data.

## Re-checking before spending

1. Open each URL in the tables and compare. Prices, plan names and the 10 s Groq minimum are the figures most likely to change.
2. Confirm the Hetzner product is orderable and the Lightsail Sao Paulo price.
3. Order the smallest option first; both providers bill by the hour or month and the stack moves with one restic restore (`docs/runbook.md`).
