import type { Card, IntegrationProvider, ToolInput, ToolName, ToolResult } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import type { GmailService } from "../integrations/gmail/gmail-service.js";

/** Per-turn security state. Once tainted, state-changing tools need owner confirmation. */
export interface TurnSecurityState {
  tainted: boolean;
  taintSources: Set<string>;
}

export interface IntegrationStatusItem {
  provider: IntegrationProvider;
  account?: string;
  status: "connected" | "disconnected" | "needs_action" | "error" | "disabled";
  detail: string;
  coverage?: { from?: string; to?: string };
}

export interface IntegrationStatusSource {
  status(): Promise<IntegrationStatusItem[]>;
}

/** Long-lived services shared by every turn. Integration modules add their clients here. */
export interface ToolServices {
  db: Db;
  timezone: string;
  backupRetentionDays: number;
  statusSources: IntegrationStatusSource[];
  gmail?: GmailService;
}

export interface PlayerCommand {
  requestId: string;
  action: "open" | "play" | "pause";
  videoId?: string;
}

export interface ToolContext {
  services: ToolServices;
  conversationId: string;
  turnId: string;
  now(): Date;
  security: TurnSecurityState;
  emitCard(card: Card): void;
  emitPlayerCommand(command: PlayerCommand): void;
}

export interface ConfirmationSummary {
  title: string;
  summary: string;
  details: { label: string; value: string }[];
}

export interface ToolDefinition<N extends ToolName> {
  name: N;
  description: string;
  execute(ctx: ToolContext, input: ToolInput<N>): Promise<ToolResult<unknown>>;
  /** How a state-changing call is shown in a confirmation card. */
  describe?(ctx: ToolContext, input: ToolInput<N>): ConfirmationSummary;
}

export type AnyToolDefinition = { [N in ToolName]: ToolDefinition<N> }[ToolName];

export function defineTool<N extends ToolName>(definition: ToolDefinition<N>): ToolDefinition<N> {
  return definition;
}
