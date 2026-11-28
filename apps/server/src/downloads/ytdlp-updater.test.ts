import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checksumFor, YtDlpUpdater } from "./ytdlp-updater.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function release(binary: string, sums: string) {
  const requests: string[] = [];
  const fetchFn = (async (url: string) => {
    requests.push(url);
    if (url.includes("api.github.com")) {
      return Response.json({
        tag_name: "2026.11.27.010203",
        assets: [
          { name: "SHA2-256SUMS", browser_download_url: "https://github.com/sums" },
          { name: "yt-dlp_linux", browser_download_url: "https://github.com/bin" },
        ],
      });
    }
    return new Response(url.endsWith("sums") ? sums : binary);
  }) as typeof fetch;
  return { fetchFn, requests };
}

function updater(fetchFn: typeof fetch, bundled = "2026.11.23") {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-ytdlp-"));
  dirs.push(dir);
  let now = 0;
  const instance = new YtDlpUpdater({ dir, bundled: "/opt/yt-dlp/yt-dlp_linux", fetchFn, now: () => (now += 1_000), versionOf: async () => bundled });
  return { dir, instance };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("yt-dlp updates", () => {
  it("reads the checksum of one file from SHA2-256SUMS", () => {
    const sums = `${sha("a")}  yt-dlp\n${sha("b")}  yt-dlp_linux\n${sha("c")}  yt-dlp_linux.zip\n`;
    expect(checksumFor(sums, "yt-dlp_linux")).toBe(sha("b"));
    expect(checksumFor(sums, "yt-dlp_macos")).toBeUndefined();
  });

  it("keeps a newer nightly only when its checksum matches, and reuses it", async () => {
    const { fetchFn, requests } = release("binary", `${sha("binary")}  yt-dlp_linux\n`);
    const { dir, instance } = updater(fetchFn);
    const path = await instance.freshBin();
    expect(path).toBe(join(dir, "2026.11.27.010203", "yt-dlp_linux"));
    expect(readFileSync(path!, "utf8")).toBe("binary");
    expect(statSync(path!).mode & 0o111).not.toBe(0);
    expect(await instance.freshBin()).toBe(path);
    expect(requests).toHaveLength(3);
  });

  it("refuses a tampered download and does not ask GitHub again for six hours", async () => {
    const { fetchFn, requests } = release("tampered", `${sha("binary")}  yt-dlp_linux\n`);
    const { instance } = updater(fetchFn);
    expect(await instance.freshBin()).toBeUndefined();
    expect(await instance.freshBin()).toBeUndefined();
    expect(requests).toHaveLength(3);
  });

  it("does nothing when the bundled yt-dlp is already as new", async () => {
    const { fetchFn } = release("binary", `${sha("binary")}  yt-dlp_linux\n`);
    expect(await updater(fetchFn, "2026.11.28").instance.freshBin()).toBeUndefined();
  });
});
