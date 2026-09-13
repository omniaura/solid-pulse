/**
 * @omniaura/scenario-sim/browser — run the simulator *inside the page*: no
 * server, no CORS, works in a static build (demo islands, Playwright against
 * `vite preview`). Patches `fetch`, `WebSocket` and `EventSource` so calls
 * matching `match` are answered by the Simulator; everything else passes
 * through. Install this BEFORE @omniaura/solid-pulse so pulse still sees the
 * app's calls.
 */

import { isUpgraded, Simulator, upgradedResponse, type SimulatorOptions, type UpgradeHook } from "./core/engine.js";
import type { SocketTransport } from "./core/streams.js";

export interface BrowserSimulatorOptions extends SimulatorOptions {
  /** Which URLs the simulator answers (default: same-origin `/api/` + control path). */
  match?: (url: URL) => boolean;
  /** Base used to resolve relative URLs (default location.origin). */
  origin?: string;
  /** Fixed run id for this page (default "default"; use per-tab ids for isolation). */
  run?: string;
}

/** CloseEvent with code/reason even where the host's CloseEvent ignores its init dict. */
function makeCloseEvent(code: number, reason: string, wasClean: boolean): CloseEvent {
  let ev: CloseEvent;
  try {
    ev = new CloseEvent("close", { code, reason, wasClean });
  } catch {
    ev = new Event("close") as CloseEvent;
  }
  if (ev.code !== code) {
    Object.defineProperties(ev, {
      code: { value: code, enumerable: true },
      reason: { value: reason, enumerable: true },
      wasClean: { value: wasClean, enumerable: true },
    });
  }
  return ev;
}

/** A WebSocket the page can use that terminates inside the Simulator. */
class SimWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  protocol = "";
  extensions = "";
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readonly url: string;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private inbound: ((data: string | ArrayBuffer) => void) | null = null;
  private clientClose: ((code: number, reason: string) => void) | null = null;

  constructor(url: string | URL, protocols: string | string[] | undefined, private sim: Simulator, private runId: string) {
    super();
    this.url = String(url);
    const requested = protocols ? ([] as string[]).concat(protocols) : [];
    queueMicrotask(() => void this.connect(requested));
  }

  private async connect(requested: string[]) {
    const httpUrl = this.url.replace(/^ws/, "http");
    // Browsers drop `Upgrade`/`Sec-*` request headers; the engine also reads the x-sim-* mirrors.
    const headers: Record<string, string> = { "x-sim-upgrade": "websocket", "x-sim-run": this.runId };
    if (requested.length) headers["x-sim-websocket-protocol"] = requested.join(", ");
    const request = new Request(httpUrl, { headers });
    const upgrade: UpgradeHook = (route, ctx, run, protocol) => {
      const transport: SocketTransport = {
        send: (data) => {
          if (this.readyState !== 1) return;
          this.dispatch(new MessageEvent("message", { data }));
        },
        close: (code = 1000, reason = "") => this.finish(code, reason, true),
        drop: () => this.finish(1006, "", false),
      };
      this.protocol = protocol ?? "";
      this.readyState = 1;
      const sock = run.streams.openSocket(route, ctx, transport, protocol);
      this.inbound = (data) => run.streams.receive(route, ctx, sock, data);
      this.clientClose = (code, reason) => run.streams.clientClosed(route, ctx, sock, code, reason);
      this.dispatch(new Event("open"));
      return upgradedResponse();
    };
    const response = await this.sim.handle(request, { upgrade });
    if (!isUpgraded(response)) {
      this.dispatch(new Event("error"));
      this.finish(1006, `upgrade failed: ${response.status}`, false);
    }
  }

  private dispatch(ev: Event) {
    const handler = (this as unknown as Record<string, ((e: Event) => unknown) | null>)[`on${ev.type}`];
    handler?.call(this, ev);
    this.dispatchEvent(ev);
  }

  private finish(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch(makeCloseEvent(code, reason, wasClean));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
    if (typeof data === "string") this.inbound?.(data);
    else if (data instanceof ArrayBuffer) this.inbound?.(data);
    else if (ArrayBuffer.isView(data)) this.inbound?.(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    else void (data as Blob).arrayBuffer().then((b) => this.inbound?.(b));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.clientClose?.(code, reason);
    this.finish(code, reason, true);
  }
}

