import { describe, expect, test } from "bun:test";
import { DEV, batch, createComponent, createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { EventBus } from "../src/core/bus.js";
import { PulseController } from "../src/core/controller.js";
import { installSolid } from "../src/solid/instrument.js";
import type { PulseEvent } from "../src/core/events.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Solid instrumentation (dev hooks)", () => {
  test("dev hooks are present in the test build", () => {
    expect(DEV).toBeDefined();
  });

  test("reports component mounts/disposes, computation re-runs per flush, remounts and roots — never a 'rerender'", async () => {
    const bus = new EventBus(500);
    const controller = new PulseController(bus);
    const solid = installSolid(controller);
    expect(solid.available).toBe(true);
    const kinds = () => bus.list({ limit: 1000 }).map((e) => e.kind);

    let setCount!: (n: number) => void;
    let setShow!: (b: boolean) => void;
    let dispose!: () => void;
    let childRuns = 0;

    function Child() {
      childRuns++;
      return "child";
    }
    function Parent() {
      const [count, setC] = createSignal(0);
      const [show, setS] = createSignal(true);
      setCount = setC;
      setShow = setS;
      const doubled = createMemo(() => count() * 2);
      createEffect(() => void doubled());
      const child = createMemo(() => (show() ? createComponent(Child, {}) : null));
      createEffect(() => void child());
      return "parent";
    }

    createRoot((d) => {
      dispose = d;
      createComponent(Parent, {});
    });
    await tick();

    expect(kinds()).toContain("solid.root");
    const mounts = bus.list({ limit: 1000 }).filter((e) => e.kind === "solid.component.mount");
    expect(mounts.map((e) => e.data.name)).toEqual(["Parent", "Child"]);
    expect(mounts[1]!.component?.chain).toEqual(["Child", "Parent"]);
    expect(mounts.every((e) => e.data.hydrated === false)).toBe(true);
    expect(kinds().some((k) => k.includes("rerender"))).toBe(false);

    bus.clear();
    setCount(1);
    await tick();
    const flushes = bus.list({ limit: 100 }).filter((e) => e.kind === "solid.flush");
    expect(flushes.length).toBe(1);
    const f = flushes[0]!.data as { computations: number; byKind: Record<string, number>; byComponent: Record<string, number>; components: string[] };
    expect(f.computations).toBe(2); // the memo and the effect re-ran; the component body did not
    expect(f.byKind.memo).toBe(1);
    expect(f.byKind.effect).toBe(1);
    expect(f.byComponent).toEqual({ Parent: 2 });
    expect(f.components).toEqual(["Parent"]);
    expect(kinds()).not.toContain("solid.component.mount");

    // verbose mode: individual computations, attributed to the owning component
    bus.clear();
    controller.setFeature("verboseComputations", true);
    setCount(2);
    await tick();
    const comps = bus.list({ limit: 100 }).filter((e) => e.kind === "solid.computation");
    expect(comps.map((e) => e.data.kind).sort()).toEqual(["effect", "memo"]);
    expect(comps.every((e) => e.component?.name === "Parent")).toBe(true);
    controller.setFeature("verboseComputations", false);

    // dispose then recreate the same component within one flush → remount
    bus.clear();
    batch(() => {
      setShow(false);
      setShow(true);
    });
    await tick();
    // Even batched, the memo re-runs once and its owned scope is rebuilt: Solid
    // really disposes and recreates Child, and that is exactly what we report —
    // a dispose followed by a remount, never a "rerender".
    expect(kinds().filter((k) => k.startsWith("solid.component"))).toEqual(["solid.component.dispose", "solid.component.remount"]);
    expect(childRuns).toBe(2);

    bus.clear();
    setShow(false);
    setShow(true);
    await tick();
    const lifecycle = bus.list({ limit: 100 }).filter((e) => e.kind.startsWith("solid.component"));
    expect(lifecycle.map((e) => e.kind)).toEqual(["solid.component.dispose", "solid.component.remount"]);
    expect(lifecycle[0]!.data.name).toBe("Child");
    expect(typeof lifecycle[1]!.data.gapMs).toBe("number");
    expect(childRuns).toBe(3);

    // components inspector reflects live instances
    const live = (await controller.run("inspect.components")) as { ok: true; value: Array<{ name: string }> };
    expect(live.value.map((c) => c.name).sort()).toEqual(["Child", "Parent"]);

    bus.clear();
    dispose();
    await tick();
    expect(kinds().filter((k) => k === "solid.component.dispose").length).toBe(2);

    // a second root is counted, not conflated
    bus.clear();
    createRoot(() => createComponent(function Other() { return null; }, {}));
    await tick();
    const roots = bus.list({ limit: 10 }).find((e) => e.kind === "solid.root");
    expect((roots!.data as { roots: number }).roots).toBe(2);

    // feature off → silence
    controller.setFeature("solid", false);
    bus.clear();
    createRoot(() => createComponent(function Quiet() { return null; }, {}));
    await tick();
    expect(bus.list({ limit: 10 }).filter((e: PulseEvent) => e.kind.startsWith("solid.")).length).toBe(0);
    solid.dispose();
  });
});
