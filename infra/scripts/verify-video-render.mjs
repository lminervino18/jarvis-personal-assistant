// Renders one frame of the sample composition inside the video image, proving the browser,
// its system libraries, the fonts and the bundle all work. Usage: node verify-video-render.mjs <bundle-dir>
import { statSync } from "node:fs";
import { renderStill, selectComposition } from "@remotion/renderer";

const bundle = process.argv[2] ?? "/app/video-bundle";
const output = "/tmp/video-smoke.png";
const composition = await selectComposition({ serveUrl: bundle, id: "jarvis-video", inputProps: {}, logLevel: "warn" });
await renderStill({ serveUrl: bundle, composition, frame: 200, output, imageFormat: "png", scale: 0.25, logLevel: "warn" });
const size = statSync(output).size;
if (size < 5000) throw new Error(`smoke frame is too small (${size} bytes)`);
console.log(`video render ok: ${composition.width}x${composition.height}, ${composition.durationInFrames} frames, smoke frame ${size} bytes`);
