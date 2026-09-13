import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { createComponent, createRoot } from "solid-js";
import { EventBus } from "../src/core/bus.js";
import { PulseController } from "../src/core/controller.js";
import { installSolid } from "../src/solid/instrument.js";
import { attachQueryClient } from "../src/query/index.js";
import type { Pulse } from "../src/index.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("Solid Query adapter", () => {
  test("distinguishes the initiating observer from sharing observers, and attributes them to Solid components", async () => {
    const bus = new EventBus(500);
    const controller = new PulseController(bus);
    const solid = installSolid(controller);
    const pulse = { controller, bus, overlay: null, solid, bridge: null, run: controller.run.bind(controller), destroy() {} } as unknown as Pulse;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const detach = attachQueryClient(pulse, client);

    let fetches = 0;
    const options = () => client.defaultQueryOptions({ queryKey: ["conversations", { token: "abc", page: 1 }], queryFn: async () => { fetches++; await tick(5); return ["c1"]; } });
    const unsubs: Array<() => void> = [];
    let dispose!: () => void;

    createRoot((d) => {
      dispose = d;
      createComponent(function Sidebar() {
        const obs = new QueryObserver(client, options());
        unsubs.push(obs.subscribe(() => {}));
        return null;
      }, {});
      createComponent(function ChatHeader() {
        const obs = new QueryObserver(client, options());
        unsubs.push(obs.subscribe(() => {}));
        return null;
      }, {});
    });
    await tick(20);

    const events = bus.list({ limit: 200 }).filter((e) => e.kind.startsWith("query."));
    const observes = events.filter((e) => e.kind === "query.observe");
    expect(observes.length).toBe(2);
    expect(observes[0]!.data).toMatchObject({ role: "initiating", observers: 1 });
    expect(observes[0]!.component?.name).toBe("Sidebar");
    expect(observes[1]!.data).toMatchObject({ role: "sharing", observers: 2 });
    expect(observes[1]!.component?.name).toBe("ChatHeader");
    // keys are redacted
    expect(JSON.stringify(observes[0]!.data.key)).toContain("[redacted]");
    expect(JSON.stringify(observes[0]!.data.key)).not.toContain("abc");

    const starts = events.filter((e) => e.kind === "query.fetch.start");
    expect(starts.length).toBe(1); // one fetch for two observers
    expect(starts[0]!.data.trigger).toBe("observer-mount");
    expect(starts[0]!.component?.name).toBe("Sidebar");
    expect(events.some((e) => e.kind === "query.fetch.success")).toBe(true);
    expect(fetches).toBe(1);

    bus.clear();
    await client.invalidateQueries({ queryKey: ["conversations"] });
    await tick(20);
    const kinds = bus.list({ limit: 50 }).map((e) => e.kind);
    expect(kinds).toContain("query.invalidate");
    const refetch = bus.list({ limit: 50 }).find((e) => e.kind === "query.fetch.start")!;
    expect(refetch.data.trigger).toBe("invalidation");
    expect(refetch.component).toBeNull();

    const inspected = (await controller.run("inspect.queries", { active: true })) as { ok: true; value: Array<{ observers: number; components: string[] }> };
    expect(inspected.value[0]).toMatchObject({ observers: 2, components: ["Sidebar", "ChatHeader"] });

    bus.clear();
    for (const u of unsubs) u();
    await tick();
    expect(bus.list({ limit: 50 }).filter((e) => e.kind === "query.unobserve").map((e) => e.component?.name)).toEqual(["Sidebar", "ChatHeader"]);

    const res = await controller.run("query.invalidate", { key: '["conversations"]' });
    expect(res.ok).toBe(true);
    detach();
    expect(controller.has("inspect.queries")).toBe(false);
    dispose();
    solid.dispose();
  });
});
