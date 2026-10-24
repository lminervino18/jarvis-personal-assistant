import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { MCP_SERVER_NAME } from "../tools/mcp-server.js";
import type { TurnSecurityState } from "../tools/types.js";

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * PreToolUse gate enforced by the backend for every tool call: only allowlisted tools,
 * only from the in-process server this host registered, and web results taint the turn.
 */
export function createToolPolicyHook(
  allowedTools: ReadonlySet<string>,
  security: TurnSecurityState,
  onDenied: (toolName: string) => void = () => {},
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const name = input.tool_name;
    if (!allowedTools.has(name)) {
      onDenied(name);
      return deny(`La herramienta ${name} no está permitida para este asistente.`);
    }
    if (name.startsWith(`mcp__${MCP_SERVER_NAME}__`) && input.mcp_server?.source && input.mcp_server.source !== "sdk") {
      onDenied(name);
      return deny("Servidor de herramientas no confiable.");
    }
    if (name === "WebSearch") {
      security.tainted = true;
      security.taintSources.add("web");
    }
    return {};
  };
}
