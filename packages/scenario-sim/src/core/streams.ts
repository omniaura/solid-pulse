/**
 * Streams: topics with per-topic monotonic event ids and bounded replay, plus
 * SSE and WebSocket routes whose connections the control plane can list,
 * pause, disconnect or hard-drop. Transports are pluggable — a Bun/Node
 * server, Vite's http server, or an in-page fake WebSocket — and the scenario
 * code never sees the difference.
 */

import type { Rng } from "./rng.js";
import type { VirtualClock } from "./clock.js";
import type { Store } from "./store.js";

export interface TopicEvent {
  topic: string;
  /** Monotonic per topic, as a decimal string (matches how most protocols carry it). */
  eventID: string;
  t: number;
  data: Record<string, unknown>;
}

export class TopicLog {
  private seqs = new Map<string, number>();
  private logs = new Map<string, TopicEvent[]>();

  constructor(private now: () => number, public readonly retain = 500) {}

  publish(topic: string, data: Record<string, unknown>): TopicEvent {
    const seq = (this.seqs.get(topic) ?? 0) + 1;
    this.seqs.set(topic, seq);
    const event: TopicEvent = { topic, eventID: String(seq), t: this.now(), data };
    const log = this.logs.get(topic) ?? [];
    log.push(event);
    if (log.length > this.retain) log.splice(0, log.length - this.retain);
    this.logs.set(topic, log);
    return event;
  }

  last(topic: string): string {
    return String(this.seqs.get(topic) ?? 0);
  }

  /**
   * Events after `since`. `missed` is true when `since` predates the retained
   * window. `null`/`undefined` means "no resume point": live only, nothing is
   * replayed (what a fresh EventSource without Last-Event-ID gets). Pass "0"
   * to replay everything retained.
   */
  replay(topic: string, since: string | number | null | undefined): { events: TopicEvent[]; missed: boolean } {
    if (since === null || since === undefined || since === "") return { events: [], missed: false };
    const s = Number(since);
    const log = this.logs.get(topic) ?? [];
    const oldest = log[0] ? Number(log[0].eventID) : (this.seqs.get(topic) ?? 0) + 1;
    const missed = s > 0 && s < oldest - 1;
    return { events: log.filter((e) => Number(e.eventID) > s), missed };
  }

  topics(): string[] {
    return [...this.seqs.keys()];
  }

  clear() {
    this.seqs.clear();
    this.logs.clear();
  }
}

export interface StreamContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  state: Store;
  rng: Rng;
  clock: VirtualClock;
  streams: StreamHub;
  run: { id: string; scenario: string; seed: string };
  log(message: string, data?: unknown): void;
}

/** What a transport must provide for one WebSocket connection. */
export interface SocketTransport {
  send(data: string | ArrayBuffer): void;
  /** Graceful close with a close frame. */
  close(code?: number, reason?: string): void;
  /** Hard drop: no close frame; the client sees an abnormal close (1006). */
  drop(): void;
}

export type Serializer = (event: TopicEvent) => string;
const defaultSerializer: Serializer = (e) => JSON.stringify({ ...e.data, topic: e.topic, eventID: e.eventID });

interface Subscription {
  topic: string;
  serialize: Serializer;
}

interface ConnectionBase {
  id: string;
  kind: "ws" | "sse";
  path: string;
  url: URL;
  openedAt: number;
  sent: number;
  received: number;
  paused: boolean;
  subscriptions: Map<string, Subscription>;
  meta: Record<string, unknown>;
}

