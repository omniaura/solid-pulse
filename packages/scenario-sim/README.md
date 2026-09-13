# @omniaura/scenario-sim

> A mock backend that behaves like a backend: stateful, seeded, reproducible, streaming — and controllable by humans and agents alike.

Most mock layers return fixtures. `scenario-sim` runs **scenarios**: a seeded world with CRUD state, a virtual clock, response sequences and faults, SSE and WebSocket routes whose events come from state mutations, and a control plane to select/reset/step/inspect everything. The core is runtime-neutral (Web `Request`/`Response`) so the same scenario runs as a Bun/Node server, inside the Vite dev server, or entirely inside the browser.

## Define a scenario

```ts
import { defineScenario, crud, route, json, problem, sequence, malformed, ws, sse } from "@omniaura/scenario-sim";

export const happy = defineScenario({
  name: "notes-happy",
  seed: "notes-happy",                       // same seed → same ids, same fixtures, same jitter
  clock: { mode: "realtime" },               // or "manual": nothing time-based happens until stepped
  faults: { latencyMs: 0 },
  setup({ state, rng, clock, streams }) {
    for (let i = 0; i < 8; i++) state.insert("notes", { id: rng.id("note"), title: rng.pick(WORDS), done: false, createdAt: clock.iso() });
    // Mutations → stream events. Routes mutate state; streams subscribe to it.
    state.on((e) => e.collection === "notes" && streams.publish("notes", { type: `notes.${e.kind}`, id: e.id, note: e.record ?? null }));
  },
  routes: [
    ...crud("/api/notes", "notes", { create: (body, ctx) => ({ id: ctx.rng.id("note"), title: String(body.title), done: false, createdAt: ctx.clock.iso() }) }),
    route.get("/api/flaky", (ctx) => (ctx.calls % 3 === 0 ? problem(503, "flaky upstream") : json({ ok: true }))),
    route.get("/api/drift", sequence([() => malformed("invalid-json"), () => malformed("schema-drift"), () => json({ ok: true })])),
  ],
  streams: [
    sse("/api/notes/events", (ctx, stream) => stream.subscribe("notes")),           // resumes from Last-Event-ID
    ws("/api/chat/ws", {
      protocols: ["chat-v1"],
      onOpen: (ctx, socket) => socket.send({ type: "ready" }),
      onMessage(ctx, socket, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type === "subscribe") {
          const r = socket.subscribe(frame.topic, { since: frame.sinceEventID });   // replay > sinceEventID, then live
          socket.send({ type: "subscribed", replayed: r.replayed, last: r.last });
          if (r.missed) socket.send({ type: "resume.miss" });
        }
      },
    }),
  ],
  actions: { burst: ({ state, rng, args }) => { /* insert N notes */ } },   // POST /__sim/action {name:"burst"}
});
```

