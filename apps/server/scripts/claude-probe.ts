/**
 * Live verification of the Claude subscription route (Hito 0). It talks to the real
 * Claude service using the local login (or CLAUDE_CODE_OAUTH_TOKEN) and prints a JSON
 * report. It never runs in CI.
 *
 * Usage: pnpm --filter @jarvis/server exec tsx scripts/claude-probe.ts [reportPath]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RuntimeEvent, RuntimeTurnInput } from "@jarvis/contracts";
import { openMigratedDatabase } from "../src/db/database.js";
import { ClaudeAgentRuntime } from "../src/runtime/claude-runtime.js";
import { defaultAssistantDir, loadAssistantContext } from "../src/runtime/system-prompt.js";
import { allTools } from "../src/tools/index.js";
import { createTurnToolServer, qualifiedToolName } from "../src/tools/mcp-server.js";
import type { ToolContext, ToolServices } from "../src/tools/types.js";

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

let statusCalls = 0;
const services: ToolServices = {
  db: openMigratedDatabase(":memory:"),
  timezone,
  backupRetentionDays: 30,
  statusSources: [
    {
      async status() {
        statusCalls++;
        return [
          { provider: "gmail", account: "fixture-personal@example.com", status: "disconnected", detail: "fixture" },
          { provider: "push", status: "connected", detail: "fixture" },
        ];
      },
    },
  ],
};

const deniedTools: string[] = [];
const runtime = new ClaudeAgentRuntime({
  workspaceDir: resolve(tmpdir(), "jarvis-probe-workspace"),
  timezone,
  effort: "low",
  maxTurns: 6,
  allowOverage: false,
  systemPrompt: () => context.prompt,
  toolsetFor(input) {
    const security = { tainted: false, taintSources: new Set<string>() };
    const ctx: ToolContext = {
      services,
      conversationId: input.conversationId,
      turnId: input.turnId,
      now: () => new Date(),
      security,
      emitCard: () => {},
      emitPlayerCommand: () => {},
    };
    return {
      server: createTurnToolServer(ctx, allTools),
      allowedTools: [...allTools.map((tool) => qualifiedToolName(tool.name)), "WebSearch"],
      security,
    };
  },
  onDeniedTool: (name) => deniedTools.push(name),
});

interface TurnRecord {
  events: RuntimeEvent[];
  text: string;
  sessionId?: string;
  firstDeltaMs?: number;
  totalMs: number;
  deltaCount: number;
  error?: { code: string; message: string };
}

async function turn(text: string, resumeSessionId?: string, abortAfterDeltas?: number): Promise<TurnRecord> {
  const controller = new AbortController();
  const input: RuntimeTurnInput = {
    conversationId: randomUUID(),
    turnId: randomUUID(),
    text,
    replyMode: "text",
    resumeSessionId,
    signal: controller.signal,
  };
  const started = performance.now();
  const record: TurnRecord = { events: [], text: "", totalMs: 0, deltaCount: 0 };
  for await (const event of runtime.runTurn(input)) {
    record.events.push(event);
    if (event.type === "session") record.sessionId = event.sessionId;
    if (event.type === "text_delta") {
      record.deltaCount++;
      record.text += event.text;
      record.firstDeltaMs ??= Math.round(performance.now() - started);
      if (abortAfterDeltas && record.deltaCount >= abortAfterDeltas) controller.abort();
    }
    if (event.type === "result") record.sessionId = event.sessionId;
    if (event.type === "error") record.error = { code: event.code, message: event.message };
  }
  record.totalMs = Math.round(performance.now() - started);
  return record;
}

function summarize(record: TurnRecord) {
  const session = record.events.find((event) => event.type === "session");
  return {
    text: record.text.slice(0, 300),
    sessionId: record.sessionId,
    firstDeltaMs: record.firstDeltaMs,
    totalMs: record.totalMs,
    deltaCount: record.deltaCount,
    error: record.error,
    session: session?.type === "session" ? { model: session.model, tools: session.tools, mcpServers: session.mcpServers, authSource: session.authSource } : undefined,
    tools: record.events.filter((event) => event.type === "tool_start" || event.type === "tool_end"),
  };
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), contextFingerprint: context.fingerprint };

const first = await turn("Mi número de la suerte hoy es 47. Respondé solamente: anotado.");
report.authenticatedQuery = summarize(first);

const followUp = await turn("¿Cuál era mi número de la suerte? Respondé solo el número.", first.sessionId);
report.followUpWithContext = { ...summarize(followUp), pass: /\b47\b/.test(followUp.text) && followUp.sessionId === first.sessionId };

const streaming = await turn("Explicá en unas 120 palabras por qué el cielo es azul, sin usar herramientas.");
report.progressiveResponse = {
  ...summarize(streaming),
  pass: streaming.deltaCount > 5 && (streaming.firstDeltaMs ?? Infinity) < streaming.totalMs - 300,
};

const mcp = await turn("Usá la herramienta integrations_status y decime cuántas integraciones informa. Respondé solo el número.");
report.mcpTool = {
  ...summarize(mcp),
  handlerCalls: statusCalls,
  pass: statusCalls >= 1 && mcp.events.some((event) => event.type === "tool_start" && event.name === qualifiedToolName("integrations_status")),
};

const forbidden = await turn("Usá la herramienta Bash para ejecutar `ls /` y mostrame el resultado.");
report.forbiddenTool = {
  ...summarize(forbidden),
  deniedTools: [...deniedTools],
  pass: !forbidden.events.some((event) => event.type === "tool_start" && /bash/i.test(event.name)),
};

const fingerprint = await turn("¿Cuál es la huella de contexto?");
report.contextFingerprintCheck = { ...summarize(fingerprint), pass: fingerprint.text.includes(context.fingerprint) };

const cancelled = await turn("Contá del 1 al 200 en palabras, separadas por comas.", first.sessionId, 3);
const recovered = await turn("Respondé solamente: sigo acá.", first.sessionId);
report.cancellationAndRecovery = {
  cancelled: summarize(cancelled),
  recovered: summarize(recovered),
  pass: cancelled.error?.code === "cancelled" && !recovered.error && /sigo/i.test(recovered.text),
};

const badResume = await turn("Hola", randomUUID());
report.invalidResume = { ...summarize(badResume), pass: badResume.error?.code === "resume_failed" };

report.finishedAt = new Date().toISOString();
const reportPath = process.argv[2] ?? resolve(tmpdir(), "jarvis-claude-probe.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
const passes = Object.fromEntries(
  Object.entries(report)
    .filter(([, value]) => value && typeof value === "object" && "pass" in (value as object))
    .map(([key, value]) => [key, (value as { pass: boolean }).pass]),
);
console.log(JSON.stringify({ reportPath, passes }, null, 2));
process.exit(0);
