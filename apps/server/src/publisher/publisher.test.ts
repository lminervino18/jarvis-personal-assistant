import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forbiddenPaths, patchPaths, Publisher, type Exec, type ExecResult } from "./publisher.js";
import { PublicationSpool, type PublishResult } from "./spool.js";

const KEY = "s".repeat(64);
const PATCH = "diff --git a/apps/web/src/a.ts b/apps/web/src/a.ts\n--- a/apps/web/src/a.ts\n+++ b/apps/web/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const ID = "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function setup(answers: (call: Call) => Partial<ExecResult> | undefined = () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-publish-"));
  dirs.push(dir);
  mkdirSync(join(dir, "requests"), { recursive: true });
  mkdirSync(join(dir, "results"), { recursive: true });
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    const call = { command, args, ...(options.env ? { env: options.env } : {}) };
    calls.push(call);
    const defaults: ExecResult =
      (args[0] === "diff" && args.includes("--cached")) || args.includes("--reverse") ? { code: 1, output: "" } : args[0] === "rev-parse" ? { code: 0, output: "abc123def456\n" } : { code: 0, output: "" };
    return { ...defaults, ...answers(call) };
  };
  const publisher = new Publisher(
    {
      dir,
      signingKey: KEY,
      fetchUrl: "https://example.invalid/jarvis.git",
      pushUrl: "git@example.invalid:owner/jarvis.git",
      sshKey: "/keys/publish",
      knownHosts: "/keys/known_hosts",
      authorName: "Owner",
      authorEmail: "owner@example.invalid",
      jarvisDir: "/opt/jarvis",
      checkTimeoutMs: 1000,
      deployTimeoutMs: 1000,
    },
    exec,
    { info: () => {}, warn: () => {} },
    () => new Date("2026-11-22T12:00:00Z"),
  );
  const submit = (patch = PATCH, key = KEY) =>
    new PublicationSpool(dir, key).submit({ id: ID, taskRef: 7, commitTitle: "feat(web): add a greeting", requestedAt: "2026-11-22T11:59:00.000Z" }, patch);
  const result = () => JSON.parse(readFileSync(join(dir, "results", `${ID}.json`), "utf8")) as PublishResult;
  const ran = (command: string, first?: string) => calls.filter((call) => call.command === command && (!first || call.args[0] === first || call.args.includes(first)));
  return { dir, calls, publisher, submit, result, ran };
}

describe("patch paths", () => {
  it("reads every path a patch touches and blocks the privileged ones", () => {
    const patch = `${PATCH}diff --git a/infra/scripts/deploy.sh b/infra/scripts/deploy.sh\ndiff --git a/apps/server/src/publisher/spool.ts b/apps/server/src/publisher/spool.ts\ndiff --git a/Dockerfile b/Dockerfile\n`;
    expect(forbiddenPaths(patchPaths(patch))).toEqual(["infra/scripts/deploy.sh", "apps/server/src/publisher/spool.ts"]);
    expect(forbiddenPaths(["apps/web/../../etc/passwd"])).toHaveLength(1);
    expect(forbiddenPaths(patchPaths(PATCH))).toEqual([]);
  });
});

