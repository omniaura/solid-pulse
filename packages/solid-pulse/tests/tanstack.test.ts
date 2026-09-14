import { describe, expect, test } from "bun:test";
import { initPulse } from "../src/index.js";
import { mountPanel } from "../src/panel/index.js";
import { tanstackQueryTab } from "../src/tanstack/index.js";

describe("combined panel: pulse + TanStack Query devtools tab", () => {
  test('embeds the native view in Query without adding a duplicate tab', async () => {
    const pulse = initPulse({ banner: false, storageKey: false });
    let disposed = 0;
    const panel = mountPanel(pulse, { storageKey: false, queryDevtools: tanstackQueryTab({
      client: {}, load: async () => ({
        Panel: () => document.createElement('section'),
        render: (code, el) => { el.append(code() as Node); return () => { disposed++; }; },
      }),
    }) });
    await pulse.run('panel.open', { tab: 'query' });
    await new Promise(r => setTimeout(r, 0));
    expect(panel.querySlot.querySelector('section')).not.toBeNull();
    expect(panel.root.querySelector('[data-tab="tanstack"]')).toBeNull();
    expect(panel.root.querySelector('[data-tab="query"]')).not.toBeNull();
    pulse.destroy();
    expect(disposed).toBe(1);
  });
  test("mounts the TanStack devtools inside the pulse drawer as a tab, reachable by command", async () => {
    document.body.innerHTML = "<div id='app'></div>";
    const pulse = initPulse({ bridge: false, banner: false });
    const client = { name: "fake-query-client" };
    const rendered: unknown[] = [];
    let disposed = 0;
    const panel = mountPanel(pulse, {
      tabs: [
        tanstackQueryTab({
          client,
          load: async () => ({
            Panel: (props) => {
              rendered.push(props.client);
              const node = document.createElement("div");
              node.setAttribute("data-fake-tanstack", "1");
              return node;
            },
            render: (code, el) => {
              el.append(code() as Node);
              return () => {
                disposed++;
              };
            },
          }),
        }),
      ],
    });
    await pulse.run("panel.open", { tab: "tanstack" });
    await new Promise((r) => setTimeout(r, 0));
    expect(await pulse.run("panel.status")).toMatchObject({ ok: true, value: { open: true, tab: "tanstack" } });
    expect(rendered).toEqual([client]);
    expect(document.querySelector("[data-fake-tanstack]")).not.toBeNull();
    expect(document.querySelector("[data-tanstack-status]")).toBeNull(); // placeholder removed after load
    panel.destroy();
    expect(disposed).toBe(1);
    pulse.destroy();
  });

  test("reports an unavailable peer instead of throwing", async () => {
    document.body.innerHTML = "";
    const pulse = initPulse({ bridge: false, banner: false });
    const panel = mountPanel(pulse, { tabs: [tanstackQueryTab({ client: {}, load: async () => { throw new Error("no devtools installed"); } })] });
    await pulse.run("panel.open", { tab: "tanstack" });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("[data-tanstack-status='error']")?.textContent).toContain("no devtools installed");
    panel.destroy();
    pulse.destroy();
  });
});
