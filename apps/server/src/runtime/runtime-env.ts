const INHERITED_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

export interface RuntimeEnvOptions {
  timezone: string;
  configDir?: string;
  oauthToken?: string;
}

/**
 * Builds the complete environment for the Claude Code subprocess. It is an allowlist:
 * server secrets, API keys and the parent Claude Code session variables never reach it,
 * so the runtime can only authenticate through the owner's subscription login.
 */
export function buildRuntimeEnv(base: NodeJS.ProcessEnv, options: RuntimeEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = base[key];
    if (value) env[key] = value;
  }
  env.TZ = options.timezone;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "jarvis-personal-assistant/0.1.0";
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
  return env;
}
