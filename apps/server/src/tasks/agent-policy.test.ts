import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideToolUse, type AgentToolPolicy } from "./agent-policy.js";
import { ClaudeAgentBackend, planUsage, type ClaudeAgentConfig } from "./claude-agent-backend.js";
import { loadRunnerConfig } from "./runner-config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policy(): AgentToolPolicy & { root: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-policy-"));
  roots.push(root);
  const task = join(root, "tasks", "t1");
  const other = join(root, "tasks", "t2", "work");
  for (const dir of [join(task, "work"), join(task, "request"), join(task, "context"), join(task, ".runner"), other]) mkdirSync(dir, { recursive: true });
  return {
    root,
    other,
    cwd: join(task, "work"),
    allowedTools: new Set(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"]),
    readRoots: [join(task, "work"), join(task, "request"), join(task, "context")],
    writeRoots: [join(task, "work")],
    forbiddenRoot: root,
    subagents: new Set(["explorer"]),
    isAllowedModel: (model) => model === "haiku" || model === "sonnet",
  };
}

describe("agent tool policy", () => {
  it("lets the executor read its request and write only in its work folder", () => {
    const p = policy();
    expect(decideToolUse(p, "Read", { file_path: "../request/request.md" }).allow).toBe(true);
    expect(decideToolUse(p, "Write", { file_path: "src/a.mjs" }).allow).toBe(true);
    expect(decideToolUse(p, "Write", { file_path: "../request/request.md" }).allow).toBe(false);
    expect(decideToolUse(p, "Edit", { file_path: "/etc/hosts" }).allow).toBe(false);
  });

  it("keeps runner files, other tasks and the work database out of reach", () => {
    const p = policy();
    expect(decideToolUse(p, "Read", { file_path: "../.runner/baseline" }).allow).toBe(false);
    expect(decideToolUse(p, "Read", { file_path: join(p.other, "secret.txt") }).allow).toBe(false);
    expect(decideToolUse(p, "Read", { file_path: join(p.root, "work.db") }).allow).toBe(false);
    expect(decideToolUse(p, "Glob", { pattern: "../../t2/**" }).allow).toBe(false);
    expect(decideToolUse(p, "Grep", { pattern: "x", path: "../../.." }).allow).toBe(false);
    expect(decideToolUse(p, "Read", { file_path: "/proc/self/environ" }).allow).toBe(false);
  });

  it("follows symlinks before deciding", () => {
    const p = policy();
    symlinkSync(p.other, join(p.cwd, "escape"));
    expect(decideToolUse(p, "Read", { file_path: "escape/secret.txt" }).allow).toBe(false);
    expect(decideToolUse(p, "Write", { file_path: "escape/x.txt" }).allow).toBe(false);
  });

  it("only delegates to declared subagents, on allowed models, in the foreground", () => {
    const p = policy();
    const call = { description: "buscar", prompt: "buscá", subagent_type: "explorer", run_in_background: false };
    expect(decideToolUse(p, "Agent", call).allow).toBe(true);
    expect(decideToolUse(p, "Agent", { ...call, model: "haiku" }).allow).toBe(true);
    expect(decideToolUse(p, "Agent", { ...call, model: "opus" }).allow).toBe(false);
    expect(decideToolUse(p, "Agent", { ...call, subagent_type: "general-purpose" }).allow).toBe(false);
    expect(decideToolUse(p, "Agent", { ...call, run_in_background: undefined }).allow).toBe(false);
    expect(decideToolUse(p, "Agent", { ...call, isolation: "remote" }).allow).toBe(false);
  });

  it("denies tools outside the role's list but always lets the agent return its report", () => {
    const p = policy();
    expect(decideToolUse(p, "WebFetch", { url: "https://example.com" }).allow).toBe(false);
    expect(decideToolUse({ ...p, allowedTools: new Set(["Read"]) }, "StructuredOutput", { goal: "x" }).allow).toBe(true);
  });
});

