import { createHash } from "node:crypto";
import { z } from "zod";

const API = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 30_000;

export type VercelFailure = "unauthorized" | "not_found" | "conflict" | "rejected" | "unavailable";

/** A failed Vercel call. The message never carries tokens or response bodies. */
export class VercelError extends Error {
  constructor(
    readonly reason: VercelFailure,
    readonly status?: number,
  ) {
    super(`vercel ${reason}${status ? ` (${status})` : ""}`);
  }
}

/** Vercel could not build or serve the deployment; the inspector shows its logs. */
export class VercelBuildError extends Error {
  constructor(
    readonly inspectorUrl?: string,
    readonly reason: "failed" | "timeout" = "failed",
  ) {
    super(`vercel deployment ${reason}`);
  }
}

const User = z.object({ user: z.object({ username: z.string().min(1) }) });
const Deployment = z.object({ id: z.string(), url: z.string(), readyState: z.string().optional(), inspectorUrl: z.string().nullish() });

export interface DeployFile {
  file: string;
  data: Buffer;
}

export interface DeployResult {
  url: string;
  inspectorUrl?: string;
}

const POLL_MS = 5_000;
const DEPLOY_TIMEOUT_MS = 12 * 60_000;
const Teams = z.object({ teams: z.array(z.object({ id: z.string(), slug: z.string() })) });

function failure(status: number): VercelFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/** The Vercel REST calls JARVIS needs to publish projects, over `fetch`. */
export class VercelClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async user(token: string): Promise<string> {
    return User.parse(await this.api(token, "GET", "/v2/user")).user.username;
  }

  /** The team that owns `domain`, so projects can use its subdomains; undefined when no team has it. */
  async teamForDomain(token: string, domain: string): Promise<string | undefined> {
    const { teams } = Teams.parse(await this.api(token, "GET", "/v2/teams"));
    for (const team of teams) {
      try {
        await this.api(token, "GET", `/v6/domains/${encodeURIComponent(domain)}?teamId=${team.id}`);
        return team.id;
      } catch (error) {
        if (!(error instanceof VercelError) || error.reason !== "not_found") throw error;
      }
    }
    return undefined;
  }

  /**
   * Uploads the files, deploys them to production as project `name` (Vercel detects the framework),
   * points `<name>.<domain>` at it when a domain is given, and waits until it is ready.
   */
  async deploy(token: string, teamId: string | undefined, name: string, files: readonly DeployFile[], domain?: string): Promise<DeployResult> {
    const scope = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";
    const entries = [];
    for (const { file, data } of files) {
      const sha = createHash("sha1").update(data).digest("hex");
      await this.api(token, "POST", `/v2/files?${scope}`, new Uint8Array(data), { "x-vercel-digest": sha, "content-type": "application/octet-stream" });
      entries.push({ file, sha, size: data.length });
    }
    const created = Deployment.parse(
      await this.api(token, "POST", `/v13/deployments?${scope}&skipAutoDetectionConfirmation=1`, { name, project: name, target: "production", files: entries }),
    );
    if (domain) {
      try {
        await this.api(token, "POST", `/v10/projects/${encodeURIComponent(name)}/domains?${scope}`, { name: `${name}.${domain}` });
      } catch (error) {
        if (!(error instanceof VercelError) || error.reason !== "conflict") throw error;
      }
    }
    const started = Date.now();
    for (;;) {
      const current = Deployment.parse(await this.api(token, "GET", `/v13/deployments/${created.id}?${scope}`));
      const inspectorUrl = current.inspectorUrl ?? undefined;
      if (current.readyState === "READY") return { url: domain ? `https://${name}.${domain}` : `https://${current.url}`, ...(inspectorUrl ? { inspectorUrl } : {}) };
      if (current.readyState === "ERROR" || current.readyState === "CANCELED") throw new VercelBuildError(inspectorUrl);
      if (Date.now() - started > DEPLOY_TIMEOUT_MS) throw new VercelBuildError(inspectorUrl, "timeout");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async api(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
        ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VercelError("unavailable");
    }
    if (!response.ok) throw new VercelError(failure(response.status), response.status);
    return response.json();
  }
}
