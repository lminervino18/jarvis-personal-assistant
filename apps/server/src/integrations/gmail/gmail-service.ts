import type { GmailAccountLabel } from "@jarvis/contracts";
import type { IntegrationStatusItem, IntegrationStatusSource } from "../../tools/types.js";
import type { GoogleAccount, GoogleAccountStore } from "../google/account-store.js";
import { GoogleApiError, type GoogleApiErrorCode } from "../google/errors.js";
import type { GmailClient } from "./client.js";
import type { GmailMessage, GmailMessageSummary } from "./parse.js";

const ALL_LABELS: GmailAccountLabel[] = ["personal", "work"];
const CURSOR_PREFIX = "all.";
export const MAX_THREAD_MESSAGES = 15;

export interface TaggedMessage extends GmailMessageSummary {
  account: GmailAccountLabel;
  accountEmail: string;
}

export interface UnavailableAccount {
  account: GmailAccountLabel;
  code: GoogleApiErrorCode;
  message: string;
  retryable: boolean;
}

export interface GmailSearchOutcome {
  items: TaggedMessage[];
  nextCursor?: string;
  unavailable: UnavailableAccount[];
}

export interface GmailThreadOutcome {
  account: GmailAccountLabel;
  accountEmail: string;
  messages: GmailMessage[];
  omittedOlder: number;
}

const labelName = (label: GmailAccountLabel) => (label === "work" ? "de trabajo" : "personal");

function asApiError(error: unknown): GoogleApiError {
  return error instanceof GoogleApiError ? error : new GoogleApiError("upstream_error", "Gmail devolvió una respuesta inesperada.");
}

function decodeCursor(cursor: string | undefined): Partial<Record<GmailAccountLabel, string>> {
  if (!cursor) return {};
  try {
    if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error("bad cursor");
    const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
    return Object.fromEntries(ALL_LABELS.filter((label) => typeof parsed[label] === "string").map((label) => [label, parsed[label] as string]));
  } catch {
    throw new GoogleApiError("invalid_input", "El cursor de paginación no es válido.");
  }
}

function encodeCursor(next: Partial<Record<GmailAccountLabel, string>>): string | undefined {
  return Object.keys(next).length === 0 ? undefined : `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(next)).toString("base64url")}`;
}

function failureFor(unavailable: UnavailableAccount[]): GoogleApiError {
  const real = unavailable.find((entry) => entry.code !== "not_connected");
  if (real) return new GoogleApiError(real.code, real.message, { account: real.account, retryable: real.retryable });
  const only = unavailable.length === 1 ? unavailable[0] : undefined;
  return new GoogleApiError("not_connected", only?.message ?? "No hay cuentas de Gmail conectadas.", { account: only?.account });
}

/** Read-only Gmail access across the labeled accounts. Results always carry the account they came from. */
export class GmailService implements IntegrationStatusSource {
  constructor(
    private readonly accounts: GoogleAccountStore,
    private readonly client: GmailClient,
  ) {}

  async search(account: GmailAccountLabel | "all", query: string, maxResults: number, cursor?: string): Promise<GmailSearchOutcome> {
    const pageTokens = account === "all" ? decodeCursor(cursor) : { [account]: cursor };
    const labels = account === "all" ? ALL_LABELS.filter((label) => !cursor || label in pageTokens) : [account];
    const settled = await Promise.allSettled(labels.map((label) => this.searchAccount(label, query, maxResults, pageTokens[label])));

    const items: TaggedMessage[] = [];
    const unavailable: UnavailableAccount[] = [];
    const next: Partial<Record<GmailAccountLabel, string>> = {};
    settled.forEach((outcome, index) => {
      const label = labels[index] as GmailAccountLabel;
      if (outcome.status === "rejected") {
        const error = asApiError(outcome.reason);
        unavailable.push({ account: label, code: error.code, message: error.message, retryable: error.retryable });
        return;
      }
      items.push(...outcome.value.items);
      if (outcome.value.nextPageToken) next[label] = outcome.value.nextPageToken;
    });
    if (unavailable.length === labels.length) throw failureFor(unavailable);

    const nextCursor = account === "all" ? encodeCursor(next) : next[account];
    return { items, nextCursor, unavailable };
  }

  async getThread(label: GmailAccountLabel, threadId: string): Promise<GmailThreadOutcome> {
    const account = this.requireAccount(label);
    try {
      const messages = await this.client.getThread(label, threadId);
      const omittedOlder = Math.max(0, messages.length - MAX_THREAD_MESSAGES);
      return { account: label, accountEmail: account.email, messages: messages.slice(-MAX_THREAD_MESSAGES), omittedOlder };
    } catch (error) {
      throw asApiError(error);
    }
  }

  emailFor(label: GmailAccountLabel): string | undefined {
    return this.accounts.get(label)?.email;
  }

  async status(): Promise<IntegrationStatusItem[]> {
    return ALL_LABELS.map((label) => this.statusFor(label, this.accounts.get(label)));
  }

  private async searchAccount(label: GmailAccountLabel, query: string, maxResults: number, pageToken?: string) {
    const account = this.requireAccount(label);
    const page = await this.client.search(label, query, maxResults, pageToken);
    const items = page.messages.map((message) => ({ ...message, account: label, accountEmail: account.email }));
    return { items, nextPageToken: page.nextPageToken };
  }

  private requireAccount(label: GmailAccountLabel): GoogleAccount {
    const account = this.accounts.get(label);
    if (!account) throw new GoogleApiError("not_connected", `La cuenta ${labelName(label)} de Gmail no está conectada.`, { account: label });
    return account;
  }

  private statusFor(label: GmailAccountLabel, account: GoogleAccount | undefined): IntegrationStatusItem {
    const name = `Cuenta ${labelName(label)}`;
    if (!account) return { provider: "gmail", account: label, status: "disconnected", detail: `${name}: no conectada.` };
    switch (account.status) {
      case "connected":
        return { provider: "gmail", account: account.email, status: "connected", detail: `${name} conectada (solo lectura).` };
      case "expired":
        return { provider: "gmail", account: account.email, status: "needs_action", detail: `${name}: la autorización venció; hay que reconectarla.` };
      case "revoked":
        return { provider: "gmail", account: account.email, status: "disconnected", detail: `${name}: acceso revocado.` };
      default:
        return { provider: "gmail", account: account.email, status: "error", detail: `${name}: falló la autorización; hay que reconectarla.` };
    }
  }
}
