import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export interface AgentToolPolicy {
  cwd: string;
  allowedTools: ReadonlySet<string>;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  forbiddenRoot: string;
  subagents: ReadonlySet<string>;
  isAllowedModel(model: string): boolean;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

const FILE_READERS: Record<string, string[]> = { Read: ["file_path"], Glob: ["path", "pattern"], Grep: ["path", "glob"] };
const FILE_WRITERS: Record<string, string[]> = { Write: ["file_path"], Edit: ["file_path"], NotebookEdit: ["notebook_path"] };
const ALWAYS_FORBIDDEN = ["/proc", "/sys", "/dev"];

/** The channel the SDK uses to return the structured report. It has no effect outside the session. */
export const OUTPUT_TOOL = "StructuredOutput";

function realish(path: string): string {
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  return resolve(real, relative(probe, path));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(realish(root), target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The literal directory part of a path or glob, resolved against the agent's working directory. */
function targetOf(cwd: string, value: string): string {
  const literal = value.split(/[*?[{]/)[0] ?? "";
  return realish(resolve(cwd, literal || "."));
}

function canRead(policy: AgentToolPolicy, target: string): boolean {
  if (ALWAYS_FORBIDDEN.some((root) => isInside(root, target))) return false;
  if (policy.readRoots.some((root) => isInside(root, target))) return true;
  return !isInside(policy.forbiddenRoot, target);
}

function canWrite(policy: AgentToolPolicy, target: string): boolean {
  return policy.writeRoots.some((root) => isInside(root, target));
}

function checkSubagent(policy: AgentToolPolicy, input: Record<string, unknown>): PolicyDecision {
  const type = typeof input.subagent_type === "string" ? input.subagent_type : "";
  if (!policy.subagents.has(type)) return { allow: false, reason: `Solo podés delegar en: ${[...policy.subagents].join(", ")}.` };
  if (typeof input.model === "string" && !policy.isAllowedModel(input.model)) {
    return { allow: false, reason: `El modelo ${input.model} no está permitido para subagentes.` };
  }
  if (input.isolation !== undefined) return { allow: false, reason: "No se permite aislamiento remoto ni worktrees." };
  if (input.run_in_background !== false) return { allow: false, reason: "Usá run_in_background: false; la tarea espera el resultado." };
  return { allow: true };
}

/**
 * Decides one tool call. File tools are confined to the task's folders (the Bash sandbox
 * does not cover them), and delegation is limited to declared subagents on allowed models.
 */
export function decideToolUse(policy: AgentToolPolicy, toolName: string, rawInput: unknown): PolicyDecision {
  if (toolName === OUTPUT_TOOL) return { allow: true };
  if (!policy.allowedTools.has(toolName)) return { allow: false, reason: `La herramienta ${toolName} no está habilitada para este rol.` };
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  if (toolName === "Agent") return checkSubagent(policy, input);
  for (const field of FILE_WRITERS[toolName] ?? []) {
    const value = input[field];
    if (typeof value === "string" && !canWrite(policy, targetOf(policy.cwd, value))) {
      return { allow: false, reason: "Solo podés escribir dentro de la carpeta de trabajo de esta tarea." };
    }
  }
  for (const field of FILE_READERS[toolName] ?? []) {
    const value = input[field];
    if (typeof value === "string" && !canRead(policy, targetOf(policy.cwd, value))) {
      return { allow: false, reason: "Esa ruta está fuera de lo que esta tarea puede leer." };
    }
  }
  return { allow: true };
}

export function createAgentPolicyHook(policy: AgentToolPolicy, onDenied: (tool: string, reason: string) => void = () => {}): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const decision = decideToolUse(policy, input.tool_name, input.tool_input);
    if (decision.allow) return {};
    onDenied(input.tool_name, decision.reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
