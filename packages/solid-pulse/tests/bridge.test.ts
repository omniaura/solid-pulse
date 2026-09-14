import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { BridgeClient } from "../src/bridge/client.js";
import { startBridgeServer } from "../src/bridge/server.js";
import { PulseController } from "../src/core/controller.js";

const nativeFetch = (globalThis as unknown as { __nativeFetch: typeof fetch }).__nativeFetch;

async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs = 1000): Promise<T> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw last instanceof Error ? last : new Error(String(last ?? "timed out"));
}

describe("bridge server", () => {
  test("ingests page events, relays commands, streams SSE, and stays loopback-only", async () => {
    const running = startBridgeServer({ port: 0, log: () => {} });
    const { url } = await running.ready;
    const api = (route: string, init?: RequestInit) => nativeFetch(`${url}/api${route}`, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

    expect((await api("/status")).body).toMatchObject({ tool: "@omniaura/solid-pulse", clients: [] });
    expect((await api("/command", { method: "POST", body: JSON.stringify({ name: "status" }) })).status).toBe(404);

    // a fake page runtime
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    const received: unknown[] = [];
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; name?: string; args?: Record<string, unknown> };
      received.push(frame);
      if (frame.type === "command") {
        ws.send(JSON.stringify({ type: "result", id: frame.id, result: frame.name === "boom" ? { ok: false, error: "kaboom" } : { ok: true, value: { echoed: frame.args } } }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", protocol: 1, clientId: "tab-a", url: "http://localhost:3000/", title: "App", userAgent: "test", commands: [{ name: "status", summary: "s" }], startedWall: Date.now() }));
    ws.send(JSON.stringify({ type: "events", events: [{ seq: 1, t: 1, wall: 1, kind: "dom.mutation", data: { targets: 1 } }, { seq: 2, t: 2, wall: 2, kind: "query.observe", data: { label: "x" } }] }));
    await new Promise((r) => setTimeout(r, 30));

    const clients = await api("/clients");
    expect(clients.body as unknown as unknown[]).toHaveLength(1);
    expect((clients.body as unknown as Array<{ clientId: string; events: number }>)[0]).toMatchObject({ clientId: "tab-a", events: 2 });
    expect((await api("/commands")).body).toMatchObject({ client: "tab-a" });

    const ev = await api("/events?kinds=query");
    expect(ev.body).toMatchObject({ client: "tab-a", count: 1, last: 2 });

    const cmd = await api("/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "features.set", args: { name: "flash", on: false } }) });
    expect(cmd.status).toBe(200);
    expect(cmd.body).toMatchObject({ ok: true, client: "tab-a", value: { echoed: { name: "flash", on: false } } });
    const get = await api(`/command?name=inspect.element&args=${encodeURIComponent(JSON.stringify({ selector: "#x" }))}`);
    expect(get.body).toMatchObject({ ok: true, value: { echoed: { selector: "#x" } } });
    expect((await api("/command", { method: "POST", body: JSON.stringify({ name: "boom" }) })).body).toMatchObject({ ok: false, error: "kaboom" });
    expect((await api("/command", { method: "POST", body: JSON.stringify({ name: "status", client: "ghost" }) })).status).toBe(404);

    // live stream
    // Sustained large events retain bounded diagnostic payloads in the mirror.
    for (let batch=0;batch<30;batch++) ws.send(JSON.stringify({type:'events',events:Array.from({length:100},(_,i)=>({seq:3+batch*100+i,t:1,wall:1,kind:'pulse.note',data:{note:'x'.repeat(4000)}}))}));
    await new Promise(r=>setTimeout(r,250));
    const retained=await api('/events?limit=5000');
    expect((retained.body as any).count).toBeLessThan(1000);
    expect(JSON.stringify(retained.body).length).toBeLessThan(4*1024*1024);

    // Clear before the stream's original low sequence fixture.
    await api('/command',{method:'POST',body:JSON.stringify({name:'events.clear'})});
    const stream = await nativeFetch(`${url}/api/events/stream?kinds=dom`);
    const reader = stream.body!.getReader();
    ws.send(JSON.stringify({ type: "events", events: [{ seq: 3, t: 3, wall: 3, kind: "dom.reattach", data: {} }, { seq: 4, t: 4, wall: 4, kind: "query.update", data: {} }] }));
    let text = "";
    const dec = new TextDecoder();
    while (!text.includes("dom.reattach")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain('"kind":"dom.reattach"');
    expect(text).not.toContain("query.update");
    await reader.cancel();

    // host-header spoofing is rejected even from loopback
    const spoof = await nativeFetch(`${url}/api/status`, { headers: { host: "evil.example.com" } });
    expect(spoof.status).toBe(403);

    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect((await api("/clients")).body as unknown as unknown[]).toHaveLength(0);
    await running.close();
  });

  test("BridgeClient publishes dynamic command registry updates without reconnecting or dropping pending commands", async () => {
    const running = startBridgeServer({ port: 0, log: () => {}, commandTimeoutMs: 1000 });
    const { url } = await running.ready;
    const api = (route: string, init?: RequestInit) =>
      nativeFetch(`${url}/api${route}`, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

    const controller = new PulseController();
    let slowStarted!: () => void;
    let releaseSlow!: () => void;
    const slowStartedPromise = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    controller.register({ name: "slow.echo", summary: "Slow echo" }, async (args) => {
      slowStarted();
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return { marker: args.marker };
    });

    const client = new BridgeClient(controller, { url: url.replace(/^http/, "ws") + "/ws", clientId: "tab-dynamic", reconnectMs: 20 });
    try {
      client.connect();
      const connected = await waitFor(async () => {
        const clients = (await api("/clients")).body as unknown as Array<{ clientId: string; connectedWall: number; commands: number }>;
        expect(clients).toHaveLength(1);
        expect(clients[0]).toMatchObject({ clientId: "tab-dynamic" });
        return clients[0]!;
      });

      const pending = api("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "slow.echo", args: { marker: "pending" } }),
      });
      await slowStartedPromise;

      controller.register({ name: "dynamic.now", summary: "Late command", args: { value: "echo value" } }, (args) => ({ value: args.value ?? "ok" }));
      const namesWithLate = await waitFor(async () => {
        const commands = (await api("/commands")).body.commands as Array<{ name: string }>;
        const names = commands.map((c) => c.name);
        expect(names).toContain("dynamic.now");
        return names;
      });
      expect(namesWithLate).toContain("slow.echo");
      expect(((await api("/clients")).body as unknown as Array<{ connectedWall: number; commands: number }>)[0]).toMatchObject({
        connectedWall: connected.connectedWall,
        commands: namesWithLate.length,
      });

      const late = await api("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "dynamic.now", args: { value: "late" } }),
      });
      expect(late.body).toMatchObject({ ok: true, value: { value: "late" } });

      controller.unregister("dynamic.now");
      await waitFor(async () => {
        const commands = (await api("/commands")).body.commands as Array<{ name: string }>;
        const names = commands.map((c) => c.name);
        expect(names).not.toContain("dynamic.now");
        expect(((await api("/clients")).body as unknown as Array<{ commands: number }>)[0]!.commands).toBe(names.length);
        return names;
      });

      releaseSlow();
      await expect(pending).resolves.toMatchObject({ status: 200, body: { ok: true, value: { marker: "pending" } } });
    } finally {
      client.disconnect();
      globalThis.WebSocket = originalWebSocket;
      await running.close();
    }
  });
});