export interface SimSocket extends ConnectionBase {
  kind: "ws";
  protocol: string | null;
  readyState: "open" | "closed";
  send(data: string | ArrayBuffer | Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
  drop(): void;
  /** Replay `since` then stay subscribed; returns what was replayed. */
  subscribe(topic: string, opts?: { since?: string | number | null; serialize?: Serializer }): { replayed: number; missed: boolean; last: string };
  unsubscribe(topic: string): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export interface SimSseStream extends ConnectionBase {
  kind: "sse";
  lastEventId: string | null;
  /** Send one SSE message. Objects are JSON-encoded. */
  send(data: unknown, opts?: { event?: string; id?: string; retry?: number }): void;
  comment(text: string): void;
  close(): void;
  drop(): void;
  subscribe(topic: string, opts?: { since?: string | number | null; event?: (e: TopicEvent) => string }): { replayed: number; missed: boolean; last: string };
  unsubscribe(topic: string): void;
  onClose(cb: () => void): void;
  /** The Response to return to the client. */
  response: Response;
}

export interface WsRoute {
  kind: "ws";
  path: string;
  name?: string;
  /** Subprotocols the server will select from (first match with the client's list wins). */
  protocols?: string[];
  onOpen?(ctx: StreamContext, socket: SimSocket): void | Promise<void>;
  onMessage?(ctx: StreamContext, socket: SimSocket, data: string | ArrayBuffer): void | Promise<void>;
  onClose?(ctx: StreamContext, socket: SimSocket, code: number, reason: string): void;
}

export interface SseRoute {
  kind: "sse";
  path: string;
  name?: string;
  /** Some APIs open SSE with POST (request body = the prompt). Default GET. */
  method?: "GET" | "POST";
  /** Keepalive comment interval in virtual ms (default 15000; 0 disables). */
  keepaliveMs?: number;
  onOpen(ctx: StreamContext, stream: SimSseStream): void | Promise<void>;
}

export type StreamRoute = WsRoute | SseRoute;

export const ws = (path: string, def: Omit<WsRoute, "kind" | "path">): WsRoute => ({ kind: "ws", path, ...def });
export const sse = (path: string, onOpen: SseRoute["onOpen"], def: Omit<SseRoute, "kind" | "path" | "onOpen"> = {}): SseRoute => ({ kind: "sse", path, onOpen, ...def });

export interface ConnectionSummary {
  id: string;
  kind: "ws" | "sse";
  path: string;
  openedAt: number;
  sent: number;
  received: number;
  paused: boolean;
  topics: string[];
  protocol?: string | null;
  meta: Record<string, unknown>;
}

export class StreamHub {
  readonly topics: TopicLog;
  private connections = new Map<string, SimSocket | SimSseStream>();
  private nextId = 1;
  /** Extra virtual latency applied to every outgoing stream message. */
  latencyMs = 0;

  constructor(private clock: VirtualClock, private log: (message: string, data?: unknown) => void) {
    this.topics = new TopicLog(() => clock.now());
  }

  /** Publish to a topic: appended to the replay log and fanned out to subscribers. */
  publish(topic: string, data: Record<string, unknown>): TopicEvent {
    const event = this.topics.publish(topic, data);
    for (const conn of this.connections.values()) {
      const sub = conn.subscriptions.get(topic);
      if (!sub) continue;
      if (conn.kind === "ws") this.deliver(conn, sub.serialize(event));
      else this.deliverSse(conn, event, sub.serialize as unknown as (e: TopicEvent) => string);
    }
    return event;
  }

  private deliver(conn: SimSocket, payload: string) {
    if (conn.readyState !== "open") return;
    const doSend = () => {
      if (conn.readyState !== "open") return;
      if (conn.paused) {
        (conn.meta.__queued as string[] | undefined)?.push(payload) ?? (conn.meta.__queued = [payload]);
        return;
      }
      conn.send(payload);
    };
    if (this.latencyMs > 0) this.clock.after(this.latencyMs, doSend, `ws latency ${conn.id}`);
    else doSend();
  }

  private deliverSse(conn: SimSseStream, event: TopicEvent, eventName: (e: TopicEvent) => string) {
    const doSend = () => conn.send(event.data, { event: eventName(event), id: event.eventID });
    if (this.latencyMs > 0) this.clock.after(this.latencyMs, doSend, `sse latency ${conn.id}`);
    else doSend();
  }

  /** Called by a transport adapter once the WebSocket handshake completed. */
  openSocket(route: WsRoute, ctx: StreamContext, transport: SocketTransport, protocol: string | null): SimSocket {
    const id = `ws_${this.nextId++}`;
    const closeCbs: Array<(code: number, reason: string) => void> = [];
    const hub = this;
    const socket: SimSocket = {
      id,
      kind: "ws",
      path: route.path,
      url: ctx.url,
      openedAt: this.clock.now(),
      sent: 0,
      received: 0,
      paused: false,
      subscriptions: new Map(),
      meta: {},
      protocol,
      readyState: "open",
      send(data) {
        if (socket.readyState !== "open") return;
        socket.sent++;
        transport.send(typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data));
      },
      close(code = 1000, reason = "") {
        if (socket.readyState !== "open") return;
        socket.readyState = "closed";
        transport.close(code, reason);
        hub.finish(socket, code, reason, closeCbs);
      },
      drop() {
        if (socket.readyState !== "open") return;
        socket.readyState = "closed";
        transport.drop();
        hub.finish(socket, 1006, "dropped", closeCbs);
      },
      subscribe(topic, opts = {}) {
        const serialize = opts.serialize ?? defaultSerializer;
        socket.subscriptions.set(topic, { topic, serialize });
        const { events, missed } = hub.topics.replay(topic, opts.since);
        for (const e of events) hub.deliver(socket, serialize(e));
        return { replayed: events.length, missed, last: hub.topics.last(topic) };
      },
      unsubscribe(topic) {
        socket.subscriptions.delete(topic);
      },
      onClose(cb) {
        closeCbs.push(cb);
      },
    };
    this.connections.set(id, socket);
    this.log(`ws open ${id} ${route.path}`, { protocol });
    void Promise.resolve(route.onOpen?.(ctx, socket)).catch((err) => this.log(`ws onOpen threw ${id}`, String(err)));
    return socket;
  }

  /** Transport → hub: a client frame arrived. */
  receive(route: WsRoute, ctx: StreamContext, socket: SimSocket, data: string | ArrayBuffer) {
    if (socket.readyState !== "open") return;
    socket.received++;
    void Promise.resolve(route.onMessage?.(ctx, socket, data)).catch((err) => this.log(`ws onMessage threw ${socket.id}`, String(err)));
  }

  /** Transport → hub: the client closed. */
  clientClosed(route: WsRoute, ctx: StreamContext, socket: SimSocket, code: number, reason: string) {
    if (socket.readyState !== "open") return;
    socket.readyState = "closed";
    this.connections.delete(socket.id);
    this.log(`ws closed by client ${socket.id}`, { code, reason });
    route.onClose?.(ctx, socket, code, reason);
  }

  private finish(conn: SimSocket, code: number, reason: string, cbs: Array<(code: number, reason: string) => void>) {
    this.connections.delete(conn.id);
    this.log(`ws closed ${conn.id}`, { code, reason });
    for (const cb of cbs) cb(code, reason);
  }

  /** Build the SSE Response for a route; the adapter just returns it. */
  openSse(route: SseRoute, ctx: StreamContext): SimSseStream {
    const id = `sse_${this.nextId++}`;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const closeCbs: Array<() => void> = [];
    const hub = this;
    const lastEventId = ctx.request.headers.get("last-event-id") ?? ctx.query.get("lastEventId") ?? ctx.query.get("sinceEventID");
    let keepalive: { cancel(): void } | null = null;
    const teardown = () => {
      if (closed) return;
      closed = true;
      keepalive?.cancel();
      hub.connections.delete(id);
      hub.log(`sse closed ${id}`);
      for (const cb of closeCbs) cb();
    };
    const write = (chunk: string) => {
      if (closed || !controller) return;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        teardown();
      }
    };
    // `start` runs synchronously inside the constructor, so it only captures
    // the controller; the greeting, keepalive and onOpen run once `stream` exists.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        teardown();
      },
    });
    const stream: SimSseStream = {
      id,
      kind: "sse",
      path: route.path,
      url: ctx.url,
      openedAt: this.clock.now(),
      sent: 0,
      received: 0,
      paused: false,
      subscriptions: new Map(),
      meta: {},
      lastEventId,
      send(data, opts = {}) {
        if (closed) return;
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        const frame = [
          opts.event ? `event: ${opts.event}` : null,
          opts.id !== undefined ? `id: ${opts.id}` : null,
          opts.retry !== undefined ? `retry: ${opts.retry}` : null,
          ...payload.split("\n").map((line) => `data: ${line}`),
        ]
          .filter((l) => l !== null)
          .join("\n");
        if (stream.paused) {
          (stream.meta.__queued as string[] | undefined)?.push(frame + "\n\n") ?? (stream.meta.__queued = [frame + "\n\n"]);
          return;
        }
        stream.sent++;
        write(frame + "\n\n");
      },
      comment(text) {
        write(`: ${text}\n\n`);
      },
      close() {
        if (closed) return;
        try {
          controller?.close();
        } catch {
          // already closed
        }
        teardown();
      },
      drop() {
        if (closed) return;
        try {
          controller?.error(new Error("connection dropped"));
        } catch {
          // already errored
        }
        teardown();
      },
      subscribe(topic, opts = {}) {
        const eventName = opts.event ?? ((e: TopicEvent) => String(e.data.type ?? "message"));
        stream.subscriptions.set(topic, { topic, serialize: eventName as unknown as Serializer });
        const { events, missed } = hub.topics.replay(topic, opts.since ?? lastEventId);
        for (const e of events) stream.send(e.data, { event: eventName(e), id: e.eventID });
        return { replayed: events.length, missed, last: hub.topics.last(topic) };
      },
      unsubscribe(topic) {
        stream.subscriptions.delete(topic);
      },
      onClose(cb) {
        closeCbs.push(cb);
      },
      response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } }),
    };
    this.connections.set(id, stream);
    this.log(`sse open ${id} ${route.path}`, { lastEventId });
    write(`: scenario-sim ${id}\n\n`);
    const ka = route.keepaliveMs ?? 15_000;
    if (ka > 0) {
      const tick = () => {
        if (closed) return;
        write(":keepalive\n\n");
        keepalive = hub.clock.after(ka, tick, `sse keepalive ${id}`);
      };
      keepalive = hub.clock.after(ka, tick, `sse keepalive ${id}`);
    }
    void Promise.resolve(route.onOpen(ctx, stream)).catch((err) => hub.log(`sse onOpen threw ${id}`, String(err)));
    return stream;
  }

  // ── control plane ────────────────────────────────────────────────

  list(): ConnectionSummary[] {
    return [...this.connections.values()].map((c) => ({
      id: c.id,
      kind: c.kind,
      path: c.path,
      openedAt: c.openedAt,
      sent: c.sent,
      received: c.received,
      paused: c.paused,
      topics: [...c.subscriptions.keys()],
      ...(c.kind === "ws" ? { protocol: c.protocol } : {}),
      meta: Object.fromEntries(Object.entries(c.meta).filter(([k]) => !k.startsWith("__"))),
    }));
  }

  get(id: string) {
    return this.connections.get(id) ?? null;
  }

  /**
   * Disconnect connections: by id, by topic, by path, or all. `drop` cuts the
   * connection without a close frame (what a network blip looks like).
   */
  disconnect(target: { id?: string; topic?: string; path?: string; all?: boolean }, opts: { code?: number; reason?: string; drop?: boolean } = {}): string[] {
    const hit: string[] = [];
    for (const c of [...this.connections.values()]) {
      const matches = target.all || (target.id && c.id === target.id) || (target.topic && c.subscriptions.has(target.topic)) || (target.path && c.path === target.path);
      if (!matches) continue;
      hit.push(c.id);
      if (opts.drop) c.drop();
      else if (c.kind === "ws") c.close(opts.code ?? 1001, opts.reason ?? "disconnected by scenario control");
      else c.close();
    }
    return hit;
  }

  /** Pause delivery on a connection (messages queue); resume flushes them in order. */
  pause(id: string, paused: boolean): boolean {
    const c = this.connections.get(id);
    if (!c) return false;
    c.paused = paused;
    if (!paused) {
      const queued = (c.meta.__queued as string[] | undefined) ?? [];
      c.meta.__queued = [];
      for (const payload of queued) {
        if (c.kind === "ws") c.send(payload);
        else {
          c.sent++;
          // Raw frame already formatted.
          (c as unknown as { __raw?: (s: string) => void }).__raw?.(payload);
        }
      }
    }
    return true;
  }

  closeAll() {
    for (const c of [...this.connections.values()]) c.close();
    this.connections.clear();
  }
}
