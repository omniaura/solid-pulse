#!/usr/bin/env node
/**
 * solid-pulse CLI — the agent's hands. Every panel control is a command here.
 *
 *   solid-pulse status                         bridge + connected pages
 *   solid-pulse commands                       the page's command contract (name, args, panel equivalent)
 *   solid-pulse events [since=N] [kinds=dom,query] [limit=50]
 *   solid-pulse tail [kinds=...]               follow events live (SSE)
 *   solid-pulse <command> [key=value ...]      run any controller command, e.g.
 *       solid-pulse features.set name=flash on=false
 *       solid-pulse inspect.element selector='[data-testid=composer]'
 *       solid-pulse scenario.select name=chat-stream-drop
 *   solid-pulse bridge [--port 4567]           standalone bridge server (non-Vite apps)
 *
 * Options: --url <http://host:port[/__pulse]>  (or SOLID_PULSE_URL; default auto-discovery
 *          via node_modules/.vite/solid-pulse.json, then http://localhost:3000)
 *          --client <id>   --json   --path </__pulse>
 * Values that parse as JSON (true, 3, [..], {..}, "..") are sent typed; others as strings.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PATH } from "../core/protocol.js";

const HELP = `solid-pulse — agent-controllable devtools for SolidJS apps (every panel control is a command here)

  solid-pulse status                         bridge + connected pages
  solid-pulse commands                       the page's command contract (name, args, panel equivalent)
  solid-pulse events [since=N] [kinds=dom,query] [limit=50]
  solid-pulse tail [kinds=...]               follow events live (SSE)
  solid-pulse <command> [key=value ...]      run any controller command, e.g.
      solid-pulse features.set name=flash on=false
      solid-pulse inspect.element selector='[data-testid=composer]'
      solid-pulse scenario.select name=chat-stream-drop
  solid-pulse bridge [--port 4567]           standalone bridge server (non-Vite apps)

Options: --url <http://host:port[/__pulse]>  (or SOLID_PULSE_URL; default auto-discovery via
         node_modules/.vite/solid-pulse.json, then http://localhost:3000)
         --client <id>   --json   --path </__pulse>
Values that parse as JSON (true, 3, [..], {..}, "..") are sent typed; others as strings.`;

interface Parsed {
  flags: Record<string, string | boolean>;
  positional: string[];
  kv: Record<string, unknown>;
}

function parseArgs(argv: string[]): Parsed {
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
      kv[a.slice(0, idx)] = coerce(a.slice(idx + 1));
    } else positional.push(a);
  }
  return { flags, positional, kv };
}

function coerce(v: string): unknown {
  if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\}|".*")$/s.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function discoverUrl(flag: string | boolean | undefined, path: string): string {
  if (typeof flag === "string") return flag.replace(/\/$/, "").endsWith(path) ? flag.replace(/\/$/, "") : `${flag.replace(/\/$/, "")}${path}`;
  if (process.env.SOLID_PULSE_URL) return process.env.SOLID_PULSE_URL.replace(/\/$/, "");
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = join(dir, "node_modules", ".vite", "solid-pulse.json");
    if (existsSync(f)) {
      try {
        const data = JSON.parse(readFileSync(f, "utf8")) as { url?: string };
        if (data.url) return data.url.replace(/\/$/, "");
      } catch {
        // fall through
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return `http://localhost:3000${path}`;
}

async function api(base: string, route: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}/api${route}`, init);
  } catch (err) {
    throw new Error(`cannot reach bridge at ${base} — is the dev server (with the solid-pulse Vite plugin) or 'solid-pulse bridge' running? (${(err as Error).message})`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body;
}

export function fmtEvent(e: { seq: number; t: number; kind: string; component?: { name: string } | null; data: Record<string, unknown>; truncated?: boolean }): string {
  if (e.truncated) return '#' + e.seq + ' ' + e.kind + ' [truncated] ' + JSON.stringify(e.data).slice(0, 160);
  const d = e.data;
  const comp = e.component?.name ? ` <${e.component.name}>` : "";
  let summary = "";
  switch (true) {
    case e.kind === "solid.flush":
      summary = `${d.computations} computations ${JSON.stringify(d.byKind)} in ${JSON.stringify(d.components)}`;
      break;
    case e.kind.startsWith("solid.component"):
      summary = `${d.name}${d.hydrated ? " (hydrated)" : ""}${d.gapMs !== undefined ? ` gap=${d.gapMs}ms` : ""}${d.lifetimeMs !== undefined ? ` lived=${d.lifetimeMs}ms` : ""}`;
      break;
    case e.kind === "dom.mutation": {
      const s = (d.summary as Array<{ tag: string; types: string[]; testId?: string; id?: string }>) ?? [];
      summary = `${d.targets} targets: ${s.slice(0, 4).map((x) => `${x.tag}${x.id ? "#" + x.id : ""}${x.testId ? `[${x.testId}]` : ""}(${x.types.join("+")})`).join(" ")}${s.length > 4 ? " …" : ""} [${d.attributedTo}]`;
      break;
    }
    case e.kind === "dom.reattach": {
      const el = d.element as { tag: string; testId?: string; classes?: string };
      const resets = (d.scrollReset as Array<{ reset: boolean; before: number; after: number }>).filter((r) => r.reset);
      summary = `${el.tag}${el.testId ? `[${el.testId}]` : el.classes ? "." + el.classes.split(" ")[0] : ""} gap=${d.gapMs}ms${resets.length ? ` SCROLL RESET ${resets.map((r) => `${r.before}→${r.after}`).join(",")}` : ""}${d.focusLost ? " FOCUS LOST" : ""}${d.suspenseInChain ? " (Suspense in chain)" : ""}`;
      break;
    }
    case e.kind === "dom.detach": {
      const el = d.element as { tag: string; testId?: string };
      summary = `${el.tag}${el.testId ? `[${el.testId}]` : ""} scrollers=${(d.scrollers as unknown[]).length}${d.hadFocus ? " had focus" : ""}`;
      break;
    }
    case e.kind.startsWith("net.fetch"):
      summary = `${d.method} ${d.url}${d.status !== undefined ? ` → ${d.status} ${d.ms}ms${d.sse ? " (SSE)" : ""}` : ""}${d.message ? ` ✗ ${d.message}` : ""}`;
      break;
    case e.kind.startsWith("net.ws"):
      summary = `${d.url} ${d.state ?? d.dir ?? ""}${d.type ? ` type=${d.type}` : ""}${d.code !== undefined ? ` code=${d.code}` : ""}`;
      break;
    case e.kind.startsWith("net.sse"):
      summary = `${d.url} ${d.event ?? ""}${d.messages !== undefined ? ` messages=${d.messages}` : ""}`;
      break;
    case e.kind.startsWith("query") || e.kind.startsWith("mutation"):
      summary = `${d.label ?? ""} ${d.role ?? d.trigger ?? d.action ?? ""}${d.ms !== undefined && d.ms !== null ? ` ${d.ms}ms` : ""}${d.message ? ` ✗ ${d.message}` : ""}`;
      break;
    case e.kind === "focus.lost":
      summary = `${(d.element as { tag: string }).tag} — ${d.cause}`;
      break;
    default:
      summary = JSON.stringify(d).slice(0, 160);
  }
  return `${String(e.seq).padStart(6)} ${(e.t / 1000).toFixed(3).padStart(9)}s ${e.kind.padEnd(24)}${comp} ${summary}`;
}

async function main() {
  const { flags, positional, kv } = parseArgs(process.argv.slice(2));
  const path = typeof flags.path === "string" ? flags.path : DEFAULT_PATH;
  const asJson = flags.json === true;
  const client = typeof flags.client === "string" ? flags.client : undefined;
  const cmd = positional[0];

  if (!cmd || flags.help === true || cmd === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }

  if (cmd === "bridge") {
    const { startBridgeServer } = await import("./server.js");
    const port = flags.port ? Number(flags.port) : 4567;
    const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
    const running = startBridgeServer({ port, host, path, allowRemote: flags["allow-remote"] === true, log: (m) => console.error(`[solid-pulse] ${m}`) });
    const { url } = await running.ready;
    console.error(`[solid-pulse] bridge listening at ${url}/api/status — page: initPulse({ bridge: "${url.replace(/^http/, "ws")}/ws" })`);
    await new Promise(() => {});
    return;
  }

  const base = discoverUrl(flags.url, path);
  const q = (extra: Record<string, unknown>) => {
    const p = new URLSearchParams();
    if (client) p.set("client", client);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const out = (v: unknown) => process.stdout.write((asJson ? JSON.stringify(v) : JSON.stringify(v, null, 2)) + "\n");

  switch (cmd) {
    case "status":
      return out(await api(base, "/status"));
    case "clients":
      return out(await api(base, "/clients"));
    case "commands": {
      const r = (await api(base, `/commands${q({})}`)) as { commands: Array<{ name: string; summary: string; args?: Record<string, string>; ui?: string }> };
      if (asJson) return out(r);
      for (const c of r.commands) {
        process.stdout.write(`${c.name.padEnd(22)} ${c.summary}\n`);
        if (c.args) for (const [k, v] of Object.entries(c.args)) process.stdout.write(`${"".padEnd(24)}${k}=… ${v}\n`);
        if (c.ui) process.stdout.write(`${"".padEnd(24)}panel: ${c.ui}\n`);
      }
      return;
    }
    case "events": {
      const r = (await api(base, `/events${q({ since: kv.since, kinds: kv.kinds, limit: kv.limit ?? 50 })}`)) as { events: Parameters<typeof fmtEvent>[0][]; dropped?: number };
      if (r.dropped) process.stderr.write('bridge dropped ' + r.dropped + ' events; use events.list for page history\n');
      if (asJson) return out(r);
      for (const e of r.events) process.stdout.write(fmtEvent(e) + "\n");
      return;
    }
    case "tail": {
      const res = await fetch(`${base}/api/events/stream${q({ kinds: kv.kinds })}`);
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let lastDropped = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('live tail disconnected; reconnect and use events.list to inspect page history (sequence gaps may exist)');
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as Parameters<typeof fmtEvent>[0] & { dropped?: number };
          if (e.dropped && e.dropped > lastDropped) { process.stderr.write('bridge dropped ' + e.dropped + ' events; use events.list for page history\n'); lastDropped = e.dropped; }
          process.stdout.write((asJson ? JSON.stringify(e) : fmtEvent(e)) + "\n");
        }
      }
      return;
    }
    case "run":
    default: {
      const name = cmd === "run" ? positional[1] : cmd;
      if (!name) throw new Error("run needs a command name");
      const r = await api(base, "/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client, name, args: kv }) });
      return out(r);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`solid-pulse: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
