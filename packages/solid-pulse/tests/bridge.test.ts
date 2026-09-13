import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { startBridgeServer } from "../src/bridge/server.js";

const nativeFetch = (globalThis as unknown as { __nativeFetch: typeof fetch }).__nativeFetch;

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
});
