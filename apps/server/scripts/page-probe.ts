/**
 * Writes one sample page with the real model and the production design guide, for a visual
 * check before shipping changes to the guide: `pnpm exec tsx scripts/page-probe.ts <out.html>`.
 * Uses the local Claude login (or CLAUDE_CODE_OAUTH_TOKEN). Costs one page generation.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_SYSTEM_PROMPT } from "../src/pages/design-guide.js";
import { extractHtml, pageProblems } from "../src/pages/page-html.js";
import { ClaudeAgentRuntime } from "../src/runtime/claude-runtime.js";

const out = process.argv[2] ?? join(tmpdir(), "page-probe.html");
const runtime = new ClaudeAgentRuntime({
  workspaceDir: join(tmpdir(), "jarvis-page-probe"),
  timezone: "America/Argentina/Buenos_Aires",
  model: "claude-sonnet-5-5",
  maxTurns: 1,
  allowOverage: false,
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  systemPrompt: () => "",
  toolsetFor: () => {
    throw new Error("no tools in the page probe");
  },
});

const brief =
  "Invitación a una cena en casa el viernes 28 de noviembre a las 21:30 en Palermo. Hago pastas caseras. Preguntá si viene, si trae algo (vino, postre o nada) y si tiene alguna restricción alimentaria. Tono cálido y corto.";
const started = Date.now();
const reply = await runtime.complete(
  { system: PAGE_SYSTEM_PROMPT, prompt: `Título: Cena del viernes\n\nPedido del dueño:\n${brief}`, model: "claude-sonnet-5-5", effort: "medium" },
  AbortSignal.timeout(5 * 60_000),
);
const html = extractHtml(reply);
if (!html) throw new Error("no html in the reply");
writeFileSync(out, html);
process.stdout.write(`${JSON.stringify({ out, seconds: Math.round((Date.now() - started) / 1000), bytes: html.length, problems: pageProblems(html) })}\n`);
