import { describe, expect, test } from "bun:test";
import { Rng } from "../src/core/rng.js";
import { VirtualClock } from "../src/core/clock.js";
import { Store } from "../src/core/store.js";
import { TopicLog } from "../src/core/streams.js";

describe("Rng", () => {
  test("same seed → same stream; different seeds differ; forks are stable", () => {
    const a = new Rng("qa-1");
    const b = new Rng("qa-1");
    const seqA = Array.from({ length: 6 }, () => a.int(0, 1000));
    const seqB = Array.from({ length: 6 }, () => b.int(0, 1000));
    expect(seqA).toEqual(seqB);
    expect(new Rng("qa-2").int(0, 1000)).not.toBe(seqA[0]);
    expect(new Rng("s").id("note")).toBe(new Rng("s").id("note"));
    expect(new Rng("s").id("note")).toMatch(/^note_[0-9a-z]{8}$/);
    expect(new Rng("s").uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Rng("s").fork("x").next()).toBe(new Rng("s").fork("x").next());
    expect(new Rng("s").shuffle([1, 2, 3, 4, 5])).toEqual(new Rng("s").shuffle([1, 2, 3, 4, 5]));
  });
});

describe("VirtualClock", () => {
  test("manual mode fires timers only when stepped, in time order", () => {
    const clock = new VirtualClock("manual");
    const fired: string[] = [];
    clock.after(300, () => fired.push("c"), "c");
    clock.after(100, () => fired.push("a"), "a");
    clock.after(100, () => fired.push("b"), "b");
    expect(clock.pending().map((p) => p.label)).toEqual(["a", "b", "c"]);
    expect(clock.step(50).fired).toEqual([]);
    const r = clock.step(100);
    expect(r.fired.map((f) => f.label)).toEqual(["a", "b"]);
    expect(r.now).toBe(150);
    expect(fired).toEqual(["a", "b"]);
    clock.step(1000);
    expect(fired).toEqual(["a", "b", "c"]);
    expect(clock.wall()).toBe(Date.UTC(2026, 0, 1) + 1150);
  });
  test("realtime mode honours speed and mode switching", async () => {
    const clock = new VirtualClock("realtime", 10);
    let fired = false;
    clock.after(200, () => (fired = true));
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(true);
    const c2 = new VirtualClock("realtime");
    let late = false;
    c2.after(50, () => (late = true));
    c2.setMode("manual");
    await new Promise((r) => setTimeout(r, 80));
    expect(late).toBe(false);
    c2.step(60);
    expect(late).toBe(true);
    expect(() => new VirtualClock("realtime").step(1)).toThrow();
  });
});

describe("Store", () => {
  test("CRUD with an event log and listeners", () => {
    let t = 0;
    const store = new Store(() => t);
    const seen: string[] = [];
    store.on((e) => seen.push(`${e.kind}:${e.id ?? e.collection}`));
    store.insert("notes", { id: "n1", title: "a" });
    t = 5;
    store.update("notes", "n1", { title: "b" });
    expect(store.get("notes", "n1")).toEqual({ id: "n1", title: "b" });
    expect(() => store.insert("notes", { id: "n1" })).toThrow(/duplicate/);
    store.insert("notes", { id: "n0", title: "z" });
    expect(store.list("notes", { sort: (a, b) => String(a.id).localeCompare(String(b.id)) }).map((r) => r.id)).toEqual(["n0", "n1"]);
    expect(store.remove("notes", "n1")).toMatchObject({ id: "n1" });
    expect(store.remove("notes", "nope")).toBeUndefined();
    store.custom("notes", "completed-all", { count: 1 });
    expect(seen).toEqual(["insert:n1", "update:n1", "insert:n0", "remove:n1", "custom:notes"]);
    const events = store.events();
    expect(events[1]).toMatchObject({ seq: 2, t: 5, kind: "update", previous: { id: "n1", title: "a" }, record: { id: "n1", title: "b" } });
    expect(store.events({ since: 3 }).map((e) => e.seq)).toEqual([4, 5]);
    expect(store.counts()).toEqual({ notes: 1 });
    expect(store.snapshot()).toEqual({ notes: [{ id: "n0", title: "z" }] });
  });
});

describe("TopicLog", () => {
  test("monotonic ids per topic, replay after an id, missed window detection", () => {
    const log = new TopicLog(() => 0, 3);
    for (let i = 1; i <= 5; i++) log.publish("t", { n: i });
    log.publish("other", { n: 1 });
    expect(log.last("t")).toBe("5");
    expect(log.last("other")).toBe("1");
    expect(log.replay("t", "4")).toMatchObject({ missed: false });
    expect(log.replay("t", "4").events.map((e) => e.data.n)).toEqual([5]);
    // retained: 3,4,5 → resuming from 1 misses 2
    expect(log.replay("t", "1").missed).toBe(true);
    expect(log.replay("t", null).events.length).toBe(0); // no resume point → live only
    expect(log.replay("t", "0").events.length).toBe(3); // explicit 0 → everything retained
    expect(log.replay("t", "5").events).toEqual([]);
  });
});
