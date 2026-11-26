# Activity and progress

The chat and the call show what Jarvis is doing while a tool works. Everything shown comes from a real event; there are no timers that pretend work and no invented percentages.

## Flow

1. The runtime maps SDK messages to `tool_start` (the model starts writing the call), `tool_run` (the complete call goes out to execution) and `tool_end` (result, with the tool's failure code when it has one).
2. `TurnActivity` (`apps/server/src/conversation/turn-activity.ts`) follows each execution of a turn and emits one `activity` message per change: `preparing`, `running`, `waiting`, `needs_approval`, `succeeded`, `failed`, `cancelled`. Each execution has its own `version`, so duplicates and late events are recognizable.
3. `waiting` is sent once, when a call has been running longer than 5 seconds. It is the only timer, and it only names a measured fact.
4. When the turn ends, anything still open is closed (`cancelled`, or `failed` for a failed turn) before `turn.end`.
5. A client that connects in the middle of a turn receives the executions still open (`orchestrator.openActivity`).

The message carries ids, the tool name, the phase, a version and a timestamp. It never carries arguments, content or free text: the client writes the text from its own registry. Sending is fire-and-forget; if it fails, the turn goes on. Under a slow socket (more than 64 KB queued) intermediate updates are dropped and the final ones always go out. `progress` exists in the contract for tools that measure real progress; no tool reports it yet, so nothing shows a percentage.

## Client

- `ActivityStore` (`apps/web/src/activity/activity-store.ts`) keeps the executions per turn, outside the thread, so an update re-renders only the activity of its turn. It ignores older versions, anything after a final phase and anything for a turn that ended. It keeps at most 30 turns and 40 executions per turn.
- Losing the connection marks open calls as `interrupted` ("Sin conexión"), never as failed. On reconnect the unfinished turns are forgotten and the server describes the running ones again.
- `describeActivity` (`view.ts`) turns a turn into one compact line: the current action, or "Trabajando en N cosas…" when several run together, with the detail one tap away. At the end it resolves into a summary under the reply.
- The row appears 350 ms after the turn starts (`animation-delay` in `.activity`), so quick tasks do not flicker. Animations use opacity and transform only and respect `prefers-reduced-motion`.
- The call screen shows only the current action, at the top. Nothing is spoken: the visual state never speaks, and existing spoken notices are unchanged.

## Adding a tool

1. Define the tool as usual (`packages/contracts/src/tools.ts`, `apps/server/src/tools`).
2. Add its entry to `toolPresentations` in `apps/web/src/activity/registry.ts`: the integration it belongs to, the text while it runs (`Buscando en Gmail…`) and the text when it is done. The record is typed on the contract's tool names, so it does not compile without the entry, and `registry.test.ts` checks it again.
3. For a new integration, add it to `integrations` with a name, a category and a visual: a logo (`apps/web/public/logos/<name>.png`, local only) or a glyph from `glyphs.tsx`.
4. Work that goes on in the background after the tool returns says that it started ("Video encargado"), not that it finished.

A tool that is not in the registry (a new SDK built-in, for instance) is shown with a generic icon and its sanitized name; it never breaks the interface. Built-ins from the SDK go in `externalPresentations`.

## Demo scenarios

`?demo` answers these words with scripted activity: `rápida`, `lenta` (reaches the waiting state), `secuencia`, `paralelas`, `falla`, `reintento`, `larga` (stays open until stopped), `desconocida`, `confirmar`.

## Pending

- The downloads and transfers modules do not report progress yet, so their calls show an indeterminate indicator.
- Summaries live in memory: they are not rebuilt after reloading the page.
- YouTube has no local logo; it uses a generic video icon.
