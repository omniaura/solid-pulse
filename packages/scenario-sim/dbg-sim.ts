import { Simulator } from "./src/core/engine.js";
import { scenarios } from "./src/examples/notes-chat.js";
const sim = new Simulator({ scenarios, defaultScenario: "notes-empty" });
const r = await sim.handle(new Request("http://sim.local/api/notes/events"));
console.log("sse status", r.status, r.headers.get("content-type"), r.status !== 200 ? await r.text() : "");
const run = sim.getRun()!;
console.log("streamRoutes", JSON.stringify(run.status().streamRoutes), "routes", run.routes.length);
const w = await sim.handle(new Request("http://sim.local/api/chat/ws", { headers: { upgrade: "websocket", "sec-websocket-protocol": "chat-v1" } }), { upgrade: async () => new Response(null, { status: 101 }) });
console.log("ws status", w.status, w.status !== 101 ? await w.text() : "");
