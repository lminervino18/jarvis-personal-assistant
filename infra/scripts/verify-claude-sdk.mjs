import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SDK = "@anthropic-ai/claude-agent-sdk";

function resolveFrom(file, specifier) {
  return createRequire(file).resolve(specifier);
}

function runVersion(binary) {
  const configDir = mkdtempSync(join(tmpdir(), "claude-sdk-check-"));
  try {
    return execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: configDir,
        CLAUDE_CONFIG_DIR: configDir,
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    }).trim();
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

const appRoot = resolve(process.argv[2] ?? process.cwd());
const sdkEntry = resolveFrom(join(appRoot, "package.json"), SDK);
await import(pathToFileURL(sdkEntry).href);

const sdkManifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8"));
const platformPackage = `${SDK}-${process.platform}-${process.arch}`;
const binary = resolveFrom(sdkEntry, `${platformPackage}/claude`);
const version = runVersion(binary);

console.log(JSON.stringify({ sdk: sdkManifest.version, platformPackage, binary, version }));

if (!version.startsWith(sdkManifest.claudeCodeVersion)) {
  console.error(`expected Claude Code ${sdkManifest.claudeCodeVersion}, got "${version}"`);
  process.exit(1);
}
