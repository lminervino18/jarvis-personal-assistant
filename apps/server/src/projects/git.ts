import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT_MS = 5 * 60_000;

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOptions {
  /** GitHub token for HTTPS clone and push; sent as a header from the environment, never written to `.git/config`. */
  token?: string;
  identity?: GitIdentity;
}

/** Thrown when git fails; the message is git's own error output, which never includes the token. */
export class GitError extends Error {}

function environment(options: GitOptions): NodeJS.ProcessEnv {
  const settings: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["credential.helper", ""],
    ...(options.token
      ? ([["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${Buffer.from(`${options.token}:x-oauth-basic`).toString("base64")}`]] as [string, string][])
      : []),
  ];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (options.identity) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = options.identity.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = options.identity.email;
  }
  return env;
}

/** Runs git in `cwd` with hooks and user configuration disabled. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, env: environment(options), timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new GitError(stderr ? stderr.split("\n").slice(-3).join(" ") : `git ${args[0]} failed`);
  }
}

export const githubRemote = (repo: string) => `https://github.com/${repo}.git`;
