import { describe, expect, test } from "bun:test";
import { Simulator } from "../src/core/engine.js";
import type { SocketTransport, WsRoute } from "../src/core/streams.js";
import { scenarios } from "../src/examples/notes-chat.js";

const H = { "content-type": "application/json" };
const req = (path: string, init: RequestInit & { run?: string; scenario?: string } = {}) => {
  const headers = new Headers(init.headers ?? H);
  if (init.run) headers.set("x-sim-run", init.run);
  if (init.scenario) headers.set("x-sim-scenario", init.scenario);
  return new Request(`http://sim.local${path}`, { ...init, headers });
};
const jsonOf = async (r: Response) => (await r.json()) as Record<string, unknown>;

async function readSseFrames(res: Response, count: number, timeoutMs = 2000): Promise<Array<{ event: string; id?: string; data: Record<string, unknown> }>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Array<{ event: string; id?: string; data: Record<string, unknown> }> = [];
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("sse timeout")), timeoutMs))]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame || frame.startsWith(":")) continue;
      let event = "message";
      let id: string | undefined;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      frames.push({ event, id, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    }
  }
  await reader.cancel();
  return frames;
}

/** In-process WebSocket transport for tests: records what the server sends. */
function fakeTransport() {
  const sent: Record<string, unknown>[] = [];
  const closes: Array<{ code?: number; reason?: string; drop: boolean }> = [];
  const transport: SocketTransport = {
    send: (data) => sent.push(JSON.parse(String(data)) as Record<string, unknown>),
    close: (code, reason) => closes.push({ code, reason, drop: false }),
    drop: () => closes.push({ drop: true }),
  };
  return { sent, closes, transport };
}