describe("agent model guard", () => {
  const base: ClaudeAgentConfig = {
    models: { planner: "claude-sonnet-5-5", executor: "claude-sonnet-5-5", reviewer: "claude-sonnet-5-5" },
    subagentModel: "claude-haiku-5-5",
    effort: { planner: "medium", executor: "medium", reviewer: "medium" },
    maxTurns: { planner: 10, executor: 10, reviewer: 10 },
    timeoutMs: 60_000,
    allowedFamilies: ["sonnet", "haiku"],
    allowedDomains: [],
    bash: true,
    sandboxRequired: true,
    weakerNestedSandbox: false,
  };

  it("refuses to start with Opus or Fable anywhere", () => {
    expect(() => new ClaudeAgentBackend(base)).not.toThrow();
    expect(() => new ClaudeAgentBackend({ ...base, subagentModel: "claude-opus-5-5" })).toThrow(/not allowed/);
    expect(() => new ClaudeAgentBackend({ ...base, models: { ...base.models, reviewer: "claude-fable-5-2" } })).toThrow(/not allowed/);
  });

  it("recognizes allowed model ids and aliases only", () => {
    const backend = new ClaudeAgentBackend(base);
    expect(["claude-sonnet-5-5", "claude-haiku-5-5", "sonnet", "haiku"].every((model) => backend.isAllowedModel(model))).toBe(true);
    expect(["claude-opus-5-5", "opus", "claude-fable-5-2"].some((model) => backend.isAllowedModel(model))).toBe(false);
  });

  it("reads plan usage from the documented fields and from the per-window detail the CLI sends", () => {
    const observed = {
      status: "allowed",
      resetsAt: 1795248600,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1795248600, status: "allowed" }, seven_day: { utilization: 0.22, resetsAt: 1795413600, status: "allowed" } },
    } as const;
    expect(planUsage(observed)).toEqual({ utilization: 0.22, resetsAt: 1795413600_000 });
    expect(planUsage({ status: "allowed_warning", surpassedThreshold: 0.75, resetsAt: 1795248600 })).toEqual({ utilization: 0.75, resetsAt: 1795248600_000 });
    expect(planUsage({ status: "allowed", resetsAt: 1795248600 })).toBeUndefined();
  });

  it("rejects Opus in the runner environment and requires a subscription token in production", () => {
    expect(() => loadRunnerConfig({ WORK_DIR: "/tmp/w", AGENT_MODEL_EXECUTOR: "claude-opus-5-5" })).toThrow();
    expect(() => loadRunnerConfig({ WORK_DIR: "/tmp/w", NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-test" })).toThrow(/AGENT_CLAUDE_CODE_OAUTH_TOKEN/);
    const config = loadRunnerConfig({ WORK_DIR: "/tmp/w", NODE_ENV: "production", AGENT_CLAUDE_CODE_OAUTH_TOKEN: "token-test" });
    expect(config.agent).toMatchObject({ sandboxRequired: true, configDir: "/tmp/w/claude", subagentModel: "claude-haiku-5-5", oauthToken: "token-test" });
    expect(config.agent.models).toEqual({ planner: "claude-sonnet-5-5", executor: "claude-sonnet-5-5", reviewer: "claude-sonnet-5-5" });
    expect(config.limits).toMatchObject({ concurrency: 1 });
    expect(config.limits).not.toHaveProperty("planMaxUtilization");
  });

  it("lets agent commands reach package registries and GitHub unless the network is set empty", () => {
    const open = loadRunnerConfig({ WORK_DIR: "/tmp/w" });
    expect(open.agent.allowedDomains).toEqual(expect.arrayContaining(["registry.npmjs.org", "pypi.org", "github.com", "*.githubusercontent.com"]));
    expect(loadRunnerConfig({ WORK_DIR: "/tmp/w", AGENT_ALLOWED_DOMAINS: "" }).agent.allowedDomains).toEqual([]);
  });
});
