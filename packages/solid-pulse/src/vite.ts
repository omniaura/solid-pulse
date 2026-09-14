/**
 * @omniaura/solid-pulse/vite
 *
 *   import solidPulse from "@omniaura/solid-pulse/vite";
 *   export default defineConfig({ plugins: [solidPulse(), solidGrab(), solid()] });
 *
 * Dev server only (`apply: "serve"`): production builds never see this
 * plugin, the runtime import or the bridge. In dev it
 *   1. injects the runtime as the *first* module script so Solid's dev hooks
 *      are installed before the app's first render,
 *   2. mounts the bridge (WebSocket ingest + HTTP/SSE API) on the Vite dev
 *      server under `/__pulse`, loopback-only,
 *   3. writes `node_modules/.vite/solid-pulse.json` so the `solid-pulse` CLI
 *      finds the bridge without flags.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { BridgeServer } from "./bridge/server.js";
import { DEFAULT_PATH } from "./core/protocol.js";

export interface SolidPulseVitePluginOptions {
  /** Inject the runtime automatically (default true). */
  autoImport?: boolean;
  /** Mount the bridge on the dev server (default true). */
  bridge?: boolean;
  /** URL prefix for the bridge (default `/__pulse`). */
  path?: string;
  /** Accept non-loopback connections (default false). */
  allowRemote?: boolean;
  /** Also mount the raw-DOM panel (default true). */
  panel?: boolean;
  /** Options forwarded to `initPulse` (JSON-serialisable). */
  runtimeOptions?: Record<string, unknown>;
  /**
   * Module that `export default (pulse) => void`, imported before the app's
   * entry so adapters (attachQueryClient, attachScenarioCommands) are in
   * place for the first render. E.g. "/src/pulse-setup.ts".
   */
  setupModule?: string;
}

const VIRTUAL_INIT = "virtual:solid-pulse-init";
const RESOLVED_VIRTUAL_INIT = "\0" + VIRTUAL_INIT;
const SERVE_URL = "/@solid-pulse/init";

export default function solidPulse(options: SolidPulseVitePluginOptions = {}): Plugin {
  const { autoImport = true, bridge = true, path = DEFAULT_PATH, allowRemote = false, panel = true, runtimeOptions = {}, setupModule } = options;
  let config: ResolvedConfig;

  return {
    name: "solid-pulse",
    enforce: "pre",
    apply: "serve",

    configResolved(resolved) {
      config = resolved;
    },

    resolveId(id) {
      if (id === VIRTUAL_INIT) return RESOLVED_VIRTUAL_INIT;
      return null;
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_INIT) return null;
      const opts = { bridge: bridge, ...runtimeOptions };
      // The setup module is imported statically so it is evaluated before the
      // app's entry module runs (and before the first render): adapters such as
      // attachQueryClient must exist when the first observers subscribe. It
      // must `export default (pulse) => { ... }`.
      return [
        `import { initPulse } from "@omniaura/solid-pulse";`,
        panel ? `import { mountPanel } from "@omniaura/solid-pulse/panel";` : "",
        setupModule ? `import setup from ${JSON.stringify(setupModule)};` : "",
        `const pulse = initPulse(${JSON.stringify(opts)});`,
        setupModule ? `try { if (typeof setup === "function") setup(pulse); else console.warn("[solid-pulse] setup module must export default (pulse) => void"); } catch (e) { console.warn("[solid-pulse] setup module failed", e); }` : "",
        panel ? `mountPanel(pulse);` : "",
        `if (import.meta.hot) import.meta.hot.dispose(() => pulse.destroy());`,
        `export default pulse;`,
      ]
        .filter(Boolean)
        .join("\n");
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === SERVE_URL) req.url = `/@id/${VIRTUAL_INIT}`;
        next();
      });
      if (!bridge) return;
      const bridgeServer = new BridgeServer({ path, allowRemote, log: (m) => config.logger.info(`  ◉ solid-pulse: ${m}`) });
      if (server.httpServer) {
        bridgeServer.attach(server.httpServer as import("node:http").Server);
        server.httpServer.once("listening", () => {
          const addr = server.httpServer!.address();
          const port = typeof addr === "object" && addr ? addr.port : config.server.port ?? 5173;
          const url = `http://localhost:${port}${path}`;
          try {
            mkdirSync(config.cacheDir, { recursive: true });
            writeFileSync(join(config.cacheDir, "solid-pulse.json"), JSON.stringify({ url, pid: process.pid, wall: Date.now() }));
          } catch {
            // cache dir may be read-only; the CLI still accepts --url
          }
          config.logger.info(`  ◉ solid-pulse bridge: ${url}/api/status  (CLI: npx solid-pulse status)`);
        });
      }
      server.middlewares.use((req, res, next) => {
        if (!bridgeServer.handleHttp(req, res)) next();
      });
      server.httpServer?.once("close", () => bridgeServer.close());
    },

    transformIndexHtml() {
      if (!autoImport) return;
      return [{ tag: "script", attrs: { type: "module", src: SERVE_URL }, injectTo: "head-prepend" as const }];
    },
  };
}
