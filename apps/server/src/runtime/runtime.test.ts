import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { composeTurnPrompt } from "./claude-runtime.js";
import { buildRuntimeEnv } from "./runtime-env.js";
import { createMapperState, mapSdkMessage } from "./sdk-events.js";
import { createToolPolicyHook } from "./tool-policy.js";

const sdk = (message: unknown) => message as SDKMessage;

describe("mapSdkMessage", () => {
  it("emits text only from the main thread and tracks tool names", () => {
    const state = createMapperState(false);
    const delta = (text: string, parent: string | null) =>
      sdk({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });

    expect(mapSdkMessage(delta("Hola", null), state)).toEqual([{ type: "text_delta", text: "Hola" }]);
    expect(mapSdkMessage(delta("subagente", "tool-1"), state)).toEqual([]);

    const start = sdk({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "mcp__jarvis__memory_search", input: {} } },
    });
    expect(mapSdkMessage(start, state)).toEqual([{ type: "tool_start", toolUseId: "t1", name: "mcp__jarvis__memory_search" }]);

    const result = sdk({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}", is_error: false }] },
    });
    expect(mapSdkMessage(result, state)).toEqual([
      { type: "tool_end", toolUseId: "t1", name: "mcp__jarvis__memory_search", isError: false },
    ]);
  });

  it("maps quota rejection and refuses silent paid overage", () => {
    const now = 1_000_000;
    const rejected = sdk({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1060 } });
    expect(mapSdkMessage(rejected, createMapperState(false, () => now))).toEqual([
      { type: "error", code: "quota_exceeded", message: "Subscription usage limit reached", retryAfterMs: 60_000 },
    ]);

    const overage = sdk({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
    expect(mapSdkMessage(overage, createMapperState(false))[0]).toMatchObject({ type: "error", code: "quota_exceeded" });
    expect(mapSdkMessage(overage, createMapperState(true))).toEqual([]);
  });

  it("classifies a missing session as a resume failure", () => {
    const message = sdk({
      type: "result",
      subtype: "error_during_execution",
      session_id: "s1",
      errors: ["No conversation found with session ID: abc"],
    });
    expect(mapSdkMessage(message, createMapperState(false))[0]).toMatchObject({ type: "error", code: "resume_failed" });
  });

  it("maps authentication failures reported on assistant messages", () => {
    const message = sdk({ type: "assistant", error: "authentication_failed", session_id: "s1", message: { content: [] } });
    expect(mapSdkMessage(message, createMapperState(false))[0]).toMatchObject({ code: "auth_failed" });
  });
});

describe("buildRuntimeEnv", () => {
  it("forwards only allowlisted variables and never API keys or server secrets", () => {
    const env = buildRuntimeEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/jarvis",
        ANTHROPIC_API_KEY: "sk-should-not-pass",
        ANTHROPIC_AUTH_TOKEN: "nope",
        TOKEN_ENCRYPTION_KEY: "secret",
        CLAUDECODE: "1",
        GOOGLE_CLIENT_SECRET: "secret",
      },
      { timezone: "America/Argentina/Buenos_Aires", oauthToken: "oauth-token" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.TZ).toBe("America/Argentina/Buenos_Aires");
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "TOKEN_ENCRYPTION_KEY", "CLAUDECODE", "GOOGLE_CLIENT_SECRET"]) {
      expect(env).not.toHaveProperty(key);
    }
  });
});

describe("tool policy hook", () => {
  const signal = new AbortController().signal;
  const call = (tool_name: string, mcp_server?: { name: string; source: string }) =>
    ({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "x", mcp_server }) as never;

  it("denies tools outside the allowlist and taints on web search", async () => {
    const security = { tainted: false, taintSources: new Set<string>() };
    const denied: string[] = [];
    const hook = createToolPolicyHook(new Set(["mcp__jarvis__memory_search", "WebSearch"]), security, (n) => denied.push(n));

    const bash = await hook(call("Bash"), "x", { signal });
    expect(bash).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(denied).toEqual(["Bash"]);

    expect(await hook(call("mcp__jarvis__memory_search", { name: "jarvis", source: "sdk" }), "x", { signal })).toEqual({});
    const spoofed = await hook(call("mcp__jarvis__memory_search", { name: "jarvis", source: "project" }), "x", { signal });
    expect(spoofed).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

    expect(security.tainted).toBe(false);
    await hook(call("WebSearch"), "x", { signal });
    expect(security.tainted).toBe(true);
  });
});

describe("composeTurnPrompt", () => {
  it("prefixes the local date and channel so relative dates resolve in the owner's zone", () => {
    const prompt = composeTurnPrompt(
      { conversationId: "c", turnId: "t", text: "¿Qué tengo mañana?", replyMode: "voice", signal: new AbortController().signal },
      new Date("2026-10-24T02:30:00Z"),
      "America/Argentina/Buenos_Aires",
    );
    expect(prompt).toMatch(/^\[contexto: viernes 23 de octubre de 2026, 23:30 .*canal: voz\]/);
    expect(prompt.endsWith("¿Qué tengo mañana?")).toBe(true);
  });
});
