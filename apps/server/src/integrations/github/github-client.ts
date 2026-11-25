import { z } from "zod";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
/** Create, read and push to the owner's repositories, public and private. */
const SCOPE = "repo";
const REQUEST_TIMEOUT_MS = 20_000;

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GitHubFailure = "rejected" | "not_found" | "conflict" | "unauthorized" | "unavailable";

/** A failed GitHub call. The message never carries tokens or response bodies. */
export class GitHubError extends Error {
  constructor(
    readonly reason: GitHubFailure,
    readonly status?: number,
  ) {
    super(`github ${reason}${status ? ` (${status})` : ""}`);
  }
}

const TokenResponse = z.object({ access_token: z.string().min(1), scope: z.string().default("") });
const User = z.object({ login: z.string().min(1), id: z.number().int().positive() });
const Repo = z.object({
  full_name: z.string(),
  html_url: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
});
const Pull = z.object({ html_url: z.string(), number: z.number() });

export type GitHubRepo = z.infer<typeof Repo>;

function failure(status: number): GitHubFailure {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409 || status === 422) return "conflict";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/** GitHub's OAuth web flow (with PKCE) and the few REST calls JARVIS needs, over `fetch`. */
export class GitHubClient {
  constructor(
    private readonly config: GitHubOAuthConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string, challenge: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: SCOPE,
      state,
      allow_signup: "false",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await this.send(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: this.config.redirectUri,
      }),
    });
    const parsed = TokenResponse.safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !parsed.success) throw new GitHubError("rejected", response.status);
    if (!parsed.data.scope.split(",").includes(SCOPE)) throw new GitHubError("rejected");
    return parsed.data.access_token;
  }

  async user(token: string): Promise<string> {
    return (await this.profile(token)).login;
  }

  /** The login and numeric id, which together give the owner's private commit email. */
  async profile(token: string): Promise<{ login: string; id: number }> {
    return User.parse(await this.api(token, "GET", "/user"));
  }

  async repo(token: string, fullName: string): Promise<GitHubRepo> {
    return Repo.parse(await this.api(token, "GET", `/repos/${fullName}`));
  }

  /** A new repository under the owner's account, without any commit. */
  async createRepo(token: string, input: { name: string; description: string; private: boolean }): Promise<GitHubRepo> {
    return Repo.parse(await this.api(token, "POST", "/user/repos", { ...input, auto_init: false }));
  }

  async createPull(token: string, fullName: string, input: { title: string; body: string; head: string; base: string }): Promise<{ url: string; number: number }> {
    const pull = Pull.parse(await this.api(token, "POST", `/repos/${fullName}/pulls`, input));
    return { url: pull.html_url, number: pull.number };
  }

  private async api(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.send(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "jarvis-assistant",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new GitHubError(failure(response.status), response.status);
    return response.json();
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GitHubError("unavailable");
    }
  }
}
