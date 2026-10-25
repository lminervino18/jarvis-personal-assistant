import type { Card, HistoryItem, ServerMessage } from "@jarvis/contracts";

export type Role = HistoryItem["role"];

export interface ThreadMessage {
  id: string;
  turnId: string | null;
  role: Role;
  text: string;
  at: string;
  interrupted: boolean;
  cards: Card[];
  /** Assistant text that is still arriving. */
  streaming: boolean;
  /** Created on this device and not yet replaced by the server's copy. */
  local: boolean;
  /** A local message the server never acknowledged before the connection dropped. */
  unsent: boolean;
}

export interface Transcript {
  turnId: string;
  text: string;
  final: boolean;
}

export interface ThreadState {
  conversationId: string | null;
  messages: ThreadMessage[];
  hasMore: boolean;
  awaitingInitial: boolean;
  loadingOlder: boolean;
  transcript: Transcript | null;
}

type ServerEvent<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export type ThreadEvent =
  | ServerEvent<"ready" | "history" | "assistant.delta" | "assistant.done" | "card" | "transcript" | "error" | "turn.end">
  | { type: "local.user"; turnId: string; text: string }
  | { type: "local.older" };

export function emptyThread(): ThreadState {
  return { conversationId: null, messages: [], hasMore: false, awaitingInitial: false, loadingOlder: false, transcript: null };
}

/** Applies one server or local event. `receivedAt` timestamps messages the server did not date. */
export function reduceThread(state: ThreadState, event: ThreadEvent, receivedAt: string): ThreadState {
  switch (event.type) {
    case "ready":
      return event.conversationId === state.conversationId
        ? { ...state, awaitingInitial: true }
        : { ...emptyThread(), conversationId: event.conversationId, awaitingInitial: true };
    case "history":
      return event.conversationId === state.conversationId ? onHistory(state, event) : state;
    case "assistant.delta":
      return updateTurnReply(state, event.turnId, receivedAt, (message) => ({ ...message, text: message.text + event.text }));
    case "assistant.done":
      return onDone(state, event, receivedAt);
    case "card":
      return event.turnId ? addTurnCard(state, event.turnId, event.card, receivedAt) : onStandaloneCard(state, event.card, receivedAt);
    case "transcript":
      return { ...state, transcript: event.final && !event.text.trim() ? null : { turnId: event.turnId, text: event.text, final: event.final } };
    case "error":
      return event.turnId ? upsertLocal(state, localMessage("system", event.turnId, event.message, receivedAt)) : state;
    case "turn.end":
      return settleTurn(state, event.turnId);
    case "local.user":
      return { ...upsertLocal(state, localMessage("user", event.turnId, event.text, receivedAt)), transcript: null };
    case "local.older":
      return { ...state, loadingOlder: true };
  }
}

function placeholderId(role: Role, turnId: string): string {
  return `local:${role}:${turnId}`;
}

function localMessage(role: Role, turnId: string, text: string, at: string): ThreadMessage {
  return { id: placeholderId(role, turnId), turnId, role, text, at, interrupted: false, cards: [], streaming: role === "assistant", local: true, unsent: false };
}

function fromHistory(item: HistoryItem): ThreadMessage {
  return { ...item, streaming: false, local: false, unsent: false };
}

function replaceAt(messages: ThreadMessage[], index: number, message: ThreadMessage): ThreadMessage[] {
  const next = messages.slice();
  next[index] = message;
  return next;
}

function upsertLocal(state: ThreadState, message: ThreadMessage): ThreadState {
  const index = state.messages.findIndex((m) => m.id === message.id);
  const messages = index >= 0 ? replaceAt(state.messages, index, message) : [...state.messages, message];
  return { ...state, messages };
}

function onHistory(state: ThreadState, event: ServerEvent<"history">): ThreadState {
  const items = event.items.map(fromHistory);
  if (state.awaitingInitial) return mergeInitial(state, items, event.hasMore);
  if (state.loadingOlder && isOlderPage(state, items)) {
    const known = new Set(state.messages.map((m) => m.id));
    const older = items.filter((item) => !known.has(item.id));
    return { ...state, messages: [...older, ...state.messages], hasMore: event.hasMore, loadingOlder: false };
  }
  return clearTranscriptFor(items, { ...state, messages: items.reduce(upsertServerMessage, state.messages) });
}

function isOlderPage(state: ThreadState, items: ThreadMessage[]): boolean {
  const oldest = state.messages.find((m) => !m.local);
  const newestIncoming = items.at(-1);
  if (!oldest || !newestIncoming) return true;
  return Date.parse(newestIncoming.at) <= Date.parse(oldest.at) && newestIncoming.id !== oldest.id;
}

/**
 * The page sent on (re)attach is authoritative for what it covers. Older pages already loaded
 * are kept, a reply still streaming is kept, and local messages the server never saw are
 * kept but flagged as unsent.
 */
function mergeInitial(state: ThreadState, items: ThreadMessage[], hasMore: boolean): ThreadState {
  const ids = new Set(items.map((item) => item.id));
  const covered = new Set(items.map((item) => `${item.role}:${item.turnId}`));
  const first = items[0];
  const older = first
    ? state.messages.filter((m) => !m.local && !ids.has(m.id) && Date.parse(m.at) < Date.parse(first.at))
    : [];
  const pending = state.messages
    .filter((m) => m.local && !covered.has(`${m.role}:${m.turnId}`))
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.streaming))
    .map((m) => (m.role === "user" ? { ...m, unsent: true } : m));
  return clearTranscriptFor(items, {
    ...state,
    messages: [...older, ...items, ...pending],
    hasMore: older.length > 0 ? state.hasMore : hasMore,
    awaitingInitial: false,
    loadingOlder: false,
  });
}

