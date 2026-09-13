/**
 * Generic example world shipped with the package (also what the test-suite and
 * consumer smoke test use). No product data — a notes CRUD API, a live notes
 * feed over SSE, and a streaming-chat WebSocket protocol with per-topic event
 * ids and resume. Scenario variants layer faults and timing on top.
 *
 * WebSocket protocol (`chat-v1` subprotocol), deliberately shaped like real
 * chat backends so client reconnect logic gets exercised:
 *   client → { type:"subscribe", topic, sinceEventID? }
 *          → { type:"send", topic, clientMessageID, content }
 *   server → { type:"ready" } · { type:"subscribed", topic, replayed, last }
 *          → { type:"message", topic, eventID, id, role, content }
 *          → { type:"stream.start", streamID } · { type:"chat.content", streamID, seq, content }
 *          → { type:"stream.done", streamID } · { type:"resume.miss", topic } · { type:"error", error }
 */

import { defineScenario, type ScenarioDefinition } from "../core/scenario.js";
import { crud, json, problem, route, sequence, malformed } from "../core/router.js";
import { sse, ws, type SimSocket } from "../core/streams.js";

export interface Note extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export const NOTES_TOPIC = "notes";
export const chatTopic = (room: string) => `chat:${room}`;

const WORDS = ["alpha", "harbor", "signal", "quiet", "meadow", "copper", "lantern", "orbit", "velvet", "cinder"];

function baseRoutes() {
  return [
    route.get("/api/health", () => json({ ok: true })),
    ...crud<Note>("/api/notes", "notes", {
      sort: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      validate: (body) => (body.title !== undefined && typeof body.title !== "string" ? "title must be a string" : null),
      create: (body, ctx) => ({
        id: ctx.rng.id("note"),
        title: String(body.title ?? "Untitled"),
        body: String(body.body ?? ""),
        done: Boolean(body.done ?? false),
        createdAt: ctx.clock.iso(),
        updatedAt: ctx.clock.iso(),
      }),
      update: (cur, body, ctx) => ({ ...cur, ...body, id: cur.id, updatedAt: ctx.clock.iso() }),
    }),
    // Bulk action with a side effect: marks everything done and emits one custom event.
    route.post("/api/notes:complete-all", (ctx) => {
      let n = 0;
      for (const note of ctx.state.list<Note>("notes", { where: (x) => !x.done })) {
        ctx.state.update<Note>("notes", note.id, { done: true, updatedAt: ctx.clock.iso() });
        n++;
      }
      ctx.state.custom("notes", "completed-all", { count: n });
      return json({ completed: n });
    }),
    route.get("/api/chat/rooms/:room/history", (ctx) => {
      const topic = chatTopic(ctx.params.room!);
      const { events } = ctx.streams.topics.replay(topic, ctx.query.get("sinceEventID") ?? "0");
      return json({ items: events.map((e) => ({ ...e.data, eventID: e.eventID, topic })) });
    }),
  ];
}

