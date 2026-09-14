/**
 * Network lifecycle. `fetch`, `WebSocket` and `EventSource` are wrapped so we
 * see start/end/error, streaming responses (SSE detected by content-type and
 * counted frame by frame), socket open/message/close, and aborts. URLs are
 * redacted; bodies are never captured unless the `captureBodies` feature is on,
 * and even then are truncated.
 *
 * If an in-page simulator also patches these globals, install it *before*
 * pulse so pulse wraps the simulator and still sees app-level calls.
 */

import type { PulseController } from "../core/controller.js";
import { redactText, redactUrl } from "../core/redact.js";
import type { SolidInstrumentation } from "./instrument.js";

const MAX_BODY_CHARS = 2000;
const MAX_INDIVIDUAL_STREAM_MESSAGES = 200;

export interface NetworkInstrumentation {
  dispose(): void;
}

function bodySize(body: unknown): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString().length;
  return null;
}

function messageType(data: unknown): string | null {
  if (typeof data !== "string" || data.length > 65536 || data[0] !== "{") return null;
  const m = /"type"\s*:\s*"([^"]{1,80})"/.exec(data);
  return m ? m[1]! : null;
}

function preview(data: unknown, on: boolean): string | undefined {
  if (!on) return undefined;
  if (typeof data === "string") return redactText(data.length > MAX_BODY_CHARS ? data.slice(0, MAX_BODY_CHARS) + "…" : data);
  return undefined;
}

export interface NetworkOptions {
  /** URLs to leave untraced (e.g. the devtools' own bridge). */
  ignoreUrl?: (url: string) => boolean;
}

