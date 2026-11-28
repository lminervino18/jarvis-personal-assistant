import { WarpSupervisor } from "./warp/warp-supervisor.js";

const supervisor = new WarpSupervisor({
  dir: process.env.WARP_DIR ?? "/etc/wireproxy",
  wireproxy: process.env.WIREPROXY_BIN ?? "/wireproxy",
  wgcf: process.env.WGCF_BIN ?? "/wgcf",
  socksPort: 40000,
  controlPort: 40001,
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void supervisor.stop().then(() => process.exit(0)));
}
supervisor.start();