function streams(opts: { streamDelayMs?: number; chunkDelayMs?: number; dropMidStream?: boolean } = {}) {
  const chunkDelay = opts.chunkDelayMs ?? 40;
  return [
    // Live notes feed: every store mutation on "notes" becomes an SSE event, resumable via Last-Event-ID.
    sse("/api/notes/events", (ctx, stream) => {
      stream.subscribe(NOTES_TOPIC);
      stream.send({ type: "hello", run: ctx.run.id }, { event: "hello" });
    }, { keepaliveMs: 15_000 }),
    ws("/api/chat/ws", {
      protocols: ["chat-v1"],
      onOpen(ctx, socket) {
        socket.send({ type: "ready", protocolVersion: 1, run: ctx.run.id });
      },
      onMessage(ctx, socket, raw) {
        let frame: { type?: string; topic?: string; sinceEventID?: string; clientMessageID?: string; content?: string };
        try {
          frame = JSON.parse(String(raw)) as typeof frame;
        } catch {
          return socket.send({ type: "error", error: "invalid json" });
        }
        if (frame.type === "subscribe" && frame.topic) {
          const r = socket.subscribe(frame.topic, { since: frame.sinceEventID ?? null });
          socket.send({ type: "subscribed", topic: frame.topic, replayed: r.replayed, last: r.last });
          if (r.missed) socket.send({ type: "resume.miss", topic: frame.topic });
          return;
        }
        if (frame.type === "send" && frame.topic && frame.content !== undefined) {
          const id = ctx.rng.id("msg");
          ctx.streams.publish(frame.topic, { type: "message", id, clientMessageID: frame.clientMessageID ?? "", role: "user", content: frame.content, createdAt: ctx.clock.iso() });
          respond(ctx, socket, frame.topic, frame.content, chunkDelay, opts);
          return;
        }
        socket.send({ type: "error", error: `unknown frame ${frame.type ?? "?"}` });
      },
    }),
  ];

  function respond(ctx: Parameters<NonNullable<ReturnType<typeof ws>["onMessage"]>>[0], socket: SimSocket, topic: string, prompt: string, delay: number, o: typeof opts) {
    const streamID = ctx.rng.id("stream");
    const words = prompt.split(/\s+/).filter(Boolean).slice(0, 12);
    const reply = ["Echoing", ...words.map((w) => w.toUpperCase()), "—", ctx.rng.pick(WORDS), ctx.rng.pick(WORDS)];
    ctx.clock.after(o.streamDelayMs ?? 100, () => {
      ctx.streams.publish(topic, { type: "stream.start", streamID });
      reply.forEach((word, i) => {
        ctx.clock.after(delay * (i + 1), () => {
          if (o.dropMidStream && i === Math.floor(reply.length / 2)) {
            // Cut the connection without a close frame — the client must reconnect and resume.
            ctx.streams.disconnect({ topic }, { drop: true });
            ctx.log("dropped connection mid-stream", { streamID });
          }
          ctx.streams.publish(topic, { type: "chat.content", streamID, seq: i + 1, content: word + " " });
        }, `chunk ${i + 1}`);
      });
      ctx.clock.after(delay * (reply.length + 1), () => {
        const id = ctx.rng.id("msg");
        ctx.streams.publish(topic, { type: "stream.done", streamID, messageID: id });
        ctx.streams.publish(topic, { type: "message", id, role: "assistant", content: reply.join(" ").trim(), createdAt: ctx.clock.iso() });
      }, "stream.done");
    }, "stream.start");
  }
}

function seedNotes(count: number) {
  return ({ state, rng, clock, streams }: import("../core/scenario.js").SetupContext) => {
    for (let i = 0; i < count; i++) {
      const created = clock.iso(-(count - i) * 60_000);
      state.insert<Note>("notes", { id: rng.id("note"), title: `${rng.pick(WORDS)} ${rng.pick(WORDS)}`, body: `Note ${i + 1}`, done: rng.chance(0.3), createdAt: created, updatedAt: created });
    }
    // Mutations → stream events: the feed publishes what the store does.
    state.on((e) => {
      if (e.collection !== "notes") return;
      if (e.kind === "custom") streams.publish(NOTES_TOPIC, { type: `notes.${e.name}`, ...(e.data as Record<string, unknown>) });
      else streams.publish(NOTES_TOPIC, { type: `notes.${e.kind}`, id: e.id, note: e.record ?? null, previous: e.previous ?? null });
    });
  };
}

