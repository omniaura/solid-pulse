import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../src/core/bus.js";
import { PulseController } from "../src/core/controller.js";
import { installNetwork } from "../src/solid/network.js";
import { REDACTED } from "../src/core/redact.js";

class FakeWS extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  protocol = "";
  url: string;
  sent: unknown[] = [];
  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = String(url);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: true }));
  }
}

const g = globalThis as unknown as { fetch: typeof fetch; WebSocket: unknown };
let origFetch: typeof fetch;
let origWS: unknown;
beforeEach(() => {
  origFetch = g.fetch;
  origWS = g.WebSocket;
});
afterEach(() => {
  g.fetch = origFetch;
  g.WebSocket = origWS;
});

describe("network instrumentation", () => {
  test("fetch start/end/error with redaction, SSE frame counting, abort", async () => {
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/fail")) throw new TypeError("Failed to fetch");
      if (url.includes("/abort")) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      if (url.includes("/stream")) {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode("event: chat.content\ndata: {\"a\":1}\n\n: keepalive\n\ndata: two\n\n"));
            c.enqueue(enc.encode("event: stream.done\ndata: {}\n\n"));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json", "content-length": "11" } });
    }) as typeof fetch;
    g.WebSocket = FakeWS;

    const bus = new EventBus(500);
    const controller = new PulseController(bus);
    const net = installNetwork(controller, null);

    const res = await fetch("https://api.example.com/v5/items?token=secret123", { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    let events = bus.list({ limit: 50 });
    expect(events.map((e) => e.kind)).toEqual(["net.fetch.start", "net.fetch.end"]);
    expect(events[0]!.data).toMatchObject({ method: "POST", url: `https://api.example.com/v5/items?token=${encodeURIComponent(REDACTED)}`, bodyBytes: 2 });
    expect(events[0]!.data.preview).toBeUndefined(); // bodies not captured by default
    expect(events[1]!.data).toMatchObject({ status: 201, ok: true, sse: false, streaming: false });

    bus.clear();
    const sse = await fetch("/api/stream");
    const text = await sse.text();
    expect(text).toContain("stream.done"); // body passes through untouched
    events = bus.list({ limit: 50 });
    const sseKinds = events.map((e) => e.kind);
    expect(sseKinds[1]).toBe("net.fetch.end");
    expect(events[1]!.data.sse).toBe(true);
    expect(sseKinds.filter((k) => k === "net.sse.message").length).toBe(3); // comment frame skipped
    expect(events.filter((e) => e.kind === "net.sse.message").map((e) => e.data.event)).toEqual(["chat.content", "message", "stream.done"]);
    expect(events.at(-1)!.kind).toBe("net.sse.close");
    expect(events.at(-1)!.data.messages).toBe(3);

    bus.clear();
    await expect(fetch("/fail")).rejects.toThrow("Failed to fetch");
    expect(bus.list({ limit: 5 }).at(-1)!.data).toMatchObject({ name: "TypeError", aborted: false });

    bus.clear();
    const ac = new AbortController();
    const p = fetch("/abort", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(bus.list({ limit: 5 }).at(-1)!.data.aborted).toBe(true);

    // WebSocket lifecycle with type extraction and out/in counting
    bus.clear();
    const ws = new WebSocket("ws://localhost:3000/api/v5/agents/chat/ws?ticket=abc&sinceEventID=9", ["ditto-agent-chat"]) as unknown as FakeWS;
    await new Promise((r) => setTimeout(r, 0));
    (ws as unknown as WebSocket).send(JSON.stringify({ type: "subscribe", topic: "user:1" }));
    ws.dispatchEvent(Object.assign(new MessageEvent("message", { data: JSON.stringify({ type: "ready", topic: "user:1" }) })));
    ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat.content", content: "hi" }) }));
    ws.close(1006, "gone");
    events = bus.list({ limit: 50 });
    expect(events.map((e) => e.kind)).toEqual(["net.ws.open", "net.ws.open", "net.ws.message", "net.ws.message", "net.ws.message", "net.ws.close"]);
    expect(events[0]!.data).toMatchObject({ url: `ws://localhost:3000/api/v5/agents/chat/ws?ticket=${encodeURIComponent(REDACTED)}&sinceEventID=9`, protocols: ["ditto-agent-chat"], state: "connecting" });
    expect(events[2]!.data).toMatchObject({ dir: "out", type: "subscribe" });
    expect(events[3]!.data).toMatchObject({ dir: "in", type: "ready", n: 1 });
    expect(events[5]!.data).toMatchObject({ code: 1006, reason: "gone", inbound: 2, outbound: 1 });
    expect(ws.sent.length).toBe(1);
    expect(ws instanceof (g.WebSocket as never)).toBe(true);

    // feature off → passthrough, no events
    controller.setFeature("network", false);
    bus.clear();
    await fetch("/quiet");
    expect(bus.list({ limit: 5 }).length).toBe(0);

    net.dispose();
    expect(g.WebSocket).toBe(FakeWS);
  });
});
