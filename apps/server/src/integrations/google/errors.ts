import type { GmailAccountLabel, ToolErrorCode } from "@jarvis/contracts";

export type GoogleApiErrorCode = Extract<
  ToolErrorCode,
  "not_connected" | "invalid_input" | "auth_expired" | "revoked" | "rate_limited" | "not_found" | "upstream_error"
>;

interface GoogleApiErrorOptions {
  retryable?: boolean;
  account?: GmailAccountLabel;
}

/** A Google-side failure already mapped to the tool error vocabulary. Messages are safe to show. */
export class GoogleApiError extends Error {
  readonly retryable: boolean;
  readonly account?: GmailAccountLabel;

  constructor(
    readonly code: GoogleApiErrorCode,
    message: string,
    options: GoogleApiErrorOptions = {},
  ) {
    super(message);
    this.retryable = options.retryable ?? false;
    this.account = options.account;
  }
}
