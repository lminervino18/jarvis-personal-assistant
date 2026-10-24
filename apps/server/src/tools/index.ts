import type { ToolName } from "@jarvis/contracts";
import { integrationsStatus } from "./integrations-tools.js";
import { memoryTools } from "./memory-tools.js";
import type { AnyToolDefinition } from "./types.js";

/** Every tool the assistant can use. A tool absent from this list cannot be called. */
export const allTools: readonly AnyToolDefinition[] = [...memoryTools, integrationsStatus];

export const toolsByName: ReadonlyMap<ToolName, AnyToolDefinition> = new Map(allTools.map((tool) => [tool.name, tool]));
