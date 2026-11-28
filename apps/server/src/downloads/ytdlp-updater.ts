import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const RELEASES = "https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest";
const ASSET = "yt-dlp_linux";
const CHECK_EVERY_MS = 6 * 3_600_000;

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

export interface YtDlpUpdaterOptions {
  /** Where newer builds are kept, one folder per version. */
  dir: string;
  /** The yt-dlp bundled in the image. */
  bundled: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  versionOf?: (bin: string) => Promise<string>;
}

/** The SHA-256 a SHA2-256SUMS file lists for `name`. */
export function checksumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && hash && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return undefined;
}

/**
 * Fetches yt-dlp's latest nightly build when the bundled one stops understanding a site. The
 * binary is checked against the release's SHA2-256SUMS, kept under `dir` and reused; GitHub is
 * asked at most every six hours.
 */
export class YtDlpUpdater {
  private checkedAt = Number.NEGATIVE_INFINITY;
  private found: string | undefined;

  constructor(private readonly options: YtDlpUpdaterOptions) {}

  async freshBin(): Promise<string | undefined> {
    if (this.found && existsSync(this.found)) return this.found;
    const now = (this.options.now ?? Date.now)();
    if (now - this.checkedAt < CHECK_EVERY_MS) return undefined;
    this.checkedAt = now;
    try {
      this.found = await this.download();
    } catch {
      this.found = undefined;
    }
    return this.found;
  }

  private async download(): Promise<string | undefined> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const release = (await (await fetchFn(RELEASES, { signal: AbortSignal.timeout(30_000) })).json()) as Release;
    const versionOf = this.options.versionOf ?? (async (bin: string) => (await run(bin, ["--version"], { timeout: 30_000 })).stdout.trim());
    if (!/^[\d.]+$/.test(release.tag_name) || release.tag_name <= (await versionOf(this.options.bundled))) return undefined;
    const url = (name: string) => release.assets.find((asset) => asset.name === name)?.browser_download_url;
    const sumsUrl = url("SHA2-256SUMS");
    const binUrl = url(ASSET);
    if (!sumsUrl || !binUrl) return undefined;
    const expected = checksumFor(await (await fetchFn(sumsUrl, { signal: AbortSignal.timeout(30_000) })).text(), ASSET);
    const binary = Buffer.from(await (await fetchFn(binUrl, { signal: AbortSignal.timeout(300_000) })).arrayBuffer());
    if (!expected || createHash("sha256").update(binary).digest("hex") !== expected) return undefined;
    const folder = join(this.options.dir, release.tag_name);
    const path = join(folder, ASSET);
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${path}.part`, binary);
    chmodSync(`${path}.part`, 0o755);
    renameSync(`${path}.part`, path);
    return path;
  }
}
