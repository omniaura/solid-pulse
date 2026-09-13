import { describe, expect, test } from "bun:test";
import WsClient from "ws";
import { Simulator } from "../src/core/engine.js";
import { serveSimulator } from "../src/server.js";
import { installBrowserSimulator } from "../src/browser.js";
import { attachScenarioCommands } from "../src/pulse.js";
import { scenarios } from "../src/examples/notes-chat.js";

const nativeFetch = (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch ?? fetch;

describe("server adapter", () => {
  test("HTTP + WebSocket over a real port, including control-plane drop → 1006 and resume", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-happy" });
    const running = await serveSimulator(sim, { port: 0 });
    const list = await nativeFetch(`${running.url}/api/notes`).then((r) => r.json() as Promise<{ items: unknown[] }>);
    expect(list.items.length).toBe(8);
    const created = await nativeFetch(`${running.url}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "via http" }) }).then((r) => r.json() as Promise<{ id: string }>);
    expect(created.id).toMatch(/^note_/);

    const ws = new WsClient(`${running.url.replace("http", "ws")}/api/chat/ws`, ["chat-v1"]);
    const frames: Record<string, unknown>[] = [];
    const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    expect(ws.protocol).toBe("chat-v1");
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    ws.send(JSON.stringify({ type: "subscribe", topic: "chat:lobby" }));
    ws.send(JSON.stringify({ type: "send", topic: "chat:lobby", clientMessageID: "c1", content: "ping" }));
    const until = async (pred: () => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      expect(pred()).toBe(true);
    };
    await until(() => frames.some((f) => f.type === "stream.done"));
    expect(frames.map((f) => f.type).slice(0, 4)).toEqual(["ready", "subscribed", "message", "stream.start"]);
    const lastId = String((frames.at(-1) as { eventID: string }).eventID);

    const dropped = await nativeFetch(`${running.controlUrl}/streams/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true, drop: true }) }).then((r) => r.json() as Promise<{ closed: string[] }>);
    expect(dropped.closed.length).toBe(1);
    expect((await closed).code).toBe(1006);

    const ws2 = new WsClient(`${running.url.replace("http", "ws")}/api/chat/ws`, ["chat-v1"]);
    const frames2: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => ws2.once("open", () => resolve()));
    ws2.on("message", (raw) => frames2.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    ws2.send(JSON.stringify({ type: "subscribe", topic: "chat:lobby", sinceEventID: lastId }));
    await until(() => frames2.some((f) => f.type === "subscribed"));
    expect(frames2.find((f) => f.type === "subscribed")).toMatchObject({ replayed: 0, last: lastId });
    ws2.close();
    const status = await nativeFetch(`${running.controlUrl}/status`).then((r) => r.json() as Promise<{ scenario: string; requests: number }>);
    expect(status.scenario).toBe("notes-happy");
    expect(status.requests).toBeGreaterThanOrEqual(2);
    await running.close();
  });
});

describe("browser adapter", () => {
  test("patched fetch/WebSocket/EventSource terminate inside the simulator; pulse commands drive it", async () => {
    const installed = installBrowserSimulator({ scenarios, defaultScenario: "notes-empty", origin: "http://app.test", run: "tab1" });
    try {
    const created = await fetch("http://app.test/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "in page" }) }).then((r) => r.json() as Promise<{ id: string }>);
    expect(created.id).toMatch(/^note_/);
    const list = await fetch("/api/notes").then((r) => r.json() as Promise<{ items: unknown[] }>);
    expect(list.items.length).toBe(1);

    const socket = new WebSocket("ws://app.test/api/chat/ws", "chat-v1");
    const got: Record<string, unknown>[] = [];
    socket.addEventListener("message", (e) => got.push(JSON.parse(String((e as unknown as MessageEvent).data)) as Record<string, unknown>));
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    expect(socket.protocol).toBe("chat-v1");
    socket.send(JSON.stringify({ type: "subscribe", topic: "chat:x" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(got.map((f) => f.type)).toEqual(["ready", "subscribed"]);
    const closeP = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", (e) => resolve(e as unknown as CloseEvent)));
    installed.sim.api.disconnect("tab1", { all: true }, { code: 4001, reason: "bye" });
    const close = await closeP;
    expect(close.code).toBe(4001);
    expect(socket.readyState).toBe(3);

    const es = new EventSource("/api/notes/events");
    const seen: string[] = [];
    es.addEventListener("hello", () => seen.push("hello"));
    es.addEventListener("notes.insert", (e) => seen.push(`insert:${(JSON.parse(String((e as MessageEvent).data)) as { id: string }).id}`));
    await new Promise<void>((resolve) => es.addEventListener("open", () => resolve()));
    const second = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "two" }) }).then((r) => r.json() as Promise<{ id: string }>);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["hello", `insert:${second.id}`]);
    es.close();

    // pulse commands (local client) reflect and drive the same simulator
    const registry = new Map<string, (a: Record<string, unknown>) => unknown>();
    const fakePulse = { controller: { register: (s: { name: string }, h: (a: Record<string, unknown>) => unknown) => registry.set(s.name, h), unregister: (n: string) => registry.delete(n), has: (n: string) => registry.has(n) }, bus: { emit: () => null } };
    const detach = attachScenarioCommands(fakePulse, { kind: "local", sim: installed.sim, run: "tab1" });
    expect([...registry.keys()]).toContain("scenario.select");
    const state = (await registry.get("scenario.state")!({ collection: "notes" })) as { items: unknown[] };
    expect(state.items.length).toBe(2);
    await registry.get("scenario.select")!({ name: "notes-happy" });
    expect(((await fetch("/api/notes").then((r) => r.json())) as { items: unknown[] }).items.length).toBe(8);
    detach();
    expect(registry.size).toBe(0);
    } finally {
      installed.restore();
    }
  });
});