const actions: ScenarioDefinition["actions"] = {
  /** Emit N synthetic note inserts quickly (list growth / scroll anchoring). */
  burst: ({ state, rng, clock, args }) => {
    const n = Number(args.count ?? 5);
    for (let i = 0; i < n; i++) state.insert<Note>("notes", { id: rng.id("note"), title: `burst ${i + 1}`, body: "", done: false, createdAt: clock.iso(), updatedAt: clock.iso() });
    return { inserted: n };
  },
  /** Flip the first note's done flag — a single-record update event. */
  toggleFirst: ({ state, clock }) => {
    const first = state.list<Note>("notes")[0];
    if (!first) return { toggled: null };
    state.update<Note>("notes", first.id, { done: !first.done, updatedAt: clock.iso() });
    return { toggled: first.id };
  },
  /** Drop every chat socket without a close frame. */
  dropChat: ({ streams }) => ({ dropped: streams.disconnect({ path: "/api/chat/ws" }, { drop: true }) }),
};

export const happy = defineScenario({
  name: "notes-happy",
  label: "Happy path",
  description: "8 seeded notes, CRUD, live SSE feed, streaming chat over WebSocket.",
  setup: seedNotes(8),
  routes: baseRoutes(),
  streams: streams(),
  actions,
  qa: { routes: ["/"], expectsErrors: false },
});

export const empty = defineScenario({
  name: "notes-empty",
  label: "Empty state",
  description: "No notes; every list shows its empty state.",
  setup: seedNotes(0),
  routes: baseRoutes(),
  streams: streams(),
  actions,
});

export const slow = defineScenario({
  name: "notes-slow",
  label: "Slow API",
  description: "1200 ms (+ up to 400 ms seeded jitter) on every response; chat chunks every 250 ms.",
  faults: { latencyMs: 1200, jitterMs: 400 },
  setup: seedNotes(8),
  routes: baseRoutes(),
  streams: streams({ chunkDelayMs: 250 }),
  actions,
  qa: { expectsSlow: true },
});

export const flaky = defineScenario({
  name: "notes-flaky",
  label: "Flaky list",
  description: "GET /api/notes fails every third call with 503; creates succeed.",
  setup: seedNotes(8),
  routes: [
    route.get("/api/notes", (ctx) => (ctx.calls % 3 === 0 ? problem(503, "flaky upstream") : json({ items: ctx.state.list<Note>("notes") }))),
    ...baseRoutes().filter((r) => !(r.method === "GET" && r.path === "/api/notes")),
  ],
  streams: streams(),
  actions,
  qa: { expectsErrors: true },
});

export const malformedApi = defineScenario({
  name: "notes-malformed",
  label: "Malformed responses",
  description: "GET /api/notes answers, in order: invalid JSON, wrong content-type, schema drift, then a valid list forever.",
  setup: seedNotes(3),
  routes: [
    route.get(
      "/api/notes",
      sequence([() => malformed("invalid-json"), () => malformed("wrong-content-type"), () => malformed("schema-drift"), (ctx) => json({ items: ctx.state.list<Note>("notes") })]),
    ),
    ...baseRoutes().filter((r) => !(r.method === "GET" && r.path === "/api/notes")),
  ],
  streams: streams(),
  actions,
  qa: { expectsErrors: true },
});

export const streamDrop = defineScenario({
  name: "chat-stream-drop",
  label: "Stream drop mid-turn",
  description: "The chat socket is hard-dropped halfway through every assistant reply; clients must reconnect with sinceEventID and resume.",
  setup: seedNotes(2),
  routes: baseRoutes(),
  streams: streams({ dropMidStream: true }),
  actions,
});

export const manualClock = defineScenario({
  name: "notes-manual-clock",
  label: "Manual clock",
  description: "Nothing time-based happens until the clock is stepped: deterministic chat streaming and latency for tests (`scenario.step ms=…`).",
  clock: { mode: "manual" },
  faults: { latencyMs: 500 },
  setup: seedNotes(4),
  routes: baseRoutes(),
  streams: streams({ streamDelayMs: 100, chunkDelayMs: 100 }),
  actions,
});

export const scenarios: ScenarioDefinition[] = [happy, empty, slow, flaky, malformedApi, streamDrop, manualClock];
export default scenarios;
