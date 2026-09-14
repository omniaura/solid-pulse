/**
 * Bridge server (Node/Bun). Accepts page runtimes over WebSocket at
 * `<path>/ws`, mirrors their events into a per-client ring buffer, and exposes
 * a small HTTP API for CLIs and agents at `<path>/api/*`:
 *
 *   GET  /api/status                    server + connected clients
 *   GET  /api/clients
 *   GET  /api/commands?client=          the page's command contract
 *   POST /api/command {client?,name,args}   run a command in the page
 *   GET  /api/command?name=&args=<json>&client=   (curl-friendly)
 *   GET  /api/events?client=&since=&kinds=&limit=
 *   GET  /api/events/stream?client=&kinds=        SSE, one `pulse` event per PulseEvent
 *
 * Access: loopback only unless `allowRemote` is set — remote address and Host
 * header are both checked, so a LAN dev server does not leak instrumentation.
 */

import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { RingBuffer } from "../core/ring-buffer.js";
import { expandKinds, type PulseEvent } from "../core/events.js";
import type { CommandResult, CommandSpec } from "../core/controller.js";
import { DEFAULT_PATH, PROTOCOL_VERSION, isPageFrame, type ClientSummary, type CommandFrame } from "../core/protocol.js";

export interface BridgeServerOptions {
  /** URL prefix (default `/__pulse`). */
  path?: string;
  /** Accept non-loopback peers and hosts (default false). */
  allowRemote?: boolean;
  /** Per-client mirror buffer (default 5000 events). */
  bufferSize?: number;
  /** Command timeout in ms (default 10000). */
  commandTimeoutMs?: number;
  log?: (message: string) => void;
}

