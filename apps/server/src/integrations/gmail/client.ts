import type { GmailAccountLabel } from "@jarvis/contracts";
import type { GoogleAccessTokens } from "../google/access-tokens.js";
import { GoogleApiError } from "../google/errors.js";
import {
  RawListSchema,
  RawMessageSchema,
  RawThreadSchema,
  toMessage,
  toSummary,
  type GmailMessage,
  type GmailMessageSummary,
} from "./parse.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const REQUEST_TIMEOUT_MS = 20_000;
const METADATA_HEADERS = ["From", "To", "Subject", "Date"];
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]);

export interface GmailSearchPage {
  messages: GmailMessageSummary[];
  nextPageToken?: string;
}

/** Read-only Gmail REST client: it only issues GET requests to messages.list/get and threads.get. */
export class GmailClient {
  constructor(
    private readonly tokens: GoogleAccessTokens,
    private readonly timezone: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async search(label: GmailAccountLabel, query: string, maxResults: number, pageToken?: string): Promise<GmailSearchPage> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (pageToken) params.set("pageToken", pageToken);
    const list = RawListSchema.parse(await this.get(label, "/messages", params));
    const found = await Promise.all((list.messages ?? []).map((message) => this.summary(label, message.id)));
    return { messages: found.filter((message): message is GmailMessageSummary => message !== undefined), nextPageToken: list.nextPageToken };
  }

  async getThread(label: GmailAccountLabel, threadId: string): Promise<GmailMessage[]> {
    const thread = RawThreadSchema.parse(await this.get(label, `/threads/${encodeURIComponent(threadId)}`, new URLSearchParams({ format: "full" })));
    return (thread.messages ?? []).map((message) => toMessage(message, this.timezone));
  }

  private async summary(label: GmailAccountLabel, messageId: string): Promise<GmailMessageSummary | undefined> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of METADATA_HEADERS) params.append("metadataHeaders", name);
    try {
      return toSummary(RawMessageSchema.parse(await this.get(label, `/messages/${encodeURIComponent(messageId)}`, params)), this.timezone);
    } catch (error) {
      if (error instanceof GoogleApiError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  private async get(label: GmailAccountLabel, path: string, params: URLSearchParams): Promise<unknown> {
    const url = `${BASE_URL}${path}?${params.toString()}`;
    let response = await this.send(url, await this.tokens.get(label));
    if (response.status === 401) {
      this.tokens.invalidate(label);
      response = await this.send(url, await this.tokens.get(label));
    }
    if (!response.ok) throw await this.failure(label, response);
    return response.json();
  }

  private async send(url: string, accessToken: string): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleApiError("upstream_error", "No se pudo contactar a Gmail.", { retryable: true });
    }
  }

  private async failure(label: GmailAccountLabel, response: Response): Promise<GoogleApiError> {
    if (response.status === 404) return new GoogleApiError("not_found", "Gmail no encontró ese mensaje o hilo.");
    if (response.status === 429) return new GoogleApiError("rate_limited", "Gmail limitó las consultas; reintentá en un momento.", { retryable: true });
    if (response.status === 401) return new GoogleApiError("auth_expired", `Gmail rechazó el acceso de la cuenta ${label}; hay que reconectarla.`, { account: label });
    if (response.status === 403) {
      const body = (await response.json().catch(() => undefined)) as { error?: { errors?: { reason?: string }[] } } | undefined;
      const reason = body?.error?.errors?.[0]?.reason ?? "";
      return RATE_LIMIT_REASONS.has(reason)
        ? new GoogleApiError("rate_limited", "Gmail limitó las consultas; reintentá en un momento.", { retryable: true })
        : new GoogleApiError("auth_expired", `La cuenta ${label} no tiene permiso de lectura en Gmail; hay que reconectarla.`, { account: label });
    }
    return new GoogleApiError("upstream_error", "Gmail devolvió un error.", { retryable: response.status >= 500 });
  }
}
