import type { ToolName } from "@jarvis/contracts";
import { agreementsTools } from "./agreements-tools.js";
import { calendarTools } from "./calendar-tools.js";
import { contactsTools } from "./contacts-tools.js";
import { integrationsStatus } from "./integrations-tools.js";
import { memoryTools } from "./memory-tools.js";
import type { AnyToolDefinition } from "./types.js";

/** Every tool the assistant can use. A tool absent from this list cannot be called. */
export const allTools: readonly AnyToolDefinition[] = [
  ...memoryTools,
  ...contactsTools,
  ...calendarTools,
  ...agreementsTools,
  integrationsStatus,
];

export const toolsByName: ReadonlyMap<ToolName, AnyToolDefinition> = new Map(allTools.map((tool) => [tool.name, tool]));
