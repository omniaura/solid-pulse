/**
 * The simulator: resolves a run per request, applies faults, routes HTTP/SSE/
 * WebSocket, and serves the control plane under `/__sim`. Runtime-neutral:
 * takes a Web `Request`, returns a Web `Response`. Adapters (Bun/Node server,
 * Vite middleware, in-browser) only translate transports and WebSocket
 * upgrades.
 *
 * Control plane (all also available as `sim.api.*` in-process):
 *   GET  /__sim/scenarios
 *   GET  /__sim/status?run=
 *   POST /__sim/select  {scenario, seed?, run?}   bind a run to a scenario (fresh state)
 *   POST /__sim/reset   {run?, seed?}             rebuild the run's scenario
 *   POST /__sim/step    {run?, ms}                advance a manual clock
 *   POST /__sim/clock   {run?, mode?, speed?}
 *   GET  /__sim/state?run=&collection=            inspect the store
 *   GET  /__sim/events?run=&since=&limit=&collection=   store mutation log
 *   GET  /__sim/log?run=&since=&limit=            run log (requests, streams, actions)
 *   GET  /__sim/streams?run=
 *   POST /__sim/streams/disconnect {run?, id?|topic?|path?|all?, code?, reason?, drop?}
 *   POST /__sim/streams/pause {run?, id, paused}
 *   POST /__sim/publish {run?, topic, data}       publish a stream event by hand
 *   GET/POST/DELETE /__sim/overrides              {run?, matcher, method?, status?, body?, times?, delayMs?, malformed?}
 *   POST /__sim/faults  {run?, latencyMs?, jitterMs?, failMode?, shellPaths?}
 *   POST /__sim/action  {run?, name, args?}
 *   GET  /__sim/runs · DELETE /__sim/runs?run=
 *
 * Run selection per request: `X-Sim-Run` header → `sim_run` cookie →
 * `?__run=` → "default". Scenario for a *new* run: `X-Sim-Scenario` → cookie
 * → `?__scenario=` → `?scenario=` → default scenario.
 */

import type { ScenarioDefinition } from "./scenario.js";
import { Run } from "./scenario.js";
import { json, problem, type RouteContext } from "./router.js";
import type { StreamContext, WsRoute } from "./streams.js";
import type { OverrideInput } from "./faults.js";

export interface SimulatorOptions {
  scenarios: ScenarioDefinition[];
  defaultScenario?: string;
  /** Control-plane prefix (default `/__sim`). */
  controlPath?: string;
  /** Default run id (default `default`). */
  defaultRun?: string;
  /** Add permissive CORS headers (default true — the mock is a dev tool). */
  cors?: boolean;
  log?: (line: string) => void;
}

/** How an adapter completes a WebSocket upgrade for a matched route. */
export type UpgradeHook = (route: WsRoute, ctx: StreamContext, run: Run, protocol: string | null) => Response | Promise<Response>;

export interface HandleOptions {
  upgrade?: UpgradeHook;
}

export class Simulator {
  readonly scenarios = new Map<string, ScenarioDefinition>();
  readonly runs = new Map<string, Run>();
  readonly controlPath: string;
  readonly defaultRun: string;
  readonly defaultScenario: string;
  private readonly cors: boolean;
  private readonly log: (line: string) => void;

  constructor(options: SimulatorOptions) {
    if (options.scenarios.length === 0) throw new Error("at least one scenario is required");
    for (const s of options.scenarios) {
      if (this.scenarios.has(s.name)) throw new Error(`duplicate scenario ${s.name}`);
      this.scenarios.set(s.name, s);
    }
    this.defaultScenario = options.defaultScenario ?? options.scenarios[0]!.name;
    if (!this.scenarios.has(this.defaultScenario)) throw new Error(`unknown default scenario ${this.defaultScenario}`);
    this.controlPath = (options.controlPath ?? "/__sim").replace(/\/$/, "");
    this.defaultRun = options.defaultRun ?? "default";
    this.cors = options.cors ?? true;
    this.log = options.log ?? (() => {});
  }

