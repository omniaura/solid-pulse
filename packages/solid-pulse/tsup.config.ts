import { defineConfig } from "tsup";

const browser = {
  format: ["esm"] as const,
  dts: true,
  sourcemap: true,
  platform: "browser" as const,
  external: ["solid-js", "@tanstack/query-core"],
  target: "es2022",
};

export default defineConfig([
  {
    ...browser,
    entry: {
      index: "src/index.ts",
      core: "src/core/index.ts",
      query: "src/query/index.ts",
      panel: "src/panel/index.ts",
    },
    clean: true,
  },
  {
    entry: { bridge: "src/bridge/server.ts", vite: "src/vite.ts", cli: "src/bridge/cli.ts" },
    format: ["esm"],
    dts: { entry: { bridge: "src/bridge/server.ts", vite: "src/vite.ts" } },
    sourcemap: true,
    platform: "node",
    target: "node20",
    external: ["vite", "ws"],
    banner: ({ format }) => (format === "esm" ? { js: "" } : {}),
  },
]);
