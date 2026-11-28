# Tricount

JARVIS splits shared expenses like Tricount, from the chat or from the owner's @jarvis in a WhatsApp group (which runs as a full JARVIS turn, `docs/integrations/whatsapp.md`).

Status: *implemented* and *tested with fixtures*.

## How it works

- The model reads the conversation, voice notes or receipts and calls `tricount` (`apps/server/src/tools/tricount-tools.ts`) with who paid what, and who consumed each thing (`participants`) or in what proportion (`shares`). It never does the math itself.
- **Engine** (`apps/server/src/tricount/split.ts`), deterministic:
  - everything in whole cents; each expense is split among its participants by weight, and the leftover cents go to the largest remainders, so parts always add up to the total;
  - payments already made count against the balances;
  - settling: the biggest debtor pays the biggest creditor until everyone is even, which needs at most people minus one transfers. Ties follow the order people were listed, so the same split always gives the same answer.
- **Memory:** each split is kept by name (`tricounts`, migration 024). Calling again with the same name adds expenses, removes concepts, replaces the people or adds payments, and recalculates. Bank aliases are kept apart (`tricount_aliases`) for every future split.
- **Answer:** exactly the owner's format, nothing else. Transfers are grouped by who receives, the biggest first, with a blank line between groups, then the alias of each one who receives:

```
Flor → Pavón: $13.495
Gero → Pavón: $12.982

Gero → Loren: $12.179

Alias Pavón: ILOGIK
Alias Loren: lminervino18
```

- When someone who receives has no alias saved, the tool says so (`missingAliases`) and JARVIS asks for it.
- The tool is not a state change in the policy's sense: it only keeps the owner's own split and changes nothing outside, so it works in a turn that read a WhatsApp chat.
