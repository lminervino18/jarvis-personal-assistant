import { fileTools } from "./file-tools.js";
import type { ToolName } from "@jarvis/contracts";
import { agreementsTools } from "./agreements-tools.js";
import { calendarTools } from "./calendar-tools.js";
import { contactsTools } from "./contacts-tools.js";
import { displayTools } from "./display-tools.js";
import { gmailTools } from "./gmail-tools.js";
import { integrationsStatus } from "./integrations-tools.js";
import { memoryTools } from "./memory-tools.js";
import { pageTools } from "./page-tools.js";
import { remindersTools } from "./reminders-tools.js";
import { taskTools } from "./task-tools.js";
import { videoTools } from "./video-tools.js";
import { whatsappTools } from "./whatsapp-tools.js";
import { youtubeTools } from "./youtube-tools.js";
import type { AnyToolDefinition } from "./types.js";

/** Every tool the assistant can use. A tool absent from this list cannot be called. */
export const allTools: readonly AnyToolDefinition[] = [
  ...memoryTools,
  ...contactsTools,
  ...calendarTools,
  ...agreementsTools,
  ...remindersTools,
  ...gmailTools,
  ...youtubeTools,
  ...whatsappTools,
  integrationsStatus,
  ...taskTools,
  ...displayTools,
  ...pageTools,
  ...fileTools,
  ...videoTools,
];

export const toolsByName: ReadonlyMap<ToolName, AnyToolDefinition> = new Map(allTools.map((tool) => [tool.name, tool]));
