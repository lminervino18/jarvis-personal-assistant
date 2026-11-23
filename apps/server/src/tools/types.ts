import type { FileAnalysis, FileToAnalyze } from "../files/file-analysis.js";
import type { FileLinks } from "../files/file-links.js";
import type { WhatsAppFiles } from "../files/whatsapp-files.js";
import type { AttachmentStore } from "../attachments/attachment-store.js";
import type { PageService } from "../pages/page-service.js";
import type { Card, IntegrationProvider, ToolInput, ToolName, ToolResult } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import type { GmailService } from "../integrations/gmail/gmail-service.js";
import type { YoutubeService } from "../integrations/youtube/youtube-service.js";
import type { TaskService } from "../tasks/task-service.js";
import type { VideoStore } from "../videos/video-store.js";
import type { ChatStudies } from "../integrations/whatsapp/chat-study.js";

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
  /** A card shown only to the owner's client (e.g. a pairing QR); never returned to the model. */
  pairingCard?(): Card | undefined;
}

/** Long-lived services shared by every turn. Integration modules add their clients here. */
export interface ToolServices {
  db: Db;
  timezone: string;
  backupRetentionDays: number;
  statusSources: IntegrationStatusSource[];
  gmail?: GmailService;
  youtube?: YoutubeService;
  tasks?: TaskService;
  pages?: PageService;
  attachments?: AttachmentStore;
  whatsappFiles?: WhatsAppFiles;
  fileLinks?: FileLinks;
  /** Origin of public file links (the pages host). */
  filesBaseUrl?: string;
  /** Reads any file for the model: images, transcripts, text of documents and sheets. */
  analyzeFile?: (file: FileToAnalyze) => Promise<FileAnalysis>;
  videos?: VideoStore;
  chatStudies?: ChatStudies;
  /** The name the videos' spoken intro uses («el asistente personal de …»). */
  ownerName?: string;
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
  /** Updates a card already shown, wherever it is in the thread. */
  updateCard?(card: Card): void;
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
  /**
   * Checks a call before it runs or waits for confirmation: refuses it (for example an unknown
   * recipient) or returns the input to use, so a card holds exactly what will run.
   */
  prepare?(ctx: ToolContext, input: ToolInput<N>): PreparedInput<ToolInput<N>>;
  /** True when a new call replaces a still pending confirmation of the same tool (for example, a corrected message to the same chat). */
  replaces?(pending: ToolInput<N>, next: ToolInput<N>): boolean;
}

export type PreparedInput<I> = { input: I } | { refused: ToolResult<unknown> };

export type AnyToolDefinition = { [N in ToolName]: ToolDefinition<N> }[ToolName];

export function defineTool<N extends ToolName>(definition: ToolDefinition<N>): ToolDefinition<N> {
  return definition;
}
