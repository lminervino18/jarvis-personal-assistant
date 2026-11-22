import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** The project whose tasks change JARVIS itself and can be published. */
export const BUILD_PROJECT = "jarvis";

export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

const COMMIT_TITLE = /^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([a-z0-9-]+\))?: [^\s].{2,90}$/;

/** True for a one-line Conventional Commit title as the repository requires. */
export function isCommitTitle(title: string): boolean {
  return COMMIT_TITLE.test(title) && !/[\r\n]/.test(title);
}

export const PublishRequest = z.object({
  id: z.uuid(),
  taskRef: z.number().int().positive(),
  commitTitle: z.string().refine(isCommitTitle, "not a Conventional Commit title"),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  requestedAt: z.iso.datetime(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const PublishResult = z.object({
  id: z.uuid(),
  status: z.enum(["running", "published", "failed"]),
  step: z.string().max(40).optional(),
  commit: z.string().max(40).optional(),
  message: z.string().max(600).optional(),
  at: z.iso.datetime(),
});
export type PublishResult = z.infer<typeof PublishResult>;

function signedText(request: Omit<PublishRequest, "signature">): string {
  return [request.id, request.taskRef, request.commitTitle, request.patchSha256, request.requestedAt].join("\n");
}

/** HMAC of a request, so the publisher only acts on requests the server wrote after the owner's tap. */
export function signRequest(key: string, request: Omit<PublishRequest, "signature">): string {
  return createHmac("sha256", key).update(signedText(request)).digest("hex");
}

export function verifyRequest(key: string, request: PublishRequest): boolean {
  const expected = Buffer.from(signRequest(key, request), "hex");
  const given = Buffer.from(request.signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The folder shared by the server (which writes owner-approved requests) and the host
 * publisher (which writes results). Requests appear atomically: the patch first, then the
 * signed request, which is what the publisher watches for.
 */
export class PublicationSpool {
  readonly requestsDir: string;
  readonly resultsDir: string;

  constructor(
    readonly dir: string,
    private readonly signingKey: string,
  ) {
    this.requestsDir = join(dir, "requests");
    this.resultsDir = join(dir, "results");
  }

  available(): boolean {
    return this.signingKey.length >= 32 && existsSync(this.requestsDir) && existsSync(this.resultsDir);
  }

  submit(input: Omit<PublishRequest, "signature" | "patchSha256">, patch: string): PublishRequest {
    const request: PublishRequest = { ...input, patchSha256: sha256(patch), signature: "" };
    request.signature = signRequest(this.signingKey, request);
    mkdirSync(this.requestsDir, { recursive: true });
    writeFileSync(join(this.requestsDir, `${request.id}.patch`), patch, { mode: 0o640 });
    const pending = join(this.requestsDir, `.${request.id}.json`);
    writeFileSync(pending, JSON.stringify(request), { mode: 0o640 });
    renameSync(pending, join(this.requestsDir, `${request.id}.json`));
    return request;
  }

  result(id: string): PublishResult | undefined {
    const path = join(this.resultsDir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = PublishResult.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success && parsed.data.id === id ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