  // ── runs ─────────────────────────────────────────────────────────

  private cookie(request: Request, name: string): string | null {
    const header = request.headers.get("cookie") ?? "";
    for (const part of header.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  }

  runIdFor(request: Request, url: URL): string {
    return request.headers.get("x-sim-run") ?? this.cookie(request, "sim_run") ?? url.searchParams.get("__run") ?? this.defaultRun;
  }

  scenarioNameFor(request: Request, url: URL): string {
    return request.headers.get("x-sim-scenario") ?? this.cookie(request, "sim_scenario") ?? url.searchParams.get("__scenario") ?? url.searchParams.get("scenario") ?? this.defaultScenario;
  }

  /** Get or lazily create the run for a request. */
  async runFor(request: Request, url: URL): Promise<Run> {
    const id = this.runIdFor(request, url);
    let run = this.runs.get(id);
    if (!run) {
      const name = this.scenarioNameFor(request, url);
      run = this.createRun(id, name);
    }
    await run.ready;
    return run;
  }

  createRun(id: string, scenarioName: string, seed?: string): Run {
    const scenario = this.scenarios.get(scenarioName);
    if (!scenario) throw new Error(`unknown scenario "${scenarioName}" (available: ${[...this.scenarios.keys()].join(", ")})`);
    this.runs.get(id)?.dispose();
    const run = new Run(id, scenario, seed ?? scenario.seed ?? scenario.name, this.log);
    this.runs.set(id, run);
    return run;
  }

  getRun(id = this.defaultRun): Run | null {
    return this.runs.get(id) ?? null;
  }

  // ── request handling ─────────────────────────────────────────────

  async handle(request: Request, options: HandleOptions = {}): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS" && this.cors) return this.withCors(request, new Response(null, { status: 204 }));
      if (url.pathname === this.controlPath || url.pathname.startsWith(`${this.controlPath}/`)) {
        return this.withCors(request, await this.control(request, url));
      }
      const run = await this.runFor(request, url);
      run.requests++;
      const path = url.pathname;
      const method = request.method.toUpperCase();

      // Overrides first: a forced answer for any path, even unrouted ones.
      const override = run.faults.matchOverride(path, method);
      if (override) {
        run.log(`${method} ${path} → override ${override.id}`, { status: override.status ?? null, malformed: override.malformed ?? null });
        await run.clock.sleep(run.faults.delayFor(override.delayMs ?? 0), `override ${override.id}`);
        return this.withCors(request, run.faults.overrideResponse(override));
      }

      // WebSocket routes. `Upgrade`/`Sec-WebSocket-Protocol` are forbidden
      // request headers in browsers (silently dropped), so adapters also send
      // `x-sim-upgrade` / `x-sim-websocket-protocol` mirrors.
      const upgradeHeader = request.headers.get("upgrade") ?? request.headers.get("x-sim-upgrade");
      if (upgradeHeader?.toLowerCase() === "websocket") {
        for (const route of run.wsRoutes) {
          const params = matchPath(route.path, path);
          if (!params) continue;
          if (!options.upgrade) return this.withCors(request, problem(426, "WebSocket upgrade requires a transport adapter"));
          const requested = (request.headers.get("sec-websocket-protocol") ?? request.headers.get("x-sim-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          const protocol = route.protocols?.find((p) => requested.includes(p)) ?? null;
          if (route.protocols?.length && requested.length && !protocol) return this.withCors(request, problem(400, `unsupported subprotocol (server offers ${route.protocols.join(", ")})`));
          const failed = run.faults.failResponse(path);
          if (failed) return this.withCors(request, failed);
          return options.upgrade(route, this.streamContext(run, request, url, params), run, protocol);
        }
        return this.withCors(request, problem(404, `no WebSocket route matches ${path}`));
      }

      // Fail mode (after overrides so a test can still force a success).
      const failed = run.faults.failResponse(path);
      if (failed) {
        run.log(`${method} ${path} → fail mode ${run.faults.failMode}`);
        await run.clock.sleep(run.faults.delayFor(), "fail-mode latency");
        return this.withCors(request, failed);
      }

      // SSE routes.
      for (const route of run.sseRoutes) {
        if ((route.method ?? "GET") !== method) continue;
        const params = matchPath(route.path, path);
        if (!params) continue;
        await run.clock.sleep(run.faults.delayFor(), "sse open latency");
        const stream = run.streams.openSse(route, this.streamContext(run, request, url, params));
        return this.withCors(request, stream.response);
      }

      // HTTP routes (definition order; first match wins).
      for (const route of run.routes) {
        if (route.method !== "*" && route.method !== method) continue;
        const params = route.match(path);
        if (!params) continue;
        route.calls++;
        const ctx = this.routeContext(run, request, url, params, route.calls);
        const started = run.clock.now();
        await run.clock.sleep(run.faults.delayFor(), `latency ${method} ${path}`);
        const response = await route.handler(ctx);
        run.log(`${method} ${path} → ${response.status}`, { route: route.name ?? route.path, ms: Math.round(run.clock.now() - started) });
        return this.withCors(request, response);
      }

      run.log(`${method} ${path} → 404 (no route)`);
      return this.withCors(request, problem(404, `scenario "${run.scenario.name}" has no route for ${method} ${path}`, { hint: `${this.controlPath}/status lists routes; set an override to force an answer` }));
    } catch (err) {
      this.log(`[sim] error handling ${request.method} ${url.pathname}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return this.withCors(request, problem(500, `simulator error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private routeContext(run: Run, request: Request, url: URL, params: Record<string, string>, calls: number): RouteContext {
    let parsed: Promise<unknown> | null = null;
    return {
      request,
      url,
      method: request.method.toUpperCase(),
      params,
      query: url.searchParams,
      body: <T,>() => {
        parsed ??= request
          .clone()
          .text()
          .then((t) => (t ? JSON.parse(t) : {}))
          .catch(() => ({}));
        return parsed as Promise<T>;
      },
      state: run.state,
      rng: run.rng,
      clock: run.clock,
      streams: run.streams,
      run: run.info(),
      calls,
      log: (m, d) => run.log(m, d),
    };
  }

  streamContext(run: Run, request: Request, url: URL, params: Record<string, string>): StreamContext {
    return { request, url, params, query: url.searchParams, state: run.state, rng: run.rng, clock: run.clock, streams: run.streams, run: run.info(), log: (m, d) => run.log(m, d) };
  }

  private withCors(request: Request, response: Response): Response {
    if (!this.cors) return response;
    const origin = request.headers.get("origin");
    if (!origin) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    headers.set("access-control-allow-headers", request.headers.get("access-control-request-headers") ?? "*");
    headers.set("access-control-expose-headers", "*");
    headers.set("vary", "origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  // ── control plane ────────────────────────────────────────────────

  private async control(request: Request, url: URL): Promise<Response> {
    const route = url.pathname.slice(this.controlPath.length).replace(/\/$/, "") || "/";
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "DELETE" ? {} : await request.clone().text().then((t) => (t ? (JSON.parse(t) as Record<string, unknown>) : {})).catch(() => ({} as Record<string, unknown>));
    const runId = String((body as { run?: string }).run ?? url.searchParams.get("run") ?? request.headers.get("x-sim-run") ?? this.cookie(request, "sim_run") ?? this.defaultRun);
    const api = this.api;
    const q = (k: string) => url.searchParams.get(k);
    const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));

    switch (`${method} ${route}`) {
      case "GET /":
        return json({ tool: "@omniaura/scenario-sim", controlPath: this.controlPath, defaultRun: this.defaultRun, defaultScenario: this.defaultScenario, runs: [...this.runs.keys()] });
      case "GET /scenarios":
        return json({ default: this.defaultScenario, scenarios: api.scenarios() });
      case "GET /status":
        return json(await api.status(runId));
      case "POST /select": {
        const b = body as { scenario?: string; seed?: string };
        if (!b.scenario) return problem(400, "scenario is required");
        return json(await api.select(runId, b.scenario, b.seed), { headers: { "set-cookie": `sim_scenario=${encodeURIComponent(b.scenario)}; Path=/; SameSite=Lax` } });
      }
      case "POST /reset":
        return json(await api.reset(runId, (body as { seed?: string }).seed));
      case "POST /step":
        return json(api.step(runId, num((body as { ms?: number }).ms ?? q("ms"), 1000)));
      case "POST /clock":
        return json(api.clock(runId, body as { mode?: "manual" | "realtime"; speed?: number }));
      case "GET /state":
        return json(api.state(runId, q("collection") ?? undefined));
      case "GET /events":
        return json(api.events(runId, { since: num(q("since"), 0), limit: num(q("limit"), 200), collection: q("collection") ?? undefined }));
      case "GET /log":
        return json(api.log(runId, { since: num(q("since"), 0), limit: num(q("limit"), 200) }));
      case "GET /streams":
        return json(api.streams(runId));
      case "POST /streams/disconnect": {
        const b = body as { id?: string; topic?: string; path?: string; all?: boolean; code?: number; reason?: string; drop?: boolean };
        return json(api.disconnect(runId, b, b));
      }
      case "POST /streams/pause": {
        const b = body as { id?: string; paused?: boolean };
        if (!b.id) return problem(400, "id is required");
        return json({ ok: api.pause(runId, b.id, b.paused ?? true) });
      }
      case "POST /publish": {
        const b = body as { topic?: string; data?: Record<string, unknown> };
        if (!b.topic) return problem(400, "topic is required");
        return json(api.publish(runId, b.topic, b.data ?? {}));
      }
      case "GET /overrides":
        return json(api.overrides(runId));
      case "POST /overrides": {
        const b = body as unknown as OverrideInput;
        if (!b.matcher) return problem(400, "matcher is required");
        return json(api.setOverride(runId, b));
      }
      case "DELETE /overrides": {
        const matcher = q("matcher");
        const id = q("id");
        return json(api.clearOverrides(runId, id ?? matcher ?? undefined, q("method") ?? undefined));
      }
      case "POST /faults":
        return json(api.faults(runId, body as Parameters<typeof api.faults>[1]));
      case "POST /action": {
        const b = body as { name?: string; args?: Record<string, unknown> };
        if (!b.name) return problem(400, "name is required");
        return json({ result: await api.action(runId, b.name, b.args ?? {}) });
      }
      case "GET /runs":
        return json(api.runs());
      case "DELETE /runs":
        return json({ deleted: api.deleteRun(runId) });
      default:
        return problem(404, `unknown control route ${method} ${route}`);
    }
  }

  /** In-process control API — the same operations the HTTP control plane offers. */
  readonly api = {
    scenarios: () =>
      [...this.scenarios.values()].map((s) => ({ name: s.name, label: s.label ?? null, description: s.description ?? null, seed: s.seed ?? s.name, tags: s.tags ?? [], clock: s.clock ?? { mode: "realtime" }, actions: Object.keys(s.actions ?? {}), qa: s.qa ?? null })),
    status: async (runId = this.defaultRun) => {
      const run = this.runs.get(runId);
      if (!run) return { run: runId, scenario: null, exists: false, defaultScenario: this.defaultScenario };
      await run.ready;
      return { exists: true, ...run.status() };
    },
    select: async (runId: string, scenario: string, seed?: string) => {
      const run = this.createRun(runId, scenario, seed);
      await run.ready;
      return run.status();
    },
    reset: async (runId: string, seed?: string) => {
      const existing = this.runs.get(runId);
      const run = this.createRun(runId, existing?.scenario.name ?? this.defaultScenario, seed ?? existing?.seed);
      await run.ready;
      return run.status();
    },
    step: (runId: string, ms: number) => {
      const run = this.require(runId);
      if (run.clock.mode !== "manual") run.clock.setMode("manual");
      const r = run.clock.step(ms);
      run.log(`step ${ms}ms → now ${r.now}`, { fired: r.fired.length });
      return { ...r, pending: run.clock.pending() };
    },
    clock: (runId: string, patch: { mode?: "manual" | "realtime"; speed?: number }) => {
      const run = this.require(runId);
      if (patch.speed !== undefined) run.clock.speed = Math.max(0.01, Number(patch.speed));
      if (patch.mode) run.clock.setMode(patch.mode);
      return { mode: run.clock.mode, speed: run.clock.speed, now: Math.round(run.clock.now()), pending: run.clock.pending() };
    },
    state: (runId: string, collection?: string) => {
      const run = this.require(runId);
      const snap = run.state.snapshot();
      return collection ? { run: runId, collection, items: snap[collection] ?? [] } : { run: runId, counts: run.state.counts(), collections: snap };
    },
    events: (runId: string, opts: { since?: number; limit?: number; collection?: string }) => {
      const run = this.require(runId);
      const events = run.state.events(opts);
      return { run: runId, last: run.state.lastSeq, count: events.length, events };
    },
    log: (runId: string, opts: { since?: number; limit?: number }) => ({ run: runId, entries: this.require(runId).logs(opts) }),
    streams: (runId: string) => {
      const run = this.require(runId);
      return { run: runId, connections: run.streams.list(), topics: run.streams.topics.topics().map((t) => ({ topic: t, last: run.streams.topics.last(t) })), latencyMs: run.streams.latencyMs };
    },
    disconnect: (runId: string, target: { id?: string; topic?: string; path?: string; all?: boolean }, opts: { code?: number; reason?: string; drop?: boolean } = {}) => {
      const run = this.require(runId);
      const closed = run.streams.disconnect(target, opts);
      run.log(`disconnect ${JSON.stringify(target)}`, { closed, drop: opts.drop ?? false });
      return { closed };
    },
    pause: (runId: string, id: string, paused: boolean) => this.require(runId).streams.pause(id, paused),
    publish: (runId: string, topic: string, data: Record<string, unknown>) => this.require(runId).streams.publish(topic, data),
    overrides: (runId: string) => ({ run: runId, overrides: this.require(runId).faults.listOverrides() }),
    setOverride: (runId: string, input: OverrideInput) => {
      const run = this.require(runId);
      const o = run.faults.setOverride(input);
      run.log(`override set ${o.id}`, { matcher: o.matcher, method: o.method ?? "*", status: o.status ?? null, times: o.times ?? null });
      return o;
    },
    clearOverrides: (runId: string, target?: string, method?: string) => {
      const run = this.require(runId);
      if (target) return { cleared: run.faults.clearOverride(target, method) };
      run.faults.clearOverrides();
      return { cleared: true };
    },
    faults: (runId: string, patch: { latencyMs?: number; jitterMs?: number; failMode?: "off" | "data" | "all"; shellPaths?: string[]; streamLatencyMs?: number }) => {
      const run = this.require(runId);
      run.faults.configure(patch);
      if (patch.streamLatencyMs !== undefined) run.streams.latencyMs = Math.max(0, patch.streamLatencyMs);
      run.log("faults configured", patch);
      return { ...run.faults.snapshot(), streamLatencyMs: run.streams.latencyMs };
    },
    action: (runId: string, name: string, args: Record<string, unknown> = {}) => this.require(runId).action(name, args),
    runs: () => [...this.runs.values()].map((r) => ({ id: r.id, scenario: r.scenario.name, seed: r.seed, requests: r.requests, createdWall: r.createdWall })),
    deleteRun: (runId: string) => {
      const run = this.runs.get(runId);
      if (!run) return false;
      run.dispose();
      this.runs.delete(runId);
      return true;
    },
  };

  private require(runId = this.defaultRun): Run {
    const run = this.runs.get(runId) ?? this.createRun(runId, this.defaultScenario);
    return run;
  }

  dispose() {
    for (const run of this.runs.values()) run.dispose();
    this.runs.clear();
  }
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const keys: string[] = [];
  const re = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg === "*") return "(?:.*)";
          if (seg.startsWith(":")) {
            keys.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "/?$",
  );
  const m = re.exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
  return params;
}