async function connectWs(sim: Simulator, path: string, opts: { run?: string; protocols?: string } = {}) {
  const t = fakeTransport();
  let inbound: ((data: string) => void) | null = null;
  let clientClose: ((code: number, reason: string) => void) | null = null;
  let selected: string | null = null;
  const headers = new Headers({ "x-sim-upgrade": "websocket", "x-sim-websocket-protocol": opts.protocols ?? "chat-v1" });
  if (opts.run) headers.set("x-sim-run", opts.run);
  const res = await sim.handle(new Request(`http://sim.local${path}`, { headers }), {
    upgrade: (route: WsRoute, ctx, run, protocol) => {
      selected = protocol;
      const sock = run.streams.openSocket(route, ctx, t.transport, protocol);
      inbound = (data) => run.streams.receive(route, ctx, sock, data);
      clientClose = (code, reason) => run.streams.clientClosed(route, ctx, sock, code, reason);
      return new Response(null, { status: 101 });
    },
  });
  return { status: res.status, protocol: selected as string | null, ...t, send: (frame: Record<string, unknown>) => inbound?.(JSON.stringify(frame)), close: (code = 1000, reason = "") => clientClose?.(code, reason) };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("Simulator: stateful CRUD, isolation, determinism", () => {
  test("POST → GET/list → PATCH → DELETE with observable state and mutation events", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-empty" });
    expect((await sim.handle(req("/api/notes"))).status).toBe(200);
    expect(await jsonOf(await sim.handle(req("/api/notes")))).toEqual({ items: [] });

    const created = await sim.handle(req("/api/notes", { method: "POST", body: JSON.stringify({ title: "Buy milk", body: "2%" }) }));
    expect(created.status).toBe(201);
    const note = await jsonOf(created);
    expect(note).toMatchObject({ title: "Buy milk", body: "2%", done: false });
    expect(String(note.createdAt)).toMatch(/^2026-01-01T00:00:0/); // the virtual epoch, not wall time
    expect(note.id).toMatch(/^note_/);

    const list = await jsonOf(await sim.handle(req("/api/notes")));
    expect((list.items as unknown[]).length).toBe(1);
    expect(await jsonOf(await sim.handle(req(`/api/notes/${note.id}`)))).toEqual(note);

    const patched = await sim.handle(req(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) }));
    expect(patched.status).toBe(200);
    expect(await jsonOf(patched)).toMatchObject({ id: note.id, done: true, title: "Buy milk" });
    expect((await sim.handle(req(`/api/notes/${note.id}`, { method: "PATCH", body: JSON.stringify({ title: 5 }) }))).status).toBe(422);

    expect((await sim.handle(req(`/api/notes/${note.id}`, { method: "DELETE" }))).status).toBe(204);
    expect((await sim.handle(req(`/api/notes/${note.id}`))).status).toBe(404);
    expect(await jsonOf(await sim.handle(req("/api/notes")))).toEqual({ items: [] });

    // the state store and event log are inspectable through the control plane
    const events = await jsonOf(await sim.handle(req("/__sim/events")));
    expect((events.events as Array<{ kind: string }>).map((e) => e.kind)).toEqual(["insert", "update", "remove"]);
    const state = await jsonOf(await sim.handle(req("/__sim/state")));
    expect(state.counts).toEqual({ notes: 0 });
    const missing = await sim.handle(req("/api/nope"));
    expect(missing.status).toBe(404);
    expect(await jsonOf(missing)).toMatchObject({ status: 404 });
    sim.dispose();
  });

  test("runs are isolated; reset replays the seed; seeds change ids deterministically", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-happy" });
    const a1 = await jsonOf(await sim.handle(req("/api/notes", { run: "a" })));
    const b1 = await jsonOf(await sim.handle(req("/api/notes", { run: "b" })));
    expect(a1).toEqual(b1); // same scenario + seed → identical fixtures
    await sim.handle(req("/api/notes", { run: "a", method: "POST", body: JSON.stringify({ title: "only in a" }) }));
    expect(((await jsonOf(await sim.handle(req("/api/notes", { run: "a" })))).items as unknown[]).length).toBe(9);
    expect(((await jsonOf(await sim.handle(req("/api/notes", { run: "b" })))).items as unknown[]).length).toBe(8);

    // reset restores the exact seeded world
    await sim.handle(req("/__sim/reset", { method: "POST", body: JSON.stringify({ run: "a" }) }));
    expect(await jsonOf(await sim.handle(req("/api/notes", { run: "a" })))).toEqual(a1);
    // a fresh run with another seed differs but is itself reproducible
    const s1 = await jsonOf(await sim.handle(req("/__sim/select", { method: "POST", body: JSON.stringify({ run: "c", scenario: "notes-happy", seed: "other" }) })));
    expect(s1).toMatchObject({ run: "c", scenario: "notes-happy", seed: "other" });
    const c1 = await jsonOf(await sim.handle(req("/api/notes", { run: "c" })));
    expect(c1).not.toEqual(a1);
    await sim.handle(req("/__sim/reset", { method: "POST", body: JSON.stringify({ run: "c" }) }));
    expect(await jsonOf(await sim.handle(req("/api/notes", { run: "c" })))).toEqual(c1);
    const runs = (await jsonOf(await sim.handle(req("/__sim/runs")))) as unknown as Array<{ id: string }>;
    expect(runs.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    sim.dispose();
  });

  test("overrides, fail modes, sequences and malformed responses", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-happy" });
    await sim.handle(req("/__sim/overrides", { method: "POST", body: JSON.stringify({ matcher: "/api/notes", method: "GET", status: 503, times: 1 }) }));
    expect((await sim.handle(req("/api/notes"))).status).toBe(503);
    expect((await sim.handle(req("/api/notes"))).status).toBe(200); // auto-expired
    await sim.handle(req("/__sim/overrides", { method: "POST", body: JSON.stringify({ matcher: "/api/anything", status: 200, body: { forced: true } }) }));
    expect(await jsonOf(await sim.handle(req("/api/anything/at/all")))).toEqual({ forced: true }); // unrouted path forced
    await sim.handle(req("/__sim/overrides", { method: "DELETE" }));
    expect((await sim.handle(req("/api/anything"))).status).toBe(404);

    await sim.handle(req("/__sim/faults", { method: "POST", body: JSON.stringify({ failMode: "data", shellPaths: ["/api/health"] }) }));
    expect((await sim.handle(req("/api/health"))).status).toBe(200);
    expect((await sim.handle(req("/api/notes"))).status).toBe(503);
    await sim.handle(req("/__sim/faults", { method: "POST", body: JSON.stringify({ failMode: "off" }) }));

    const m = new Simulator({ scenarios, defaultScenario: "notes-malformed" });
    const r1 = await m.handle(req("/api/notes"));
    await expect(r1.json()).rejects.toThrow();
    expect((await m.handle(req("/api/notes"))).headers.get("content-type")).toBe("text/html");
    expect(await jsonOf(await m.handle(req("/api/notes")))).toMatchObject({ data: { items: "not-an-array" } });
    expect(((await jsonOf(await m.handle(req("/api/notes")))).items as unknown[]).length).toBe(3);
    const f = new Simulator({ scenarios, defaultScenario: "notes-flaky" });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await f.handle(req("/api/notes"))).status);
    expect(statuses).toEqual([200, 200, 503, 200, 200, 503]);
    sim.dispose();
    m.dispose();
    f.dispose();
  });

  test("manual clock: latency and stream timing only advance on step", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-manual-clock" });
    let resolved = false;
    const pending = sim.handle(req("/api/health")).then((r) => {
      resolved = true;
      return r;
    });
    await settle();
    expect(resolved).toBe(false);
    const step = await jsonOf(await sim.handle(req("/__sim/step", { method: "POST", body: JSON.stringify({ ms: 499 }) })));
    expect((step.fired as unknown[]).length).toBe(0);
    await sim.handle(req("/__sim/step", { method: "POST", body: JSON.stringify({ ms: 1 }) }));
    await settle();
    expect(resolved).toBe(true);
    expect((await pending).status).toBe(200);
    sim.dispose();
  });
});