describe("publisher", () => {
  it("checks, commits as the owner, pushes with the deploy key and deploys that commit", async () => {
    const { dir, publisher, submit, result, calls, ran } = setup();
    submit();
    await publisher.runPending();

    expect(result()).toMatchObject({ status: "published", step: "deploy", commit: "abc123def456" });
    const order = calls.map((call) => `${call.command} ${call.args.filter((arg) => !arg.startsWith("-c") && !arg.includes("=")).slice(0, 2).join(" ")}`);
    expect(order.indexOf("docker build --target")).toBeLessThan(order.findIndex((line) => line.startsWith("git push")));
    expect(order.findIndex((line) => line.startsWith("git push"))).toBeLessThan(order.findIndex((line) => line.startsWith("infra/scripts/deploy.sh")));
    expect(ran("infra/scripts/deploy.sh")[0]?.args).toEqual(["abc123def456"]);
    expect(ran("git", "commit")[0]?.args).toEqual(expect.arrayContaining(["user.name=Owner", "user.email=owner@example.invalid", "feat(web): add a greeting"]));
    expect(ran("git", "push")[0]?.env?.GIT_SSH_COMMAND).toContain("-i /keys/publish");
    expect(ran("git", "push")[0]?.args).toContain("HEAD:refs/heads/main");
    expect(existsSync(join(dir, "done", `${ID}.json`))).toBe(true);
    expect(existsSync(join(dir, "requests", `${ID}.json`))).toBe(false);
  });

  it("refuses a request that was not signed by the server", async () => {
    const { publisher, submit, result, calls } = setup();
    submit(PATCH, "f".repeat(64));
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "failed", step: "verify" });
    expect(calls).toEqual([]);
  });

  it("refuses a patch that was swapped after the tap", async () => {
    const { dir, publisher, submit, result, calls } = setup();
    submit();
    writeFileSync(join(dir, "requests", `${ID}.patch`), PATCH.replace("+b", "+evil"));
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "failed", step: "verify", message: expect.stringContaining("no coincide") });
    expect(calls).toEqual([]);
  });

  it("refuses changes to the deploy pipeline", async () => {
    const { publisher, submit, result, calls } = setup();
    submit("diff --git a/infra/scripts/deploy.sh b/infra/scripts/deploy.sh\n--- a/x\n+++ b/x\n");
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "failed", step: "verify", message: expect.stringContaining("infra/scripts/deploy.sh") });
    expect(calls).toEqual([]);
  });

  it("reports a change that is already in JARVIS as published, without checking or deploying again", async () => {
    const { publisher, submit, result, ran } = setup((call) => (call.args.includes("--reverse") ? { code: 0, output: "" } : undefined));
    submit();
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "published", step: "apply", commit: "abc123def456", message: "El cambio ya estaba publicado en JARVIS." });
    expect(ran("docker")).toEqual([]);
    expect(ran("git", "push")).toEqual([]);
    expect(ran("infra/scripts/deploy.sh")).toEqual([]);
  });

  it("stops before GitHub when the checks fail", async () => {
    const output = ["#12 70.10 lint ok", "#12 75.20 FAIL src/a.test.ts > reads the fixture", "#12 75.21 Error: ENOENT: no such file or directory, open 'fixtures/synthetic/a.ogg'", ...Array.from({ length: 40 }, (_, i) => `#12 76.${i} noise ${i}`), "#12 79.70 Tests 1 failed"].join("\n");
    const { publisher, submit, result, ran } = setup((call) => (call.command === "docker" && call.args[0] === "build" ? { code: 1, output } : undefined));
    submit();
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "failed", step: "checks", message: expect.stringContaining("FAIL src/a.test.ts > reads the fixture") });
    expect(result()?.message).toContain("ENOENT");
    expect(result()?.message).toContain("Tests 1 failed");
    expect(ran("git", "push")).toEqual([]);
    expect(ran("infra/scripts/deploy.sh")).toEqual([]);
  });

  it("rolls back and reverts on GitHub when the deploy fails", async () => {
    const { publisher, submit, result, ran } = setup((call) => (call.command === "infra/scripts/deploy.sh" && call.args[0] !== "rollback" ? { code: 1, output: "container unhealthy" } : undefined));
    submit();
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "failed", step: "deploy", message: expect.stringContaining("revertí el commit") });
    expect(ran("infra/scripts/deploy.sh").map((call) => call.args[0])).toEqual(["abc123def456", "rollback"]);
    expect(ran("git", "revert")).toHaveLength(1);
    expect(ran("git", "push")).toHaveLength(2);
  });

  it("publishes nothing while the server copy has changes that are not on GitHub", async () => {
    const { publisher, submit, result, ran } = setup((call) => (call.args[0] === "merge-base" ? { code: 1 } : undefined));
    submit();
    await publisher.runPending();
    expect(result()).toMatchObject({ status: "failed", step: "prepare" });
    expect(ran("git", "apply")).toEqual([]);
  });

  it("does not publish twice a request that already finished", async () => {
    const { dir, publisher, submit, calls } = setup();
    submit();
    writeFileSync(join(dir, "results", `${ID}.json`), JSON.stringify({ id: ID, status: "published", at: "2026-11-22T12:00:00.000Z" }));
    await publisher.runPending();
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "done", `${ID}.json`))).toBe(true);
  });
});
