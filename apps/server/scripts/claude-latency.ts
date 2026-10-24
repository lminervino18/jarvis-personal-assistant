/**
 * Measures Claude runtime latency against the real service (owner login or
 * CLAUDE_CODE_OAUTH_TOKEN): time to first text and total, for new sessions, resumed
 * sessions and a tool turn. Never runs in CI.
 *
 * Usage: pnpm --filter @jarvis/server exec tsx scripts/claude-latency.ts [samples] [effort]
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openMigratedDatabase } from "../src/db/database.js";
import { ClaudeAgentRuntime, type Effort } from "../src/runtime/claude-runtime.js";
import { defaultAssistantDir, loadAssistantContext } from "../src/runtime/system-prompt.js";
import { allTools } from "../src/tools/index.js";
import { createTurnToolServer, qualifiedToolName } from "../src/tools/mcp-server.js";

const samples = Number(process.argv[2] ?? 5);
const effort = (process.argv[3] ?? "low") as Effort;
const timezone = "America/Argentina/Buenos_Aires";
const assistantDir = defaultAssistantDir();
const context = loadAssistantContext({
  instructionsPath: resolve(assistantDir, "CLAUDE.md"),
  privateProfilePath: "/nonexistent/loren.md",
  exampleProfilePath: resolve(assistantDir, "loren.example.md"),
  allowExampleProfile: true,
  ownerDisplayName: "Alex",
  timezone,
});
const services = { db: openMigratedDatabase(":memory:"), timezone, backupRetentionDays: 30, statusSources: [] };

const runtime = new ClaudeAgentRuntime({
  workspaceDir: resolve(tmpdir(), "jarvis-latency-workspace"),
  timezone,
  effort,
  maxTurns: 4,
  allowOverage: false,
  systemPrompt: () => context.prompt,
  toolsetFor(input) {
    const security = { tainted: false, taintSources: new Set<string>() };
    const ctx = { services, conversationId: input.conversationId, turnId: input.turnId, now: () => new Date(), security, emitCard: () => {}, emitPlayerCommand: () => {} };
    return { server: createTurnToolServer(ctx, allTools), allowedTools: allTools.map((tool) => qualifiedToolName(tool.name)), security };
  },
});

async function measure(text: string, resumeSessionId?: string) {
  const started = performance.now();
  let firstText: number | undefined;
  let sessionId: string | undefined;
  let error: string | undefined;
  for await (const event of runtime.runTurn({
    conversationId: randomUUID(),
    turnId: randomUUID(),
    text,
    replyMode: "voice",
    resumeSessionId,
    signal: new AbortController().signal,
  })) {
    if (event.type === "text_delta") firstText ??= performance.now() - started;
    if (event.type === "result") sessionId = event.sessionId;
    if (event.type === "error") error = event.code;
  }
  return { firstText, total: performance.now() - started, sessionId, error };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN);
}

const results: Record<string, { firstText: number[]; total: number[]; errors: number }> = {
  new_session_simple: { firstText: [], total: [], errors: 0 },
  resumed_simple: { firstText: [], total: [], errors: 0 },
  resumed_with_tool: { firstText: [], total: [], errors: 0 },
};
const record = (key: string, sample: Awaited<ReturnType<typeof measure>>) => {
  const bucket = results[key] as (typeof results)[string];
  if (sample.error || sample.firstText === undefined) bucket.errors++;
  else {
    bucket.firstText.push(sample.firstText);
    bucket.total.push(sample.total);
  }
};

for (let i = 0; i < samples; i++) {
  const fresh = await measure("Decime una frase corta de saludo.");
  record("new_session_simple", fresh);
  record("resumed_simple", await measure("Ahora otra distinta, también corta.", fresh.sessionId));
  record("resumed_with_tool", await measure("Buscá en mis memorias si hay algo sobre café y respondé en una frase.", fresh.sessionId));
}

const summary = Object.fromEntries(
  Object.entries(results).map(([key, value]) => [
    key,
    {
      samples: value.total.length,
      errors: value.errors,
      firstTextP50: percentile(value.firstText, 50),
      firstTextP95: percentile(value.firstText, 95),
      totalP50: percentile(value.total, 50),
      totalP95: percentile(value.total, 95),
    },
  ]),
);
console.log(JSON.stringify({ effort, measuredAt: new Date().toISOString(), summary }, null, 2));
process.exit(0);
