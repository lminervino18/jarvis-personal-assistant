import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMigratedDatabase, workMigrations } from "./db/database.js";
import { createLogger } from "./logger.js";
import { BuildChatStore } from "./build-chat/build-chat-store.js";
import { BuildSession } from "./build-chat/build-session.js";
import { agentEnvironment, ClaudeAgentBackend } from "./tasks/claude-agent-backend.js";
import { loadRunnerConfig } from "./tasks/runner-config.js";
import { TaskRunner } from "./tasks/task-runner.js";
import { TaskStore } from "./tasks/task-store.js";
import { WorkLayout } from "./tasks/workspace.js";

const config = loadRunnerConfig();
const logger = createLogger(config.logLevel);

if (config.agent.bash && config.agent.sandboxRequired) {
  const proc = config.agent.weakerNestedSandbox ? ["--bind", "/proc", "/proc"] : ["--proc", "/proc"];
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", ...proc, "--unshare-user", "--unshare-net", "--die-with-parent", "true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    logger.fatal(
      { detail: `${probe.stderr ?? ""}${probe.error?.message ?? ""}`.trim().slice(0, 300) },
      "the Bash sandbox cannot start on this host; fix user namespaces (docs/agents.md) or set AGENT_BASH=false",
    );
    process.exit(1);
  }
}
const db = openMigratedDatabase(join(config.workDir, "work.db"), workMigrations);
const backend = new ClaudeAgentBackend({
  ...config.agent,
  onDenied: (role, tool, reason) => logger.warn({ role, tool, reason }, "agent tool denied"),
});
const taskStore = new TaskStore(db);
const layout = new WorkLayout(config.workDir);
const runner = new TaskRunner({ store: taskStore, layout, backend, limits: config.limits, log: logger, timezone: config.timezone });
const build = new BuildSession({
  store: new BuildChatStore(db),
  tasks: taskStore,
  layout,
  workspace: join(config.workDir, "build", "repo"),
  projectDir: join(layout.projectsDir, "jarvis"),
  model: config.agent.models.executor,
  reviewerModel: config.agent.models.reviewer,
  env: { ...agentEnvironment(config.agent), CI: "true" },
  log: logger,
  timezone: config.timezone,
});

const heartbeatFile = process.env.AGENT_HEARTBEAT_FILE ?? "/tmp/agent-runner-heartbeat";
const heartbeat = setInterval(() => writeFileSync(heartbeatFile, String(Date.now())), config.limits.pollMs);
writeFileSync(heartbeatFile, String(Date.now()));

const shutdown = async (signal: string) => {
  logger.info({ signal }, "agent runner shutting down");
  clearInterval(heartbeat);
  await Promise.all([runner.stop(), build.stop()]);
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info(
  {
    concurrency: config.limits.concurrency,
    models: config.agent.models,
    subagentModel: config.agent.subagentModel,
    auth: config.agent.oauthToken ? "subscription_token" : "local_login",
    sandboxRequired: config.agent.sandboxRequired,
  },
  "agent runner started",
);
runner.start();
build.start();
