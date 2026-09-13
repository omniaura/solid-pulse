/**
 * A scenario is a pure description: how to seed state, which HTTP routes and
 * streams exist, default faults and clock mode, and named actions the control
 * plane can trigger. A Run is one live instance of a scenario with a seed —
 * runs are isolated from each other (own state, clock, RNG, streams, faults).
 */

import { Rng } from "./rng.js";
import { VirtualClock, type ClockMode } from "./clock.js";
import { Store } from "./store.js";
import { StreamHub, type StreamRoute, type WsRoute, type SseRoute } from "./streams.js";
import { FaultLayer, type FailMode } from "./faults.js";
import { compileRoute, type CompiledRoute, type Route } from "./router.js";

export interface SetupContext {
  state: Store;
  rng: Rng;
  clock: VirtualClock;
  streams: StreamHub;
  run: { id: string; scenario: string; seed: string };
  log(message: string, data?: unknown): void;
}

export interface ActionContext extends SetupContext {
  args: Record<string, unknown>;
}

export interface ScenarioDefinition {
  /** URL-safe identifier. */
  name: string;
  label?: string;
  description?: string;
  /** Default seed (default: the scenario name). Runs may override. */
  seed?: string;
  clock?: { mode?: ClockMode; speed?: number };
  faults?: { latencyMs?: number; jitterMs?: number; failMode?: FailMode; shellPaths?: string[] };
  tags?: string[];
  /** Seed the store. Runs once per run creation/reset, with the run's RNG. */
  setup?(ctx: SetupContext): void | Promise<void>;
  routes?: Route[];
  streams?: StreamRoute[];
  /**
   * Named actions exposed as `POST /__sim/action {name,args}` — and therefore
   * as `scenario.action` in the pulse panel/CLI. Use them for "emit a burst",
   * "complete the running job", "drop the stream mid-turn".
   */
  actions?: Record<string, (ctx: ActionContext) => unknown | Promise<unknown>>;
  /** Hints for QA harnesses (routes worth rendering, expected error states…). */
  qa?: Record<string, unknown>;
}

export function defineScenario(def: ScenarioDefinition): ScenarioDefinition {
  if (!/^[a-zA-Z0-9._-]+$/.test(def.name)) throw new Error(`scenario name must be URL-safe: ${def.name}`);
  return def;
}

export interface RunLogEntry {
  seq: number;
  t: number;
  message: string;
  data?: unknown;
}

export class Run {
  readonly rng: Rng;
  readonly clock: VirtualClock;
  readonly state: Store;
  readonly streams: StreamHub;
  readonly faults: FaultLayer;
  readonly routes: CompiledRoute[];
  readonly wsRoutes: WsRoute[];
  readonly sseRoutes: SseRoute[];
  readonly createdWall = Date.now();
  requests = 0;
  private logEntries: RunLogEntry[] = [];
  private logSeq = 0;
  ready: Promise<void>;

  constructor(
    public readonly id: string,
    public readonly scenario: ScenarioDefinition,
    public readonly seed: string,
    private readonly sink?: (line: string) => void,
  ) {
    this.rng = new Rng(seed);
    this.clock = new VirtualClock(scenario.clock?.mode ?? "realtime", scenario.clock?.speed ?? 1);
    this.state = new Store(() => this.clock.now());
    this.streams = new StreamHub(this.clock, (m, d) => this.log(m, d));
    this.faults = new FaultLayer(this.rng.fork("faults"));
    if (scenario.faults) this.faults.configure(scenario.faults);
    this.routes = (scenario.routes ?? []).map(compileRoute);
    this.wsRoutes = (scenario.streams ?? []).filter((s): s is WsRoute => s.kind === "ws");
    this.sseRoutes = (scenario.streams ?? []).filter((s): s is SseRoute => s.kind === "sse");
    this.ready = Promise.resolve(scenario.setup?.(this.setupContext())).then(() => this.log(`run ready (${scenario.name}, seed ${seed})`));
  }

  info() {
    return { id: this.id, scenario: this.scenario.name, seed: this.seed };
  }

  setupContext(): SetupContext {
    return { state: this.state, rng: this.rng, clock: this.clock, streams: this.streams, run: this.info(), log: (m, d) => this.log(m, d) };
  }

  log(message: string, data?: unknown) {
    const entry: RunLogEntry = { seq: ++this.logSeq, t: Math.round(this.clock.now()), message, ...(data !== undefined ? { data } : {}) };
    this.logEntries.push(entry);
    if (this.logEntries.length > 2000) this.logEntries.splice(0, this.logEntries.length - 2000);
    this.sink?.(`[sim ${this.id}] ${message}`);
  }

  logs(opts: { since?: number; limit?: number } = {}): RunLogEntry[] {
    const out = this.logEntries.filter((e) => e.seq > (opts.since ?? 0));
    const limit = opts.limit ?? 200;
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  async action(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const fn = this.scenario.actions?.[name];
    if (!fn) throw new Error(`unknown action "${name}" (available: ${Object.keys(this.scenario.actions ?? {}).join(", ") || "none"})`);
    this.log(`action ${name}`, args);
    return fn({ ...this.setupContext(), args });
  }

  status() {
    return {
      run: this.id,
      scenario: this.scenario.name,
      label: this.scenario.label ?? null,
      seed: this.seed,
      createdWall: this.createdWall,
      requests: this.requests,
      clock: { mode: this.clock.mode, speed: this.clock.speed, now: Math.round(this.clock.now()), wall: this.clock.iso(), pending: this.clock.pending() },
      state: { collections: this.state.counts(), lastSeq: this.state.lastSeq },
      streams: this.streams.list(),
      topics: this.streams.topics.topics().map((t) => ({ topic: t, last: this.streams.topics.last(t) })),
      faults: this.faults.snapshot(),
      routes: this.routes.map((r) => ({ method: r.method, path: r.path, calls: r.calls, name: r.name ?? null })),
      streamRoutes: [...this.wsRoutes.map((r) => ({ kind: "ws", path: r.path, protocols: r.protocols ?? [] })), ...this.sseRoutes.map((r) => ({ kind: "sse", path: r.path, method: r.method ?? "GET" }))],
      actions: Object.keys(this.scenario.actions ?? {}),
    };
  }

  dispose() {
    this.streams.closeAll();
    this.clock.clear();
    this.log("run disposed");
  }
}
