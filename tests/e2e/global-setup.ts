import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const serverDir = resolve(import.meta.dirname, "../../apps/server");

export default function buildServer(): void {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: serverDir, stdio: "pipe" });
  for (const entry of ["main.js", "worker.js"]) {
    if (!existsSync(resolve(serverDir, "dist", entry))) throw new Error(`apps/server/dist/${entry} was not built`);
  }
}
