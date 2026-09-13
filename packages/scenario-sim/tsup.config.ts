import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", browser: "src/browser.ts", pulse: "src/pulse.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: "neutral",
    target: "es2022",
  },
  {
    entry: { server: "src/server.ts", vite: "src/vite.ts", cli: "src/cli.ts" },
    format: ["esm"],
    dts: { entry: { server: "src/server.ts", vite: "src/vite.ts" } },
    sourcemap: true,
    platform: "node",
    target: "node20",
    external: ["vite", "ws"],
  },
]);
