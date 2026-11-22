import { spawn } from "node:child_process";
import { z } from "zod";
import { Publisher, type Exec } from "./publisher/publisher.js";

const MAX_OUTPUT_CHARS = 64 * 1024;

const Env = z.object({
  PUBLISH_DIR: z.string().min(1),
  PUBLISH_SIGNING_KEY: z.string().min(32),
  PUBLISH_FETCH_URL: z.string().min(1),
  PUBLISH_PUSH_URL: z.string().min(1),
  PUBLISH_SSH_KEY: z.string().min(1),
  PUBLISH_KNOWN_HOSTS: z.string().min(1),
  PUBLISH_AUTHOR_NAME: z.string().min(1),
  PUBLISH_AUTHOR_EMAIL: z.string().min(3),
  JARVIS_DIR: z.string().min(1).default("/opt/jarvis"),
  PUBLISH_CHECK_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
  PUBLISH_DEPLOY_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(45),
});

const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });

const log = {
  info: (data: object, message: string) => void process.stdout.write(`${JSON.stringify({ level: "info", message, ...data })}\n`),
  warn: (data: object, message: string) => console.warn(JSON.stringify({ level: "warn", message, ...data })),
};

const env = Env.parse(process.env);
const publisher = new Publisher(
  {
    dir: env.PUBLISH_DIR,
    signingKey: env.PUBLISH_SIGNING_KEY,
    fetchUrl: env.PUBLISH_FETCH_URL,
    pushUrl: env.PUBLISH_PUSH_URL,
    sshKey: env.PUBLISH_SSH_KEY,
    knownHosts: env.PUBLISH_KNOWN_HOSTS,
    authorName: env.PUBLISH_AUTHOR_NAME,
    authorEmail: env.PUBLISH_AUTHOR_EMAIL,
    jarvisDir: env.JARVIS_DIR,
    checkTimeoutMs: env.PUBLISH_CHECK_TIMEOUT_MINUTES * 60_000,
    deployTimeoutMs: env.PUBLISH_DEPLOY_TIMEOUT_MINUTES * 60_000,
  },
  exec,
  log,
);
await publisher.runPending();
