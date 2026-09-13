# solid-pulse

Dev-mode instrumentation for SolidJS apps, and a deterministic scenario simulator to run them against — both built so that **everything a human can do in the panel, an agent can do from a CLI**.

| Package | What it is |
| --- | --- |
| [`@omniaura/solid-pulse`](packages/solid-pulse) | Flash what *really* updates: fine-grained computations, component mounts/remounts, DOM mutations, DOM detach→reattach (with scroll-reset and focus-loss detection), fetch / WebSocket / SSE lifecycle, Solid Query observers (initiating vs sharing). Raw-DOM panel, loopback-only bridge, `solid-pulse` CLI, Vite plugin. |
| [`@omniaura/scenario-sim`](https://github.com/omniaura/scenario-sim) (own repo) | Stateful, seeded, reproducible mock backend: CRUD routes with a mutation log, virtual clock, response sequences, faults and overrides, SSE and WebSocket routes with resume and controllable disconnects, per-run isolation, an HTTP control plane and `scenario-sim` CLI. Runs as a server, inside Vite, or entirely in the browser. |

Solid has no "rerender", so nothing here pretends there is one. Events are named for what actually happened.

```bash
bun add -d @omniaura/solid-pulse @omniaura/scenario-sim
```

```ts
// vite.config.ts
import solid from "vite-plugin-solid";
import solidPulse from "@omniaura/solid-pulse/vite";
import scenarioSim from "@omniaura/scenario-sim/vite";
import { scenarios } from "./scenarios";

export default defineConfig({
  plugins: [
    solidPulse(),                 // dev only: runtime + panel + bridge at /__pulse
    scenarioSim({ scenarios }),   // dev only, --mode simulator: mock API at /api/* + control plane at /__sim
    solid(),
  ],
});
```

Then, from any shell:

```bash
npx solid-pulse tail kinds=dom.reattach,focus.lost          # watch for Suspense flips that lose scroll/focus
npx solid-pulse inspect.element selector='[data-testid=composer]'
npx solid-pulse scenario.select name=chat-stream-drop         # the panel's Scenarios tab, as a command
npx scenario-sim disconnect all=true drop=true --url http://localhost:5173/__sim
```

See [`packages/solid-pulse`](packages/solid-pulse) for the full command table, protocol and security model, and the [scenario-sim repo](https://github.com/omniaura/scenario-sim) for the simulator. `examples/basic` is a runnable consumer app (uses the published scenario-sim) exercised by `bun run smoke`.

## Development

```bash
bun install
bun run build       # tsup
bun run test        # unit (happy-dom, Solid dev build) + e2e (built CLIs)
bun run typecheck
bun run smoke       # example app: production build contains no devtools; dev server exposes /__pulse and /__sim
```

Releases: conventional commits on `main` → semantic-release publishes `@omniaura/solid-pulse` to npm with OIDC provenance (no tokens). See `.releaserc.json`.

MIT © omniaura
