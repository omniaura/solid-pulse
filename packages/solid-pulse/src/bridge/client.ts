/**
 * Page-side bridge transport. Streams events to the bridge server in ≤50 ms
 * batches and executes commands the server relays from the CLI/agents. Any
 * command is just `controller.run(name, args)` — the same call the panel makes.
 */

import type { PulseController } from "../core/controller.js";
import { DEFAULT_PATH, PROTOCOL_VERSION, isServerFrame, type HelloFrame, type PageFrame } from "../core/protocol.js";
import type { PulseEvent } from "../core/events.js";

export interface BridgeClientOptions {
  /** ws(s):// URL. Default: same origin + /__pulse/ws. */
  url?: string;
  /** Reconnect delay in ms (default 2000). */
  reconnectMs?: number;
  /** Stable client id (default: random per page load, persisted in sessionStorage). */
  clientId?: string;
}

function defaultUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${DEFAULT_PATH}/ws`;
}

function clientIdFor(explicit?: string): string {
  if (explicit) return explicit;
  try {
    const existing = sessionStorage.getItem("solid-pulse:clientId");
    if (existing) return existing;
    const id = `tab-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem("solid-pulse:clientId", id);
    return id;
  } catch {
    return `tab-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: PulseEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private attempts = 0;
  private NativeWebSocket: typeof WebSocket;
  readonly url: string;
  readonly clientId: string;
  connected = false;

  constructor(private controller: PulseController, private options: BridgeClientOptions = {}) {
    this.url = options.url ?? defaultUrl();
    this.clientId = clientIdFor(options.clientId);
    // Grab the native constructor now: network instrumentation may wrap the
    // global later and we must not trace our own transport.
    this.NativeWebSocket = WebSocket;
  }

  connect() {
    if (this.ws || this.closed) return;
    try {
      const ws = new this.NativeWebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.attempts = 0;
        const hello: HelloFrame = {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          clientId: this.clientId,
          url: location.href,
          title: document.title,
          userAgent: navigator.userAgent,
          commands: this.controller.describe(),
          startedWall: this.controller.startedWall,
        };
        ws.send(JSON.stringify(hello));
        // Replay the buffer so a CLI that connects late still sees history.
        this.queue = this.controller.bus.list({ limit: 2000 });
        this.scheduleFlush();
        this.unsubscribe?.();
        this.unsubscribe = this.controller.bus.subscribe((e) => {
          this.queue.push(e);
          this.scheduleFlush();
        });
        this.controller.bus.emit("pulse.note", { note: `bridge connected ${this.url}` });
      };
      ws.onmessage = (ev) => void this.onMessage(ev.data);
      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (!this.closed) this.timer = setTimeout(() => this.connect(), this.nextDelay());
      };
      ws.onerror = () => ws.close();
    } catch {
      this.timer = setTimeout(() => this.connect(), this.nextDelay());
    }
  }

  /** Exponential backoff (base → 30 s) so a missing bridge does not spam the console. */
  private nextDelay() {
    const base = this.options.reconnectMs ?? 2000;
    return Math.min(30_000, base * 2 ** Math.min(this.attempts++, 6));
  }

  disconnect() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.unsubscribe?.();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 50);
  }

  private flush() {
    if (!this.ws || this.ws.readyState !== this.NativeWebSocket.OPEN || this.queue.length === 0) return;
    // Send in chunks so a replay of 2000 events never builds one huge frame.
    while (this.queue.length) {
      const chunk = this.queue.splice(0, 200);
      this.send({ type: "events", events: chunk });
    }
  }

  private send(frame: PageFrame) {
    if (!this.ws || this.ws.readyState !== this.NativeWebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private async onMessage(raw: unknown) {
    let frame: unknown;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isServerFrame(frame)) return;
    if (frame.type === "command") {
      const result = await this.controller.run(frame.name, frame.args ?? {});
      this.send({ type: "result", id: frame.id, result });
    }
  }
}
