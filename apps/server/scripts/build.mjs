import { readdirSync } from "node:fs";
import { build } from "esbuild";

const entryPoints = ["src/main.ts", ...readdirSync("src").filter((f) => f === "worker.ts").map((f) => `src/${f}`)];

const externalizeDependencies = {
  name: "externalize-dependencies",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@jarvis/") ? undefined : { path: args.path, external: true },
    );
  },
};

await build({
  entryPoints,
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  plugins: [externalizeDependencies],
  logLevel: "info",
});