describe("Simulator: streams", () => {
  test("SSE feed publishes store mutations and resumes from Last-Event-ID", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-empty" });
    const stream = await sim.handle(req("/api/notes/events", { headers: {} }));
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const framesP = readSseFrames(stream, 4);
    await settle();
    const created = await jsonOf(await sim.handle(req("/api/notes", { method: "POST", body: JSON.stringify({ title: "a" }) })));
    await sim.handle(req(`/api/notes/${created.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) }));
    await sim.handle(req("/api/notes:complete-all", { method: "POST" }));
    const frames = await framesP;
    expect(frames.map((f) => f.event)).toEqual(["hello", "notes.insert", "notes.update", "notes.completed-all"]);
    expect(frames[1]!.id).toBe("1");
    expect(frames[1]!.data).toMatchObject({ type: "notes.insert", id: created.id, note: { title: "a" } });
    expect(frames[2]!.data).toMatchObject({ type: "notes.update", previous: { done: false }, note: { done: true } });
    expect(frames[3]!.data).toMatchObject({ count: 0 }); // already done

    // reconnect with Last-Event-ID → replay of what was missed only
    const resumed = await sim.handle(req("/api/notes/events", { headers: { "last-event-id": "1" } }));
    const replay = await readSseFrames(resumed, 2, 500);
    expect(replay.map((f) => [f.event, f.id])).toEqual([["notes.update", "2"], ["notes.completed-all", "3"]]);
    const streams = await jsonOf(await sim.handle(req("/__sim/streams")));
    expect((streams.topics as Array<{ topic: string; last: string }>)).toEqual([{ topic: "notes", last: "3" }]);
    sim.dispose();
  });

  test("WebSocket chat: subprotocol negotiation, subscribe, deterministic streaming, control-plane drop and resume", async () => {
    const sim = new Simulator({ scenarios, defaultScenario: "notes-manual-clock" });
    const c = await connectWs(sim, "/api/chat/ws", { run: "ws" });
    expect(c.status).toBe(101);
    expect(c.protocol).toBe("chat-v1");
    await settle();
    expect(c.sent[0]).toMatchObject({ type: "ready", protocolVersion: 1 });
    c.send({ type: "subscribe", topic: "chat:lobby" });
    expect(c.sent[1]).toMatchObject({ type: "subscribed", topic: "chat:lobby", replayed: 0, last: "0" });
    c.send({ type: "send", topic: "chat:lobby", clientMessageID: "cm1", content: "hello world" });
    await settle();
    expect(c.sent[2]).toMatchObject({ type: "message", role: "user", content: "hello world", clientMessageID: "cm1", eventID: "1" });
    expect(c.sent.length).toBe(3); // manual clock: nothing streams until stepped

    const step1 = await jsonOf(await sim.handle(req("/__sim/step", { method: "POST", body: JSON.stringify({ run: "ws", ms: 100 }) })));
    expect((step1.fired as Array<{ label: string }>).map((f) => f.label)).toEqual(["stream.start"]);
    expect(c.sent[3]).toMatchObject({ type: "stream.start", eventID: "2" });
    await sim.handle(req("/__sim/step", { method: "POST", body: JSON.stringify({ run: "ws", ms: 250 }) }));
    const chunks = c.sent.filter((f) => f.type === "chat.content");
    expect(chunks.map((f) => f.seq)).toEqual([1, 2]);
    expect(chunks[0]).toMatchObject({ content: "Echoing " });
    await sim.handle(req("/__sim/step", { method: "POST", body: JSON.stringify({ run: "ws", ms: 5000 }) }));
    const types = c.sent.map((f) => f.type);
    expect(types.at(-2)).toBe("stream.done");
    expect(types.at(-1)).toBe("message");
    expect(c.sent.at(-1)).toMatchObject({ role: "assistant", content: "Echoing HELLO WORLD — " + (c.sent.at(-1) as { content: string }).content.split("— ")[1] });
    const last = (c.sent.at(-1) as { eventID: string }).eventID;

    // same seed → same assistant reply on a fresh run
    const sim2 = new Simulator({ scenarios, defaultScenario: "notes-manual-clock" });
    const c2 = await connectWs(sim2, "/api/chat/ws", { run: "ws" });
    c2.send({ type: "subscribe", topic: "chat:lobby" });
    c2.send({ type: "send", topic: "chat:lobby", clientMessageID: "cm1", content: "hello world" });
    await settle();
    await sim2.handle(req("/__sim/step", { method: "POST", body: JSON.stringify({ run: "ws", ms: 6000 }) }));
    expect(c2.sent.at(-1)).toEqual(c.sent.at(-1));
    sim2.dispose();

    // control plane hard-drops the socket (no close frame) …
    const dropped = await jsonOf(await sim.handle(req("/__sim/streams/disconnect", { method: "POST", body: JSON.stringify({ run: "ws", all: true, drop: true }) })));
    expect((dropped.closed as string[]).length).toBe(1);
    expect(c.closes).toEqual([{ drop: true }]);
    expect((await jsonOf(await sim.handle(req("/__sim/streams", { run: "ws" })))).connections).toEqual([]);

    // … and a reconnect with sinceEventID replays only what was missed
    await sim.handle(req("/__sim/publish", { method: "POST", body: JSON.stringify({ run: "ws", topic: "chat:lobby", data: { type: "message", role: "system", content: "while you were away" } }) }));
    const c3 = await connectWs(sim, "/api/chat/ws", { run: "ws" });
    c3.send({ type: "subscribe", topic: "chat:lobby", sinceEventID: last });
    await settle();
    expect(c3.sent.map((f) => f.type)).toEqual(["ready", "message", "subscribed"]);
    expect(c3.sent[1]).toMatchObject({ content: "while you were away", eventID: String(Number(last) + 1) });
    expect(c3.sent[2]).toMatchObject({ replayed: 1 });

    // unsupported subprotocol is refused
    const bad = await connectWs(sim, "/api/chat/ws", { run: "ws", protocols: "other-v9" });
    expect(bad.status).toBe(400);
    // stream-drop scenario drops mid-stream by itself
    const d = new Simulator({ scenarios, defaultScenario: "chat-stream-drop" });
    const cd = await connectWs(d, "/api/chat/ws");
    cd.send({ type: "subscribe", topic: "chat:r" });
    cd.send({ type: "send", topic: "chat:r", content: "one two three four" });
    await new Promise((r) => setTimeout(r, 450));
    expect(cd.closes).toEqual([{ drop: true }]);
    expect(cd.sent.filter((f) => f.type === "chat.content").length).toBeGreaterThan(0);
    const log = await jsonOf(await d.handle(req("/__sim/log")));
    expect((log.entries as Array<{ message: string }>).some((e) => e.message.includes("dropped connection mid-stream"))).toBe(true);
    d.dispose();
    sim.dispose();
  });

  test("actions and scenario listing", async () => {
    const sim = new Simulator({ scenarios });
    const list = await jsonOf(await sim.handle(req("/__sim/scenarios")));
    expect((list.scenarios as Array<{ name: string }>).map((s) => s.name)).toEqual(["notes-happy", "notes-empty", "notes-slow", "notes-flaky", "notes-malformed", "chat-stream-drop", "notes-manual-clock"]);
    const burst = await jsonOf(await sim.handle(req("/__sim/action", { method: "POST", body: JSON.stringify({ name: "burst", args: { count: 3 } }) })));
    expect(burst).toEqual({ result: { inserted: 3 } });
    expect((await jsonOf(await sim.handle(req("/__sim/status")))).state).toMatchObject({ collections: { notes: 11 } });
    expect((await sim.handle(req("/__sim/action", { method: "POST", body: JSON.stringify({ name: "nope" }) }))).status).toBe(500);
    sim.dispose();
  });
});
