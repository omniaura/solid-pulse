import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { initPulse } from "../src/index.js";
import { attachQueryClient } from "../src/query/index.js";
import { mountPanel } from "../src/panel/index.js";

describe("panel ↔ CLI parity", () => {
  test("every command that declares a panel location has a control, and every control is a command", async () => {
    document.body.innerHTML = "<div id='app'></div>";
    const pulse = initPulse({ bridge: false, banner: false });
    attachQueryClient(pulse, new QueryClient());
    // a scenario client contributes commands too; stub the contract it registers
    for (const name of ["scenario.list", "scenario.select", "scenario.reset", "scenario.step", "scenario.status", "scenario.state", "scenario.events", "scenario.streams"]) {
      pulse.controller.register({ name, summary: "stub", ui: "Scenarios tab" }, () => (name === "scenario.list" ? [{ name: "default" }] : { scenario: "default" }));
    }
    const panel = mountPanel(pulse);
    await pulse.run("panel.open", { tab: "scenarios" });
    await pulse.run("panel.tab", { name: "pulse" });

    const controls = new Set([...document.querySelectorAll("[data-command]")].map((el) => el.getAttribute("data-command")!));
    const specs = pulse.controller.describe();
    const registered = new Set(specs.map((s) => s.name));
    const missingControls = specs.filter((s) => s.ui && !controls.has(s.name)).map((s) => s.name);
    const orphanControls = [...controls].filter((c) => !registered.has(c));
    expect(missingControls).toEqual([]);
    expect(orphanControls).toEqual([]);

    // opening the panel must not move focus
    const input = document.createElement("input");
    document.getElementById("app")!.append(input);
    input.focus();
    await pulse.run("panel.close");
    await pulse.run("panel.open");
    expect(document.activeElement).toBe(input);
    expect(await pulse.run("panel.status")).toMatchObject({ ok: true, value: { open: true, tab: "pulse" } });

    // toggling from the panel and from the "CLI" path are the same operation
    const box = document.querySelector<HTMLInputElement>('[data-command="features.set"][data-feature="flash"]')!;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(pulse.controller.isOn("flash")).toBe(false);
    await pulse.run("features.set", { name: "flash", on: true });
    expect(box.checked).toBe(true);

    panel.destroy();

    // fab:false hides the floating button (it must never sit over app chrome in
    // a harness) while the hotkey and the commands still open the panel.
    const quiet = mountPanel(pulse, { fab: false, open: false });
    expect(document.querySelector<HTMLButtonElement>(".sp-fab")!.hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "P", altKey: true, shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(await pulse.run("panel.status")).toMatchObject({ ok: true, value: { open: true } });
    await pulse.run("panel.close");
    expect(document.querySelector<HTMLButtonElement>(".sp-fab")!.hidden).toBe(true);
    quiet.destroy();
    pulse.destroy();
    expect(window.__SOLID_PULSE__).toBeUndefined();
  });
});
