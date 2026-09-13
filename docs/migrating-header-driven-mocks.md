# Migrating a header-driven mock API to scenario-sim

Many teams grow a hand-written mock server: a big `if (path === …)` router over
an in-memory fixture object, a scenario picked per request from an
`X-Sim-Scenario` header or cookie, `X-Sim-Latency` / `X-Sim-Fail` knobs, a
`POST /__sim/reset`, and a `window.__sim` object in the app. (The two Ditto
consoles have exactly this shape; ditto-app has the in-bundle variant with an
"endpoint override" layer.) scenario-sim was designed so that shape maps 1:1,
and so the migration can be incremental.

| You have | scenario-sim equivalent |
| --- | --- |
| `createBaseState()` + `scenario.build(base)` | `defineScenario({ setup({ state, rng, clock }) { … } })` — seed the `Store`; ids from `rng.id()`, timestamps from `clock.iso()` |
| `X-Sim-Scenario` header / `sim_scenario` cookie / `?scenario=` | identical — the run for a new request is bound to that scenario |
| `X-Sim-Latency`, `X-Sim-Fail: off\|data\|all` (+ `SHELL_PATHS`) | identical per-request headers; run-level defaults via `faults: { latencyMs, failMode, shellPaths }` |
| `POST /__sim/reset?scenario=` | `POST /__sim/select {scenario}` (fresh state) or `POST /__sim/reset` (same scenario + seed) |
| `GET /__sim/scenarios`, `GET /__sim/state` | same paths; `state` returns the whole store or one `?collection=` |
| `if (path === "/api/v5/companies" && method === "GET") …` | `route.get("/api/v5/companies", (ctx) => json(ctx.state.list("companies")))` — or `crud("/api/v5/companies", "companies", …)` for the whole resource |
| `setEndpointOverride(matcher, { status, body, times, delayMs })` | `POST /__sim/overrides` / `scenario.override` — same fields, plus `malformed` |
| per-tab isolation via `sessionStorage` | `X-Sim-Run` header (or `sim_run` cookie): one store/clock/RNG per run |
| `window.__sim.setScenario / setLatency / setFail / reset / state` | `attachScenarioCommands(pulse, …)` gives `scenario.select / faults / reset / state` in the panel and CLI; or call `sim.api.*` directly |

What you gain immediately: a seeded RNG (no more `Math.random()` ids that
change per boot), a virtual clock you can step, a mutation log
(`GET /__sim/events`), and SSE / WebSocket routes whose events come from state
mutations (`state.on(e => streams.publish(topic, …))`) with replay + resume.

## Incremental path

1. Mount scenario-sim *in front of* the existing mock: in Vite,
   `scenarioSim({ scenarios, match: (p) => OWNED_PATHS.has(p) })` only claims
   the paths you have ported; everything else falls through to the old router.
   In an in-bundle mock, call `sim.handle(request)` first and fall back to the
   old `if` chain on 404.
2. Port one resource at a time with `crud()`; keep the old fixtures as the
   `setup()` seed so screenshots and harness scenarios do not change.
3. Move `X-Sim-*` handling last — scenario-sim already honours the headers, so
   the app's `simulatorHeaders()` keeps working unchanged.
4. Replace the socket stub with a `ws()` route once the REST side is stable;
   the real client then exercises reconnect/resume against scripted drops.

The package's example world (`@omniaura/scenario-sim/examples`) and its tests
show every piece: CRUD → stream events, `Last-Event-ID` / `sinceEventID`
resume, hard drops, manual clock, isolated runs.