export function installNetwork(controller: PulseController, solid: SolidInstrumentation | null, options: NetworkOptions = {}): NetworkInstrumentation {
  const bus = controller.bus;
  const ignored = (url: string) => options.ignoreUrl?.(url) === true;
  let nextId = 1;
  const g = globalThis as unknown as { fetch: typeof fetch; WebSocket: typeof WebSocket; EventSource?: typeof EventSource };
  const origFetch = g.fetch;
  const NativeWebSocket = g.WebSocket;
  const NativeEventSource = g.EventSource;

  // ── fetch ────────────────────────────────────────────────────────

  function wrapSse(res: Response, id: number, url: string): Response {
    if (!res.body) return res;
    let count = 0;
    let carry = "";
    let discarded = 0;
    const decoder = new TextDecoder();
    const startedAt = performance.now();
    const reader = res.body.getReader();
    bus.emit("net.sse.open", { id, url, transport: "fetch" });
    const scan = (chunk: Uint8Array) => {
      const decoded = decoder.decode(chunk, { stream: true });
      for (let offset = 0; offset < decoded.length; offset += 8192) {
      carry += decoded.slice(offset, offset + 8192);
      let idx: number;
      while ((idx = carry.search(/\r?\n\r?\n/)) >= 0) {
        const frame = carry.slice(0, idx);
        carry = carry.slice(idx).replace(/^\r?\n\r?\n/, "");
        const truncated = discarded > 0;
        const bytes = frame.length + discarded;
        discarded = 0;
        if (!truncated && (!frame.trim() || frame.startsWith(":"))) continue;
        count++;
        const evt = /^event:\s?(.*)$/m.exec(frame)?.[1] ?? "message";
        if (count <= MAX_INDIVIDUAL_STREAM_MESSAGES || count % 50 === 0) {
          bus.emit("net.sse.message", { id, url, event: evt, n: count, bytes, truncated, transport: "fetch", preview: truncated ? '[oversize frame]' : preview(frame, controller.isOn("captureBodies")) });
        }
      }
      if (carry.length > 65536) { discarded += carry.length - 3; carry = carry.slice(-3); }
      }
    };
    const done = () => bus.emit("net.sse.close", { id, url, messages: count, ms: Math.round(performance.now() - startedAt), transport: "fetch" });
    // A manual pump (not pipeThrough) so the same bytes flow to the app
    // unchanged and no TransformStream implementation mismatch can bite.
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        const { value, done: finished } = await reader.read();
        if (finished) {
          done();
          ctl.close();
          return;
        }
        scan(value);
        ctl.enqueue(value);
      },
      cancel(reason) {
        done();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  const pulseFetch = function pulseFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!controller.isOn("network")) return origFetch.call(this, input, init);
    const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const rawUrl = req ? req.url : input instanceof URL ? input.href : String(input);
    if (ignored(rawUrl)) return origFetch.call(this, input, init);
    const id = nextId++;
    const url = redactUrl(rawUrl);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const start = performance.now();
    const component = solid?.currentComponent() ?? null;
    let aborted = false;
    const signal = init?.signal ?? req?.signal;
    const onAbort = () => { aborted = true; };
    if (signal) {
      if (signal.aborted) aborted = true;
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    bus.emit("net.fetch.start", { id, method, url, bodyBytes: bodySize(init?.body), preview: preview(init?.body, controller.isOn("captureBodies")) }, { component });
    return origFetch.call(this, input, init).then(
      (res: Response) => {
        signal?.removeEventListener('abort', onAbort);
        const ms = Math.round((performance.now() - start) * 100) / 100;
        const ct = res.headers.get("content-type") ?? "";
        const sse = ct.includes("text/event-stream");
        bus.emit(
          "net.fetch.end",
          { id, method, url, status: res.status, ok: res.ok, ms, contentType: ct, contentLength: res.headers.get("content-length"), sse, streaming: sse || (!res.headers.has("content-length") && res.body !== null) },
          { component },
        );
        return sse ? wrapSse(res, id, url) : res;
      },
      (err: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        const ms = Math.round((performance.now() - start) * 100) / 100;
        const e = err as { name?: string; message?: string } | null;
        bus.emit("net.fetch.error", { id, method, url, ms, name: e?.name ?? "Error", message: redactText(String(e?.message ?? err)), aborted: aborted || e?.name === "AbortError" }, { component });
        throw err;
      },
    );
  } as typeof fetch & { __solidPulse?: true };
  // Marker so cooperating shims (e.g. @omniaura/scenario-sim/browser) can tell
  // they are wrapping pulse — and must report to pulse's bus themselves.
  pulseFetch.__solidPulse = true;
  g.fetch = pulseFetch;

  // ── WebSocket ────────────────────────────────────────────────────

  class PulseWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (ignored(typeof url === "string" ? url : url.href)) return;
      const id = nextId++;
      const safeUrl = redactUrl(typeof url === "string" ? url : url.href);
      const openedAt = performance.now();
      let inbound = 0;
      let outbound = 0;
      const component = solid?.currentComponent() ?? null;
      bus.emit("net.ws.open", { id, url: safeUrl, protocols: protocols ? ([] as string[]).concat(protocols) : [], state: "connecting" }, { component });
      this.addEventListener("open", () => {
        bus.emit("net.ws.open", { id, url: safeUrl, protocol: this.protocol, state: "open", ms: Math.round(performance.now() - openedAt) }, { component });
      });
      this.addEventListener("message", (ev) => {
        inbound++;
        if (!controller.isOn("network")) return;
        if (inbound <= MAX_INDIVIDUAL_STREAM_MESSAGES || inbound % 50 === 0) {
          const data = (ev as MessageEvent).data;
          bus.emit("net.ws.message", { id, url: safeUrl, dir: "in", n: inbound, bytes: bodySize(data), type: messageType(data), preview: preview(data, controller.isOn("captureBodies")) });
        }
      });
      this.addEventListener("close", (ev) => {
        const e = ev as CloseEvent;
        bus.emit("net.ws.close", { id, url: safeUrl, code: e.code, reason: redactText(e.reason), wasClean: e.wasClean, inbound, outbound, ms: Math.round(performance.now() - openedAt) });
      });
      this.addEventListener("error", () => {
        bus.emit("net.ws.error", { id, url: safeUrl, readyState: this.readyState });
      });
      const origSend = this.send.bind(this);
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        outbound++;
        if (controller.isOn("network") && (outbound <= MAX_INDIVIDUAL_STREAM_MESSAGES || outbound % 50 === 0)) {
          bus.emit("net.ws.message", { id, url: safeUrl, dir: "out", n: outbound, bytes: bodySize(data), type: messageType(data), preview: preview(data, controller.isOn("captureBodies")) });
        }
        return origSend(data as never);
      };
    }
  }
  (PulseWebSocket as unknown as { __solidPulse?: true }).__solidPulse = true;
  g.WebSocket = PulseWebSocket as unknown as typeof WebSocket;

  // ── EventSource ──────────────────────────────────────────────────

  if (NativeEventSource) {
    class PulseEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (ignored(typeof url === "string" ? url : url.href)) return;
        const id = nextId++;
        const safeUrl = redactUrl(typeof url === "string" ? url : url.href);
        const openedAt = performance.now();
        let count = 0;
        const seen = new Set<string>();
        const component = solid?.currentComponent() ?? null;
        const countType = (type: string) => {
          if (seen.has(type)) return;
          seen.add(type);
          super.addEventListener(type, (ev) => {
            count++;
            if (!controller.isOn("network")) return;
            if (count <= MAX_INDIVIDUAL_STREAM_MESSAGES || count % 50 === 0) {
              const data = (ev as MessageEvent).data;
              bus.emit("net.sse.message", { id, url: safeUrl, event: type, n: count, bytes: bodySize(data), transport: "EventSource", preview: preview(data, controller.isOn("captureBodies")) });
            }
          });
        };
        countType("message");
        this.addEventListener("open", () => bus.emit("net.sse.open", { id, url: safeUrl, transport: "EventSource", ms: Math.round(performance.now() - openedAt) }, { component }));
        this.addEventListener("error", () => bus.emit("net.sse.error", { id, url: safeUrl, readyState: this.readyState, transport: "EventSource" }));
        const origAdd = this.addEventListener.bind(this);
        this.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (type !== "open" && type !== "error") countType(type);
          return (origAdd as (t: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => void)(type, listener, options);
        }) as typeof this.addEventListener;
        const origClose = this.close.bind(this);
        this.close = () => {
          bus.emit("net.sse.close", { id, url: safeUrl, messages: count, ms: Math.round(performance.now() - openedAt), transport: "EventSource" });
          origClose();
        };
      }
    }
    (PulseEventSource as unknown as { __solidPulse?: true }).__solidPulse = true;
    g.EventSource = PulseEventSource as unknown as typeof EventSource;
  }

  return {
    dispose() {
      g.fetch = origFetch;
      g.WebSocket = NativeWebSocket;
      if (NativeEventSource) g.EventSource = NativeEventSource;
    },
  };
}