interface ClientState {
  ws: WebSocket;
  summary: ClientSummary;
  commands: CommandSpec[];
  buffer: RingBuffer<PulseEvent>;
  pending: Map<string, { resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>;
}

type EventListener = (clientId: string, events: PulseEvent[]) => void;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function hostIsLocal(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/^\[/, "").replace(/\]?(:\d+)?$/, "");
  return LOOPBACK.has(h) || h.endsWith(".localhost");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export class BridgeServer {
  readonly path: string;
  private clients = new Map<string, ClientState>();
  private wss: WebSocketServer;
  private listeners = new Set<EventListener>();
  private nextCommand = 1;
  private startedWall = Date.now();
  private opts: Required<Omit<BridgeServerOptions, "log">> & { log: (m: string) => void };

  constructor(options: BridgeServerOptions = {}) {
    this.path = (options.path ?? DEFAULT_PATH).replace(/\/$/, "");
    this.opts = {
      path: this.path,
      allowRemote: options.allowRemote ?? false,
      bufferSize: options.bufferSize ?? 5000,
      commandTimeoutMs: options.commandTimeoutMs ?? 10_000,
      log: options.log ?? (() => {}),
    };
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** Attach the WebSocket upgrade handler to an existing http server (e.g. Vite's). */
  attach(server: HttpServer) {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      if (url.split("?")[0] !== `${this.path}/ws`) return; // not ours (Vite HMR etc.)
      if (!this.isAllowed(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  isAllowed(req: IncomingMessage): boolean {
    if (this.opts.allowRemote) return true;
    const remote = req.socket.remoteAddress ?? "";
    return LOOPBACK.has(remote) && hostIsLocal(req.headers.host);
  }

  /** Connect middleware: handles `<path>/api/*`; returns false when the URL is not ours. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const raw = req.url ?? "";
    if (!raw.startsWith(`${this.path}/api`)) return false;
    void this.route(req, res).catch((err) => json(res, 500, { error: String(err instanceof Error ? err.message : err) }));
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    if (!this.isAllowed(req)) return json(res, 403, { error: "solid-pulse bridge is loopback-only (set allowRemote to override)" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.slice(`${this.path}/api`.length).replace(/\/$/, "") || "/";
    const method = req.method ?? "GET";
    const clientParam = url.searchParams.get("client") ?? undefined;

    if (route === "/status" && method === "GET") return json(res, 200, this.status());
    if (route === "/clients" && method === "GET") return json(res, 200, this.listClients());
    if (route === "/commands" && method === "GET") {
      const c = this.pick(clientParam);
      return c ? json(res, 200, { client: c.summary.clientId, commands: c.commands }) : json(res, 404, { error: this.noClientMessage(clientParam) });
    }
    if (route === "/command" && (method === "POST" || method === "GET")) {
      let name: string | undefined;
      let args: Record<string, unknown> = {};
      let client = clientParam;
      if (method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { client?: string; name?: string; args?: Record<string, unknown> };
        name = body.name;
        args = body.args ?? {};
        client = body.client ?? client;
      } else {
        name = url.searchParams.get("name") ?? undefined;
        const a = url.searchParams.get("args");
        args = a ? (JSON.parse(a) as Record<string, unknown>) : {};
      }
      if (!name) return json(res, 400, { error: "name is required" });
      const c = this.pick(client);
      if (!c) return json(res, 404, { error: this.noClientMessage(client) });
      const result = await this.command(c.summary.clientId, name, args);
      return json(res, result.ok ? 200 : 400, { client: c.summary.clientId, name, ...result });
    }
    if (route === "/events" && method === "GET") {
      const c = this.pick(clientParam);
      if (!c) return json(res, 404, { error: this.noClientMessage(clientParam) });
      const events = this.events(c.summary.clientId, {
        since: Number(url.searchParams.get("since") ?? 0),
        kinds: url.searchParams.get("kinds")?.split(",").filter(Boolean),
        limit: Number(url.searchParams.get("limit") ?? 200),
      });
      return json(res, 200, { client: c.summary.clientId, count: events.length, last: events.at(-1)?.seq ?? 0, events });
    }
    if (route === "/events/stream" && method === "GET") {
      const c = this.pick(clientParam);
      const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
      const kindSet = kinds && kinds.length ? expandKinds(kinds) : null;
      const target = c?.summary.clientId ?? clientParam;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`: solid-pulse stream client=${target ?? "*"}\n\n`);
      const listener: EventListener = (clientId, events) => {
        if (target && clientId !== target) return;
        for (const e of events) {
          if (kindSet && !kindSet.has(e.kind)) continue;
          res.write(`event: pulse\ndata: ${JSON.stringify({ client: clientId, ...e })}\n\n`);
        }
      };
      this.listeners.add(listener);
      const ka = setInterval(() => res.write(":keepalive\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ka);
        this.listeners.delete(listener);
      });
      return;
    }
    json(res, 404, { error: `unknown route ${method} ${route}` });
  }

  private noClientMessage(requested?: string) {
    return requested
      ? `no connected page with client id "${requested}" (see /api/clients)`
      : "no page connected to the bridge — open the app in a browser with solid-pulse enabled";
  }

  private onConnection(ws: WebSocket) {
    let state: ClientState | null = null;
    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isPageFrame(frame)) return;
      if (frame.type === "hello") {
        const existing = this.clients.get(frame.clientId);
        if (existing && existing.ws !== ws) existing.ws.close(4000, "replaced by a newer connection");
        state = {
          ws,
          summary: { clientId: frame.clientId, url: frame.url, title: frame.title, userAgent: frame.userAgent, connectedWall: Date.now(), lastSeenWall: Date.now(), events: 0, commands: frame.commands.length },
          commands: frame.commands,
          buffer: existing?.buffer ?? new RingBuffer<PulseEvent>(this.opts.bufferSize),
          pending: new Map(),
        };
        this.clients.set(frame.clientId, state);
        ws.send(JSON.stringify({ type: "welcome", clientId: frame.clientId, protocol: PROTOCOL_VERSION }));
        this.opts.log(`client connected ${frame.clientId} ${frame.url}`);
        return;
      }
      if (!state) return;
      state.summary.lastSeenWall = Date.now();
      if (frame.type === "commands") {
        state.commands = frame.commands;
        state.summary.commands = frame.commands.length;
      } else if (frame.type === "events") {
        const fresh: PulseEvent[] = [];
        for (const e of frame.events) {
          // Replayed history after a reconnect may repeat; keep the buffer monotonic.
          const last = state.buffer.size ? state.buffer.toArray().at(-1)!.seq : 0;
          if (e.seq <= last) continue;
          state.buffer.push(e);
          fresh.push(e);
        }
        state.summary.events += fresh.length;
        if (fresh.length) for (const l of this.listeners) l(state.summary.clientId, fresh);
      } else if (frame.type === "result") {
        const p = state.pending.get(frame.id);
        if (p) {
          clearTimeout(p.timer);
          state.pending.delete(frame.id);
          p.resolve(frame.result);
        }
      }
    });
    ws.on("close", () => {
      if (state && this.clients.get(state.summary.clientId)?.ws === ws) {
        this.clients.delete(state.summary.clientId);
        for (const p of state.pending.values()) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: "page disconnected" });
        }
        this.opts.log(`client disconnected ${state.summary.clientId}`);
      }
    });
  }

  /** Pick a client: explicit id, else the most recently seen. */
  pick(clientId?: string): ClientState | null {
    if (clientId) return this.clients.get(clientId) ?? null;
    let best: ClientState | null = null;
    for (const c of this.clients.values()) if (!best || c.summary.lastSeenWall > best.summary.lastSeenWall) best = c;
    return best;
  }

  listClients(): ClientSummary[] {
    return [...this.clients.values()].map((c) => c.summary);
  }

  status() {
    return { tool: "@omniaura/solid-pulse", protocol: PROTOCOL_VERSION, path: this.path, uptimeMs: Date.now() - this.startedWall, allowRemote: this.opts.allowRemote, clients: this.listClients() };
  }

  events(clientId: string, opts: { since?: number; kinds?: string[]; limit?: number } = {}): PulseEvent[] {
    const c = this.clients.get(clientId);
    if (!c) return [];
    const kinds = opts.kinds && opts.kinds.length ? expandKinds(opts.kinds) : null;
    const out = c.buffer.toArray().filter((e) => e.seq > (opts.since ?? 0) && (!kinds || kinds.has(e.kind)));
    const limit = opts.limit ?? 200;
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  command(clientId: string, name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    const c = this.clients.get(clientId);
    if (!c) return Promise.resolve({ ok: false, error: `client not connected: ${clientId}` });
    const id = `c${this.nextCommand++}`;
    const frame: CommandFrame = { type: "command", id, name, args };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        resolve({ ok: false, error: `command timed out after ${this.opts.commandTimeoutMs}ms` });
      }, this.opts.commandTimeoutMs);
      c.pending.set(id, {
        resolve: (result) => {
          // Keep the mirror in step with the page: a cleared page buffer must
          // not keep serving stale history to `events`.
          if (name === "events.clear" && result.ok) c.buffer.clear();
          resolve(result);
        },
        timer,
      });
      c.ws.send(JSON.stringify(frame));
    });
  }

  onEvents(listener: EventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    for (const c of this.clients.values()) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }
}

export interface StandaloneOptions extends BridgeServerOptions {
  port?: number;
  host?: string;
}

/** Run the bridge as its own process (for non-Vite setups): `solid-pulse bridge --port 4567`. */
export function startBridgeServer(options: StandaloneOptions = {}) {
  const bridge = new BridgeServer(options);
  const server = createServer((req, res) => {
    if (bridge.handleHttp(req, res)) return;
    json(res, 404, { error: "not found", hint: `${bridge.path}/api/status` });
  });
  bridge.attach(server);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4567;
  const ready = new Promise<{ url: string; port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ url: `http://${host}:${actual}${bridge.path}`, port: actual });
    });
  });
  return {
    bridge,
    server,
    ready,
    url: `http://${host}:${port}${bridge.path}`,
    close: () =>
      new Promise<void>((resolve) => {
        bridge.close();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        server.close(finish);
        // Keep-alive HTTP and open SSE connections would otherwise hold `close` open.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        setTimeout(finish, 500).unref?.();
      }),
  };
}