Everything in a scenario is deterministic given the seed: `rng.id()`, `rng.pick()`, jitter, virtual timestamps (`clock.iso()` starts at 2026-01-01T00:00:00Z). Streams carry a per-topic monotonic `eventID` with a bounded replay log; `subscribe(topic, { since })` replays what a reconnecting client missed and reports `missed` when the resume point fell out of the window (so you can send the protocol's "resync" frame).

`crud(path, collection, …)` gives you `GET /path`, `POST /path` → 201, `GET/PATCH/PUT/DELETE /path/:id` with 404/422 handling and store events for every mutation.

## Run it

```ts
// as a server
import { Simulator } from "@omniaura/scenario-sim";
import { serveSimulator } from "@omniaura/scenario-sim/server";
const sim = new Simulator({ scenarios: [happy, slow, flaky] });
await serveSimulator(sim, { port: 4100 });      // http://127.0.0.1:4100/__sim/status

// inside Vite (same origin as the app, WebSocket upgrades included)
import scenarioSim from "@omniaura/scenario-sim/vite";
plugins: [scenarioSim({ scenarios: () => import("./scenarios"), match: (p) => p.startsWith("/api/") })]

// entirely in the browser (static builds, demo islands, Playwright against `vite preview`)
import { installBrowserSimulator } from "@omniaura/scenario-sim/browser";
const { sim } = installBrowserSimulator({ scenarios, run: "tab-1" });   // patches fetch/WebSocket/EventSource for matching URLs
```

```bash
scenario-sim serve ./scenarios.ts --port 4100 --scenario notes-happy
```

## Control plane (HTTP, CLI, JS, pulse panel — the same operations)

| Operation | HTTP | CLI | pulse command |
| --- | --- | --- | --- |
| list scenarios | `GET /__sim/scenarios` | `scenario-sim scenarios` | `scenario.list` |
| status (scenario, seed, clock, state counts, streams, faults, routes) | `GET /__sim/status?run=` | `status` | `scenario.status` |
| select scenario (fresh state) | `POST /__sim/select {scenario, seed?, run?}` | `select name= seed=` | `scenario.select` |
| reset (rebuild from seed) | `POST /__sim/reset {run?, seed?}` | `reset` | `scenario.reset` |
| step the virtual clock | `POST /__sim/step {ms}` | `step ms=1000` | `scenario.step` |
| clock mode/speed | `POST /__sim/clock {mode, speed}` | `clock mode=manual` | `scenario.clock` |
| inspect state | `GET /__sim/state?collection=` | `state collection=notes` | `scenario.state` |
| mutation log | `GET /__sim/events?since=` | `events` | `scenario.events` |
| run log | `GET /__sim/log` | `log` | `scenario.log` |
| open streams + topics | `GET /__sim/streams` | `streams` | `scenario.streams` |
| disconnect / hard-drop streams | `POST /__sim/streams/disconnect {id\|topic\|path\|all, drop}` | `disconnect all=true drop=true` | `scenario.disconnect` |
| pause / resume delivery | `POST /__sim/streams/pause {id, paused}` | `pause id=ws_1` | — |
| publish an event by hand | `POST /__sim/publish {topic, data}` | `publish topic= data=` | `scenario.publish` |
| overrides (force any endpoint) | `GET/POST/DELETE /__sim/overrides` | `override matcher= status= times=` | `scenario.override`, `.override.clear`, `.overrides` |
| faults | `POST /__sim/faults {latencyMs, jitterMs, failMode, streamLatencyMs}` | `faults latencyMs=800` | `scenario.faults` |
| scenario action | `POST /__sim/action {name, args}` | `action name=burst args='{"count":5}'` | `scenario.action` |
| runs (isolation) | `GET /__sim/runs`, `DELETE /__sim/runs?run=` | `runs` | `scenario.runs` |

**Runs** isolate state: pick one per request with `X-Sim-Run` (or the `sim_run` cookie / `?__run=`). Each run has its own store, clock, RNG, streams and faults, so two tabs or two agents never see each other's mutations. A scenario for a *new* run comes from `X-Sim-Scenario` / cookie / `?scenario=` / the default.

**Overrides** win over routing and even over unrouted paths: `{matcher: "/api/notes", method: "GET", status: 503, times: 1}` fails the next list once, then the endpoint recovers. `malformed: "invalid-json" | "wrong-content-type" | "truncated" | "empty-200" | "html-500" | "schema-drift"` exercises client validation paths.

**Fail modes**: `off`, `data` (5xx everything except `shellPaths`, so the app shell still boots), `all`. Per request, `X-Sim-Latency: <ms>` and `X-Sim-Fail: off|data|all` headers layer on top of the run's faults (the same contract as header-driven console mocks, so a tab or a curl can opt into its own faults).

Attach to solid-pulse so the panel's Scenarios tab and `solid-pulse scenario.*` drive it:

```ts
import { attachScenarioCommands } from "@omniaura/scenario-sim/pulse";
attachScenarioCommands(pulse, { kind: "remote", controlUrl: "/__sim" });     // Vite/server
attachScenarioCommands(pulse, { kind: "local", sim, run: "tab-1" });         // in-browser
```

## Shipped example world

`@omniaura/scenario-sim/examples` exports a generic notes + chat world (no product data): `notes-happy`, `notes-empty`, `notes-slow`, `notes-flaky`, `notes-malformed`, `chat-stream-drop` (the socket is hard-dropped halfway through every reply; clients must reconnect with `sinceEventID`), `notes-manual-clock` (deterministic streaming for tests). Its WebSocket protocol (`chat-v1`: subscribe/send → ready/subscribed/message/stream.start/chat.content/stream.done/resume.miss) is shaped like real chat backends so reconnect logic gets a workout. The package tests are the reference for CRUD → stream events, resume, drop, isolation and manual-clock determinism.

## Notes on transports

- SSE is served as a `Response` with a `ReadableStream`, so it works on every adapter; `Last-Event-ID` (or `?lastEventId=` / `?sinceEventID=`) resumes. Both `GET` and `POST`-opened SSE routes are supported (`method: "POST"`).
- WebSocket upgrades are performed by the adapter (`ws` on Node/Bun, a fake `WebSocket` class in the browser); scenario code only sees `SimSocket`. Browsers drop `Upgrade`/`Sec-WebSocket-Protocol` from `Request` headers, so adapters also send `x-sim-upgrade` / `x-sim-websocket-protocol`, which the engine honours.
- `drop()` cuts a connection without a close frame (the client sees 1006), unlike `close()`. Stream delivery latency is separate from HTTP latency (`streamLatencyMs`).

MIT © omniaura
