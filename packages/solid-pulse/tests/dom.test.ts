import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/core/bus.js";
import { PulseController } from "../src/core/controller.js";
import { installDom, describeElement, toSelector } from "../src/solid/dom.js";
import { FlashOverlay } from "../src/overlay/flash.js";

const flushMO = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => setTimeout(r, 0));
};

describe("DOM observation", () => {
  test("reports real mutations, detach/reattach with scroll + focus loss, and inspects elements", async () => {
    document.body.innerHTML = `
      <div id="app" data-solid-component="App" data-solid-source="src/App.tsx:1:1">
        <section id="surface" data-testid="chat" data-solid-component="ChatFeed">
          <div class="scroll-view" style="overflow:auto;height:100px"><p>row</p></div>
          <input id="composer" />
        </section>
      </div>`;
    const bus = new EventBus(500);
    const controller = new PulseController(bus, { flash: false });
    const overlay = new FlashOverlay();
    overlay.mount();
    const dom = installDom(controller, null, overlay);

    const app = document.getElementById("app")!;
    const surface = document.getElementById("surface")!;
    const scroller = surface.querySelector(".scroll-view") as HTMLElement;
    const composer = document.getElementById("composer") as HTMLInputElement;

    // an attribute change is a dom.mutation
    app.setAttribute("data-x", "1");
    await flushMO();
    let muts = bus.list({ limit: 50 }).filter((e) => e.kind === "dom.mutation");
    expect(muts.length).toBe(1);
    const summary = (muts[0]!.data as { summary: Array<{ id?: string; types: string[]; attrs?: string[]; component?: string | null }> }).summary;
    expect(summary[0]).toMatchObject({ id: "app", types: ["attributes"], attrs: ["data-x"], component: "App" });
    expect(muts[0]!.data.attributedTo).toBe("outside-solid-flush");

    // our own overlay never produces events
    bus.clear();
    overlay.flash([{ x: 0, y: 0, w: 10, h: 10 }], "dom");
    await flushMO();
    expect(bus.list({ limit: 50 }).filter((e) => e.kind === "dom.mutation").length).toBe(0);

    // scroll + focus, then detach and reattach the same node instance
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    composer.focus();
    expect(document.activeElement).toBe(composer);
    bus.clear();
    const parent = surface.parentElement!;
    surface.remove();
    await flushMO();
    const detach = bus.list({ limit: 50 }).find((e) => e.kind === "dom.detach");
    expect(detach).toBeDefined();
    expect(detach!.data).toMatchObject({ hadFocus: true, element: { id: "surface", testId: "chat", component: "ChatFeed" } });
    expect((detach!.data.scrollers as Array<{ scrollTop: number }>)[0]!.scrollTop).toBe(120);
    expect(bus.list({ limit: 50 }).some((e) => e.kind === "focus.lost")).toBe(true);

    bus.clear();
    parent.appendChild(surface);
    await flushMO();
    const reattach = bus.list({ limit: 50 }).find((e) => e.kind === "dom.reattach");
    expect(reattach).toBeDefined();
    const rd = reattach!.data as { gapMs: number; focusLost: boolean; scrollReset: Array<{ before: number; after: number; reset: boolean }>; selector: string };
    expect(rd.gapMs).toBeGreaterThanOrEqual(0);
    expect(rd.focusLost).toBe(true);
    expect(rd.scrollReset[0]!.before).toBe(120);
    expect(rd.selector).toBe("#surface");

    // inspect.element resolves source/component attributes and a stable selector
    const r = (await controller.run("inspect.element", { selector: "#composer" })) as { ok: true; value: { element: { component: string | null; source: string | null }; selector: string } };
    expect(r.value.element.component).toBe("ChatFeed");
    expect(r.value.element.source).toBe("src/App.tsx:1:1");
    expect(r.value.selector).toBe("#composer");
    expect((await controller.run("inspect.element", { selector: "#nope" })).ok).toBe(false);
    const hl = (await controller.run("dom.highlight", { selector: "#surface" })) as { ok: true; value: { matched: number } };
    expect(hl.value.matched).toBe(1);
    const scrollers = (await controller.run("inspect.scrollers")) as { ok: true; value: Array<{ scrollTop: number }> };
    expect(scrollers.value[0]!.scrollTop).toBe(120);

    // feature off → no events
    controller.setFeature("dom", false);
    bus.clear();
    app.setAttribute("data-y", "2");
    await flushMO();
    expect(bus.list({ limit: 50 }).length).toBe(0);

    expect(toSelector(composer)).toBe("#composer");
    expect(describeElement(scroller, false)).toMatchObject({ tag: "div", classes: "scroll-view", component: "ChatFeed" });
    dom.dispose();
    overlay.unmount();
  });
});
