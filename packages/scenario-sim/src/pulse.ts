/**
 * @omniaura/scenario-sim/pulse — expose the simulator's control plane as
 * `scenario.*` commands on a solid-pulse controller, so the panel's Scenarios
 * tab and the `solid-pulse` CLI drive exactly the same operations. Works with
 * an in-process Simulator (browser adapter) or a remote control URL (server /
 * Vite adapter).
 */

import type { Simulator } from "./core/engine.js";

interface ControllerLike {
  register(spec: { name: string; summary: string; args?: Record<string, string>; ui?: string }, handler: (args: Record<string, unknown>) => unknown | Promise<unknown>): void;
  unregister(name: string): void;
  has(name: string): boolean;
}

interface PulseLike {
  controller: ControllerLike;
  bus: { emit(kind: string, data: Record<string, unknown>): unknown };
}

export type ScenarioClient = { kind: "local"; sim: Simulator; run?: string } | { kind: "remote"; controlUrl: string; run?: string; fetch?: typeof fetch };

const UI = "Scenarios tab";

export function attachScenarioCommands(pulse: PulseLike, client: ScenarioClient): () => void {
  const runOf = (a: Record<string, unknown>) => (a.run === undefined ? client.run : String(a.run));
  const remote = async (method: string, route: string, body?: Record<string, unknown>, query?: Record<string, unknown>) => {
    if (client.kind !== "remote") throw new Error("remote call on a local client");
    const f = client.fetch ?? fetch;
    const url = new URL(`${client.controlUrl}${route}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await f(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw new Error(String(parsed.detail ?? parsed.error ?? `${res.status}`));
    return parsed;
  };
  const local = () => (client.kind === "local" ? client.sim.api : null);
  const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));
  const parseJson = (v: unknown) => (typeof v === "string" && /^[[{]/.test(v.trim()) ? (JSON.parse(v) as unknown) : v);

  const commands: Array<[{ name: string; summary: string; args?: Record<string, string>; ui?: string }, (a: Record<string, unknown>) => unknown | Promise<unknown>]> = [
    [{ name: "scenario.list", summary: "Scenarios the simulator knows.", ui: UI }, async () => local()?.scenarios() ?? ((await remote("GET", "/scenarios")) as { scenarios: unknown }).scenarios],
    [{ name: "scenario.status", summary: "Run status: scenario, seed, clock, state counts, streams, faults, routes.", args: { run: "run id" }, ui: UI }, async (a) => local()?.status(runOf(a)) ?? remote("GET", "/status", undefined, { run: runOf(a) })],
    [{ name: "scenario.select", summary: "Bind the run to a scenario with fresh state.", args: { name: "scenario name", seed: "optional seed", run: "run id" }, ui: UI }, async (a) => {
      const name = String(a.name ?? "");
      const seed = a.seed === undefined ? undefined : String(a.seed);
      const l = local();
      const result = l ? await l.select(runOf(a) ?? "default", name, seed) : await remote("POST", "/select", { scenario: name, seed, run: runOf(a) });
      pulse.bus.emit("pulse.note", { note: `scenario → ${name}${seed ? ` (seed ${seed})` : ""}` });
      return result;
    }],
    [{ name: "scenario.reset", summary: "Rebuild the run's scenario (same seed unless given).", args: { seed: "optional seed", run: "run id" }, ui: UI }, async (a) => {
      const seed = a.seed === undefined || a.seed === "" ? undefined : String(a.seed);
      const l = local();
      const result = l ? await l.reset(runOf(a) ?? "default", seed) : await remote("POST", "/reset", { seed, run: runOf(a) });
      pulse.bus.emit("pulse.note", { note: `scenario reset${seed ? ` (seed ${seed})` : ""}` });
      return result;
    }],
    [{ name: "scenario.step", summary: "Advance the run's virtual clock (switches it to manual mode).", args: { ms: "milliseconds (default 1000)", run: "run id" }, ui: UI }, async (a) => local()?.step(runOf(a) ?? "default", num(a.ms, 1000)) ?? remote("POST", "/step", { ms: num(a.ms, 1000), run: runOf(a) })],
    [{ name: "scenario.clock", summary: "Set clock mode/speed.", args: { mode: "manual|realtime", speed: "multiplier", run: "run id" }, ui: UI }, async (a) => {
      const patch = { mode: a.mode as "manual" | "realtime" | undefined, speed: a.speed === undefined ? undefined : Number(a.speed) };
      return local()?.clock(runOf(a) ?? "default", patch) ?? remote("POST", "/clock", { ...patch, run: runOf(a) });
    }],
    [{ name: "scenario.state", summary: "Inspect the run's state store (all collections or one).", args: { collection: "collection name", run: "run id" }, ui: UI }, async (a) => local()?.state(runOf(a) ?? "default", a.collection === undefined ? undefined : String(a.collection)) ?? remote("GET", "/state", undefined, { run: runOf(a), collection: a.collection })],
    [{ name: "scenario.events", summary: "Store mutation log (insert/update/remove/custom).", args: { since: "seq", limit: "max", collection: "filter", run: "run id" }, ui: UI }, async (a) => local()?.events(runOf(a) ?? "default", { since: num(a.since, 0), limit: num(a.limit, 100), collection: a.collection === undefined ? undefined : String(a.collection) }) ?? remote("GET", "/events", undefined, { run: runOf(a), since: a.since, limit: a.limit, collection: a.collection })],
    [{ name: "scenario.log", summary: "Run log: requests, streams, actions.", args: { since: "seq", limit: "max", run: "run id" }, ui: UI }, async (a) => local()?.log(runOf(a) ?? "default", { since: num(a.since, 0), limit: num(a.limit, 100) }) ?? remote("GET", "/log", undefined, { run: runOf(a), since: a.since, limit: a.limit })],
    [{ name: "scenario.streams", summary: "Open SSE/WebSocket connections and topics.", args: { run: "run id" }, ui: UI }, async (a) => local()?.streams(runOf(a) ?? "default") ?? remote("GET", "/streams", undefined, { run: runOf(a) })],
    [{ name: "scenario.disconnect", summary: "Close or hard-drop stream connections (by id, topic, path, or all).", args: { id: "connection id", topic: "topic", path: "route path", all: "true", drop: "true = no close frame", code: "close code", reason: "text", run: "run id" }, ui: UI }, async (a) => {
      const target = { id: a.id as string | undefined, topic: a.topic as string | undefined, path: a.path as string | undefined, all: a.all === true || a.all === "true" };
      const opts = { code: a.code === undefined ? undefined : Number(a.code), reason: a.reason as string | undefined, drop: a.drop === true || a.drop === "true" };
      return local()?.disconnect(runOf(a) ?? "default", target, opts) ?? remote("POST", "/streams/disconnect", { ...target, ...opts, run: runOf(a) });
    }],
    [{ name: "scenario.publish", summary: "Publish an event to a topic by hand.", args: { topic: "topic", data: "JSON object", run: "run id" }, ui: UI }, async (a) => {
      const data = (parseJson(a.data) as Record<string, unknown>) ?? {};
      return local()?.publish(runOf(a) ?? "default", String(a.topic), data) ?? remote("POST", "/publish", { topic: a.topic, data, run: runOf(a) });
    }],
    [{ name: "scenario.overrides", summary: "List endpoint overrides.", args: { run: "run id" }, ui: UI }, async (a) => local()?.overrides(runOf(a) ?? "default") ?? remote("GET", "/overrides", undefined, { run: runOf(a) })],
    [{ name: "scenario.override", summary: "Force an endpoint's answer (status/body/malformed, once or sticky).", args: { matcher: "path substring", method: "GET|POST|…", status: "number", body: "JSON", times: "auto-expire after N", delayMs: "ms", malformed: "invalid-json|wrong-content-type|truncated|empty-200|html-500|schema-drift", run: "run id" }, ui: UI }, async (a) => {
      const input = { matcher: String(a.matcher), method: a.method as string | undefined, status: a.status === undefined ? undefined : Number(a.status), body: parseJson(a.body), times: a.times === undefined ? undefined : Number(a.times), delayMs: a.delayMs === undefined ? undefined : Number(a.delayMs), malformed: a.malformed as never };
      return local()?.setOverride(runOf(a) ?? "default", input) ?? remote("POST", "/overrides", { ...input, run: runOf(a) });
    }],
    [{ name: "scenario.override.clear", summary: "Clear one override (by id/matcher) or all.", args: { matcher: "id or matcher", method: "method", run: "run id" }, ui: UI }, async (a) => local()?.clearOverrides(runOf(a) ?? "default", a.matcher as string | undefined, a.method as string | undefined) ?? remote("DELETE", "/overrides", undefined, { run: runOf(a), matcher: a.matcher, method: a.method })],
    [{ name: "scenario.faults", summary: "Set latency/jitter/fail mode/stream latency.", args: { latencyMs: "ms", jitterMs: "ms", failMode: "off|data|all", streamLatencyMs: "ms", run: "run id" }, ui: UI }, async (a) => {
      const patch = { latencyMs: a.latencyMs === undefined ? undefined : Number(a.latencyMs), jitterMs: a.jitterMs === undefined ? undefined : Number(a.jitterMs), failMode: a.failMode as "off" | "data" | "all" | undefined, streamLatencyMs: a.streamLatencyMs === undefined ? undefined : Number(a.streamLatencyMs) };
      return local()?.faults(runOf(a) ?? "default", patch) ?? remote("POST", "/faults", { ...patch, run: runOf(a) });
    }],
    [{ name: "scenario.action", summary: "Run a scenario-defined action (see scenario.status → actions).", args: { name: "action name", args: "JSON object", run: "run id" }, ui: UI }, async (a) => {
      const args = (parseJson(a.args) as Record<string, unknown>) ?? {};
      const l = local();
      return l ? { result: await l.action(runOf(a) ?? "default", String(a.name), args) } : remote("POST", "/action", { name: a.name, args, run: runOf(a) });
    }],
    [{ name: "scenario.runs", summary: "List isolated runs.", ui: UI }, async () => local()?.runs() ?? remote("GET", "/runs")],
  ];

  for (const [spec, handler] of commands) pulse.controller.register(spec, handler);
  return () => {
    for (const [spec] of commands) pulse.controller.unregister(spec.name);
  };
}
