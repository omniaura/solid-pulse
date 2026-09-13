#!/usr/bin/env node
/**
 * scenario-sim CLI — drive a running simulator's control plane, or serve one.
 *
 *   scenario-sim serve <scenarios.ts|.js> [--port 4100] [--host 127.0.0.1] [--scenario name]
 *   scenario-sim scenarios | status | state [collection=] | events [since=] | log | streams | runs | overrides
 *   scenario-sim select name=<scenario> [seed=] | reset [seed=] | step ms=1000 | clock mode=manual
 *   scenario-sim disconnect all=true drop=true | override matcher=/api/notes status=503 times=1 | faults latencyMs=800
 *   scenario-sim publish topic=notes data='{"type":"ping"}' | action name=<action> args='{}'
 *
 * Options: --url <http://host:port[/__sim]> (or SCENARIO_SIM_URL; default http://localhost:4100/__sim)
 *          --run <id>  --json
 */

const HELP = `scenario-sim — deterministic scenario simulator control

  scenario-sim serve <scenarios.(ts|js)> [--port 4100] [--host 127.0.0.1] [--scenario name]
  scenario-sim scenarios | status | state [collection=] | events [since=] | log | streams | runs | overrides
  scenario-sim select name=<scenario> [seed=] | reset [seed=] | step ms=1000 | clock mode=manual speed=2
  scenario-sim disconnect all=true drop=true | override matcher=/api/notes status=503 times=1 | override.clear
  scenario-sim faults latencyMs=800 failMode=data | publish topic=notes data='{"type":"ping"}' | action name=<a> args='{}'

Options: --url <http://host:port[/__sim]>  (or SCENARIO_SIM_URL; default http://localhost:4100/__sim)
         --run <id>   --json`;

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const kv: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[k] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") && !argv[i + 1]!.includes("=")) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else if (a.includes("=") && positional.length > 0) {
      const idx = a.indexOf("=");
      const v = a.slice(idx + 1);
      kv[a.slice(0, idx)] = /^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\}|".*")$/s.test(v) ? safeJson(v) : v;
    } else positional.push(a);
  }
  return { flags, positional, kv };
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

async function main() {
  const { flags, positional, kv } = parse(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || flags.help) return void process.stdout.write(HELP + "\n");

  if (cmd === "serve") {
    const file = positional[1];
    if (!file) throw new Error("serve needs a scenarios file");
    const { pathToFileURL } = await import("node:url");
    const { resolve } = await import("node:path");
    const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown; scenarios?: unknown };
    const scenarios = (Array.isArray(mod.default) ? mod.default : Array.isArray(mod.scenarios) ? mod.scenarios : (mod.default as { scenarios?: unknown })?.scenarios) as import("./core/scenario.js").ScenarioDefinition[] | undefined;
    if (!scenarios?.length) throw new Error("scenarios file must export an array (default or `scenarios`)");
    const { Simulator } = await import("./core/engine.js");
    const { serveSimulator } = await import("./server.js");
    const sim = new Simulator({ scenarios, defaultScenario: typeof flags.scenario === "string" ? flags.scenario : undefined, log: (l) => console.error(l) });
    const running = await serveSimulator(sim, { port: flags.port ? Number(flags.port) : 4100, host: typeof flags.host === "string" ? flags.host : "127.0.0.1", log: (l) => console.error(l) });
    console.error(`[scenario-sim] scenarios: ${scenarios.map((s) => s.name).join(", ")} · control ${running.controlUrl}/status`);
    await new Promise(() => {});
    return;
  }

  const base = (typeof flags.url === "string" ? flags.url : process.env.SCENARIO_SIM_URL ?? "http://localhost:4100/__sim").replace(/\/$/, "");
  const root = base.endsWith("/__sim") || /\/__[a-z]+$/.test(base) ? base : `${base}/__sim`;
  const run = typeof flags.run === "string" ? flags.run : undefined;
  const out = (v: unknown) => process.stdout.write((flags.json ? JSON.stringify(v) : JSON.stringify(v, null, 2)) + "\n");
  const call = async (method: string, route: string, body?: Record<string, unknown>, query?: Record<string, unknown>) => {
    const url = new URL(`${root}${route}`);
    if (run) url.searchParams.set("run", run);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify({ ...body, run }) : undefined });
    } catch (err) {
      throw new Error(`cannot reach simulator at ${root} (${(err as Error).message})`);
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : {};
    if (!res.ok) throw new Error(String((parsed as { detail?: string }).detail ?? text));
    return parsed;
  };

  switch (cmd) {
    case "scenarios": return out(await call("GET", "/scenarios"));
    case "status": return out(await call("GET", "/status"));
    case "state": return out(await call("GET", "/state", undefined, { collection: kv.collection }));
    case "events": return out(await call("GET", "/events", undefined, { since: kv.since, limit: kv.limit, collection: kv.collection }));
    case "log": return out(await call("GET", "/log", undefined, { since: kv.since, limit: kv.limit }));
    case "streams": return out(await call("GET", "/streams"));
    case "runs": return out(await call("GET", "/runs"));
    case "overrides": return out(await call("GET", "/overrides"));
    case "select": return out(await call("POST", "/select", { scenario: kv.name, seed: kv.seed }));
    case "reset": return out(await call("POST", "/reset", { seed: kv.seed }));
    case "step": return out(await call("POST", "/step", { ms: kv.ms ?? 1000 }));
    case "clock": return out(await call("POST", "/clock", { mode: kv.mode, speed: kv.speed }));
    case "disconnect": return out(await call("POST", "/streams/disconnect", kv));
    case "pause": return out(await call("POST", "/streams/pause", { id: kv.id, paused: kv.paused ?? true }));
    case "publish": return out(await call("POST", "/publish", { topic: kv.topic, data: kv.data ?? {} }));
    case "override": return out(await call("POST", "/overrides", kv));
    case "override.clear": return out(await call("DELETE", "/overrides", undefined, { matcher: kv.matcher, id: kv.id, method: kv.method }));
    case "faults": return out(await call("POST", "/faults", kv));
    case "action": return out(await call("POST", "/action", { name: kv.name, args: kv.args ?? {} }));
    case "delete-run": return out(await call("DELETE", "/runs"));
    default: throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

main().catch((err) => {
  process.stderr.write(`scenario-sim: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