/** EventSource over the simulator's SSE routes (same semantics: GET, Last-Event-ID on reconnect). */
class SimEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  readonly url: string;
  readonly withCredentials: boolean;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  private lastEventId = "";
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private retryMs = 1000;

  constructor(url: string | URL, init: EventSourceInit | undefined, private sim: Simulator, private runId: string) {
    super();
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    void this.open();
  }

  private dispatch(ev: Event) {
    const handler = (this as unknown as Record<string, ((e: Event) => unknown) | null>)[`on${ev.type}`];
    handler?.call(this, ev);
    this.dispatchEvent(ev);
  }

  private async open() {
    if (this.readyState === 2) return;
    const headers: Record<string, string> = { accept: "text/event-stream", "x-sim-run": this.runId };
    if (this.lastEventId) headers["last-event-id"] = this.lastEventId;
    const response = await this.sim.handle(new Request(this.url, { headers }));
    if (this.readyState === 2) return;
    if (!response.ok || !response.body) {
      this.dispatch(new Event("error"));
      this.readyState = 2;
      return;
    }
    this.readyState = 1;
    this.dispatch(new Event("open"));
    this.reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
          this.frame(frame);
        }
      }
    } catch {
      // dropped
    }
    if (this.readyState === 2) return;
    // Auto-reconnect like a real EventSource.
    this.readyState = 0;
    this.dispatch(new Event("error"));
    setTimeout(() => void this.open(), this.retryMs);
  }

  private frame(frame: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") this.lastEventId = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
    if (data.length === 0) return;
    this.dispatch(new MessageEvent(event, { data: data.join("\n"), lastEventId: this.lastEventId }));
  }

  close() {
    this.readyState = 2;
    void this.reader?.cancel().catch(() => {});
  }
}

export function installBrowserSimulator(options: BrowserSimulatorOptions) {
  const sim = new Simulator(options);
  const origin = options.origin ?? location.origin;
  const controlPath = sim.controlPath;
  const runId = options.run ?? sim.defaultRun;
  const match = options.match ?? ((u: URL) => u.origin === origin && (u.pathname.startsWith("/api/") || u.pathname === controlPath || u.pathname.startsWith(`${controlPath}/`)));
  const g = globalThis as unknown as { fetch: typeof fetch; WebSocket: typeof WebSocket; EventSource?: typeof EventSource };
  const nativeFetch = g.fetch;
  const NativeWebSocket = g.WebSocket;
  const NativeEventSource = g.EventSource;

  g.fetch = function simFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const src = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const raw = src ? src.url : input instanceof URL ? input.href : String(input);
    let url: URL;
    try {
      url = new URL(raw, origin);
    } catch {
      return nativeFetch.call(this, input, init);
    }
    if (!match(url)) return nativeFetch.call(this, input, init);
    // Normalise into a fresh Request instead of constructing Request-from-Request:
    // some DOM implementations tee/await the source body and never settle.
    const method = (init?.method ?? src?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? src?.headers ?? undefined);
    if (!headers.has("x-sim-run")) headers.set("x-sim-run", runId);
    const bodyless = method === "GET" || method === "HEAD";
    const bodyP: Promise<BodyInit | null | undefined> = bodyless ? Promise.resolve(undefined) : init?.body !== undefined ? Promise.resolve(init.body) : src ? src.clone().text() : Promise.resolve(undefined);
    return bodyP.then((body) => sim.handle(new Request(url, { method, headers, body: body ?? undefined, signal: init?.signal ?? src?.signal ?? undefined })));
  } as typeof fetch;

  g.WebSocket = class extends SimWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const u = new URL(String(url), origin.replace(/^http/, "ws"));
      if (!match(new URL(u.href.replace(/^ws/, "http")))) {
        // Not ours: hand back a real socket.
        return new NativeWebSocket(url, protocols) as unknown as SimWebSocket;
      }
      super(u.href, protocols, sim, runId);
    }
  } as unknown as typeof WebSocket;

  // Installed even when the host has no EventSource (bun/happy-dom, some
  // workers): simulator routes work everywhere; foreign URLs need the native one.
  const ES = NativeEventSource;
  g.EventSource = class extends SimEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      const u = new URL(String(url), origin);
      if (!match(u)) {
        if (!ES) throw new Error(`EventSource is unavailable in this environment and ${u.href} is not simulated`);
        return new ES(url, init) as unknown as SimEventSource;
      }
      super(u.href, init, sim, runId);
    }
  } as unknown as typeof EventSource;

  return {
    sim,
    runId,
    controlUrl: `${origin}${controlPath}`,
    restore() {
      g.fetch = nativeFetch;
      g.WebSocket = NativeWebSocket;
      if (NativeEventSource) g.EventSource = NativeEventSource;
      else delete (g as { EventSource?: unknown }).EventSource;
      sim.dispose();
    },
  };
}

export { SimWebSocket, SimEventSource };