function upsertServerMessage(messages: ThreadMessage[], item: ThreadMessage): ThreadMessage[] {
  const byId = messages.findIndex((m) => m.id === item.id);
  if (byId >= 0) return replaceAt(messages, byId, item);
  if (item.turnId) {
    const placeholder = messages.findIndex((m) => m.id === placeholderId(item.role, item.turnId as string));
    if (placeholder >= 0) return replaceAt(messages, placeholder, item);
  }
  return [...messages, item];
}

function clearTranscriptFor(items: ThreadMessage[], state: ThreadState): ThreadState {
  const turnId = state.transcript?.turnId;
  if (!turnId || !items.some((item) => item.role === "user" && item.turnId === turnId)) return state;
  return { ...state, transcript: null };
}

function findReply(messages: ThreadMessage[], turnId: string): number {
  return messages.findIndex((m) => m.role === "assistant" && m.turnId === turnId);
}

function updateTurnReply(
  state: ThreadState,
  turnId: string,
  receivedAt: string,
  update: (message: ThreadMessage) => ThreadMessage,
): ThreadState {
  const index = findReply(state.messages, turnId);
  if (index < 0) return { ...state, messages: [...state.messages, update(localMessage("assistant", turnId, "", receivedAt))] };
  return { ...state, messages: replaceAt(state.messages, index, update(state.messages[index] as ThreadMessage)) };
}

function onDone(state: ThreadState, event: ServerEvent<"assistant.done">, receivedAt: string): ThreadState {
  const existing = state.messages.findIndex((m) => m.id === event.messageId);
  const placeholder = state.messages.findIndex((m) => m.id === placeholderId("assistant", event.turnId));
  const base = state.messages[existing] ?? state.messages[placeholder];
  const final: ThreadMessage = {
    id: event.messageId,
    turnId: event.turnId,
    role: "assistant",
    text: event.text,
    at: base?.at ?? receivedAt,
    interrupted: event.interrupted,
    cards: base?.cards ?? [],
    streaming: false,
    local: false,
    unsent: false,
  };
  let messages = state.messages;
  if (existing >= 0) {
    messages = replaceAt(messages, existing, final);
    if (placeholder >= 0) messages = messages.filter((_, i) => i !== placeholder);
  } else if (placeholder >= 0) {
    messages = replaceAt(messages, placeholder, final);
  } else {
    messages = [...messages, final];
  }
  return { ...state, messages };
}

/** Identity of cards whose later versions replace earlier ones. */
export function cardIdentity(card: Card): string | null {
  switch (card.kind) {
    case "confirm":
      return `confirm:${card.actionId}`;
    case "youtube":
      return `youtube:${card.requestId}`;
    case "reminder":
      return `reminder:${card.reminderId}`;
    case "event":
      return `event:${card.eventId}`;
    default:
      return null;
  }
}

function withCard(cards: Card[], card: Card): Card[] {
  const identity = cardIdentity(card);
  const index = identity ? cards.findIndex((c) => cardIdentity(c) === identity) : -1;
  if (index < 0) return [...cards, card];
  const next = cards.slice();
  next[index] = card;
  return next;
}

function addTurnCard(state: ThreadState, turnId: string, card: Card, receivedAt: string): ThreadState {
  return updateTurnReply(state, turnId, receivedAt, (message) => ({ ...message, cards: withCard(message.cards, card) }));
}

function onStandaloneCard(state: ThreadState, card: Card, receivedAt: string): ThreadState {
  const identity = cardIdentity(card);
  const index = identity ? state.messages.findIndex((m) => m.cards.some((c) => cardIdentity(c) === identity)) : -1;
  if (index >= 0) {
    const message = state.messages[index] as ThreadMessage;
    return { ...state, messages: replaceAt(state.messages, index, { ...message, cards: withCard(message.cards, card) }) };
  }
  const message: ThreadMessage = {
    id: `local:card:${identity ?? card.kind}:${receivedAt}`,
    turnId: null,
    role: "system",
    text: "",
    at: receivedAt,
    interrupted: false,
    cards: [card],
    streaming: false,
    local: true,
    unsent: false,
  };
  return { ...state, messages: [...state.messages, message] };
}

function settleTurn(state: ThreadState, turnId: string): ThreadState {
  const index = state.messages.findIndex((m) => m.id === placeholderId("assistant", turnId));
  const transcript = state.transcript?.turnId === turnId ? null : state.transcript;
  if (index < 0) return { ...state, transcript };
  const message = state.messages[index] as ThreadMessage;
  return { ...state, transcript, messages: replaceAt(state.messages, index, { ...message, streaming: false }) };
}

const SINGLE_INSTANCE_KINDS = new Set<Card["kind"]>(["confirm", "youtube"]);

/**
 * Confirmation and player cards are shown once, where they first appeared, with the latest
 * version received (e.g. a confirmation that later became "confirmed").
 */
export function threadView(messages: ThreadMessage[]): ThreadMessage[] {
  const latest = new Map<string, Card>();
  for (const message of messages) {
    for (const card of message.cards) {
      const identity = cardIdentity(card);
      if (identity && SINGLE_INSTANCE_KINDS.has(card.kind)) latest.set(identity, card);
    }
  }
  const shown = new Set<string>();
  return messages.map((message) => {
    let changed = false;
    const cards = message.cards.flatMap((card) => {
      const identity = cardIdentity(card);
      if (!identity || !SINGLE_INSTANCE_KINDS.has(card.kind)) return [card];
      if (shown.has(identity)) {
        changed = true;
        return [];
      }
      shown.add(identity);
      const newest = latest.get(identity) ?? card;
      if (newest !== card) changed = true;
      return [newest];
    });
    return changed ? { ...message, cards } : message;
  });
}
