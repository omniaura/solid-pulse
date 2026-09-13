/**
 * The panel: a raw-DOM floating drawer (no Solid, so it never shows up in the
 * events it displays). Every control carries `data-command="<name>"` and calls
 * `controller.run(name, args)` — exactly what the CLI does. The parity test
 * asserts that every command that declares a `ui` location has a control here
 * and that every control maps to a registered command.
 */

import type { Pulse } from "../index.js";
import type { PulseEvent } from "../core/events.js";
import { OWN_ATTR } from "../overlay/flash.js";
import { FEATURES, type Feature } from "../core/controller.js";

export interface PanelTab {
  id: string;
  title: string;
  /** Called once when the tab body is created; return a cleanup. */
  mount: (el: HTMLElement, pulse: Pulse) => void | (() => void);
}

export interface PanelOptions {
  tabs?: PanelTab[];
  /** Start open (default false). Opening never moves focus. */
  open?: boolean;
  position?: "bottom-left" | "bottom-right";
  /** Max rows in the live list (default 150). */
  rows?: number;
  /**
   * Show the floating ◉ button (default true). Set false where a fixed button
   * could sit over app chrome — e.g. mobile viewports in an automated harness,
   * where it would intercept taps on a bottom tab bar. The panel stays reachable
   * through the hotkey, `panel.open` from the CLI, or `window.__SOLID_PULSE__`.
   */
  fab?: boolean;
  /** Keyboard shortcut that toggles the panel (default "Alt+Shift+P"; false disables). */
  hotkey?: string | false;
}

type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

const CSS = `
[${OWN_ATTR}="panel-root"]{position:fixed;z-index:2147483647;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e5e7eb;pointer-events:none}
[${OWN_ATTR}="panel-root"] *{box-sizing:border-box}
.sp-fab{pointer-events:auto;position:fixed;bottom:12px;width:auto;padding:6px 10px;border-radius:999px;border:1px solid #f59e0b;background:rgba(17,24,39,.92);color:#fbbf24;cursor:pointer;font:inherit;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.sp-fab[data-rec="1"]{border-color:#ef4444;color:#fca5a5}
.sp-drawer{pointer-events:auto;position:fixed;bottom:0;left:0;right:0;height:42vh;min-height:220px;background:rgba(17,24,39,.97);border-top:1px solid #374151;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.4)}
.sp-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #374151}
.sp-head b{color:#fbbf24}
.sp-tabs{display:flex;gap:2px}
.sp-tab{background:transparent;border:1px solid transparent;color:#9ca3af;padding:3px 8px;border-radius:6px;cursor:pointer;font:inherit}
.sp-tab[aria-selected="true"]{color:#fff;border-color:#4b5563;background:#1f2937}
.sp-body{flex:1;overflow:auto;padding:8px 10px}
.sp-body[hidden]{display:none}
.sp-row{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-bottom:6px}
.sp-btn{background:#1f2937;border:1px solid #4b5563;color:#e5e7eb;padding:3px 8px;border-radius:6px;cursor:pointer;font:inherit}
.sp-btn:hover{border-color:#9ca3af}
.sp-in{background:#111827;border:1px solid #4b5563;color:#e5e7eb;padding:3px 6px;border-radius:6px;font:inherit;min-width:120px}
.sp-list{font-size:11px;white-space:pre-wrap;word-break:break-word}
.sp-ev{padding:2px 4px;border-left:3px solid transparent;cursor:pointer}
.sp-ev:hover{background:#1f2937}
.sp-ev[data-g="solid"]{border-color:#22c55e}.sp-ev[data-g="dom"]{border-color:#f59e0b}.sp-ev[data-g="net"]{border-color:#a78bfa}.sp-ev[data-g="query"]{border-color:#3b82f6}.sp-ev[data-g="pulse"]{border-color:#6b7280}
.sp-ev[data-warn="1"]{background:rgba(239,68,68,.15)}
.sp-ev pre{margin:4px 0 6px 10px;color:#9ca3af;max-height:220px;overflow:auto}
.sp-dim{color:#9ca3af}
.sp-status{margin-left:auto;display:flex;gap:8px;color:#9ca3af}
.sp-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#6b7280;margin-right:4px}
.sp-dot[data-on="1"]{background:#22c55e}
`;

/** "Alt+Shift+P" style matcher; modifier order does not matter, key is case-insensitive. */
function matchesHotkey(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.find((p) => !["alt", "shift", "ctrl", "control", "meta", "cmd"].includes(p));
  if (!key || e.key.toLowerCase() !== key) return false;
  const want = (m: string) => parts.includes(m);
  return e.altKey === want("alt") && e.shiftKey === want("shift") && e.ctrlKey === (want("ctrl") || want("control")) && e.metaKey === (want("meta") || want("cmd"));
}

function group(kind: string) {
  return kind.split(".")[0] ?? "pulse";
}

function isWarn(e: PulseEvent) {
  if (e.kind === "dom.reattach") {
    const d = e.data as { scrollReset?: Array<{ reset: boolean }>; focusLost?: boolean };
    return Boolean(d.focusLost || d.scrollReset?.some((s) => s.reset));
  }
  return e.kind === "focus.lost" || e.kind.endsWith(".error") || e.kind === "solid.component.remount";
}

function oneLine(e: PulseEvent): string {
  const d = e.data;
  const comp = e.component?.name ? `<${e.component.name}> ` : "";
  switch (e.kind) {
    case "solid.flush":
      return `${comp}${d.computations} computations ${JSON.stringify(d.byKind)}`;
    case "solid.component.mount":
    case "solid.component.remount":
    case "solid.component.dispose":
      return `${d.name}${d.hydrated ? " (hydrated)" : ""}${d.gapMs !== undefined ? ` gap ${d.gapMs}ms` : ""}${d.lifetimeMs !== undefined ? ` lived ${d.lifetimeMs}ms` : ""}`;
    case "dom.mutation":
      return `${comp}${d.targets} targets · ${(d.summary as Array<{ tag: string; types: string[] }>).slice(0, 3).map((s) => `${s.tag}(${s.types.join("+")})`).join(" ")} · ${d.attributedTo}`;
    case "dom.detach":
      return `${comp}${(d.element as { tag: string }).tag} detached · ${(d.scrollers as unknown[]).length} scrollers${d.hadFocus ? " · had focus" : ""}`;
    case "dom.reattach": {
      const resets = (d.scrollReset as Array<{ reset: boolean; before: number; after: number }>).filter((s) => s.reset);
      return `${comp}${(d.element as { tag: string }).tag} reattached after ${d.gapMs}ms${resets.length ? ` · SCROLL RESET ${resets.map((r) => `${r.before}→${r.after}`).join(",")}` : ""}${d.focusLost ? " · FOCUS LOST" : ""}${d.suspenseInChain ? " · Suspense" : ""}`;
    }
    case "focus.lost":
      return `${(d.element as { tag: string }).tag} — ${d.cause}`;
    default:
      if (e.kind.startsWith("net.")) return `${comp}${d.method ?? ""} ${d.url ?? ""} ${d.status ?? d.state ?? d.dir ?? d.event ?? ""}${d.ms !== undefined ? ` ${d.ms}ms` : ""}${d.message ? ` ✗ ${d.message}` : ""}`.trim();
      if (e.kind.startsWith("query") || e.kind.startsWith("mutation")) return `${comp}${d.label ?? ""} ${d.role ?? d.trigger ?? d.action ?? ""}${d.ms != null ? ` ${d.ms}ms` : ""}${d.message ? ` ✗ ${d.message}` : ""}`.trim();
      return JSON.stringify(d).slice(0, 140);
  }
}

export function mountPanel(pulse: Pulse, options: PanelOptions = {}) {
  const { controller } = pulse;
  const rows = options.rows ?? 150;
  const root = h("div", { [OWN_ATTR]: "panel-root" });
  const style = h("style");
  style.textContent = CSS;
  root.append(style);
  const fab = h("button", { class: "sp-fab", type: "button", title: "solid-pulse panel (also: solid-pulse panel.toggle)", "data-command": "panel.toggle", onclick: () => void controller.run("panel.toggle") }, "◉ pulse");
  fab.style[options.position === "bottom-right" ? "right" : "left"] = "12px";
  if (options.fab === false) fab.hidden = true;
  root.append(fab);
  const hotkey = options.hotkey === undefined ? "Alt+Shift+P" : options.hotkey;
  const onKey = (e: KeyboardEvent) => {
    if (!hotkey || !matchesHotkey(e, hotkey)) return;
    e.preventDefault();
    void controller.run("panel.toggle");
  };
  if (hotkey) document.addEventListener("keydown", onKey, true);

  let open = false;
  let drawer: HTMLDivElement | null = null;
  let activeTab = "pulse";
  const bodies = new Map<string, HTMLElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  const cleanups: Array<() => void> = [];

  const run = (name: string, args: Record<string, unknown> = {}) => controller.run(name, args);
  const val = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? r.value : { error: r.error });

  // ── Pulse tab ────────────────────────────────────────────────────
  const pulseBody = h("div", { class: "sp-body" });
  const toggles = h("div", { class: "sp-row", "data-command": "features.list" });
  const featureBoxes = new Map<Feature, HTMLInputElement>();
  for (const f of FEATURES) {
    const box = h("input", { type: "checkbox", "data-command": "features.set", "data-feature": f, onchange: (e) => void run("features.set", { name: f, on: (e.target as HTMLInputElement).checked }) });
    box.checked = controller.isOn(f);
    featureBoxes.set(f, box);
    toggles.append(h("label", {}, box, ` ${f}`));
  }
  const kindsIn = h("input", { class: "sp-in", placeholder: "kinds: dom,query,net.ws.*", "data-command": "filters.set", "data-arg": "kinds", onchange: (e) => void run("filters.set", { kinds: (e.target as HTMLInputElement).value }) });
  const compIn = h("input", { class: "sp-in", placeholder: "component contains…", "data-command": "filters.set", "data-arg": "component", onchange: (e) => void run("filters.set", { component: (e.target as HTMLInputElement).value }) });
  const textIn = h("input", { class: "sp-in", placeholder: "text contains…", "data-command": "filters.set", "data-arg": "text", onchange: (e) => void run("filters.set", { text: (e.target as HTMLInputElement).value }) });
  const pauseBtn = h("button", { class: "sp-btn", type: "button", "data-command": "events.pause", onclick: () => void run(controller.bus.paused ? "events.resume" : "events.pause").then(refreshStatus) }, "Pause");
  const list = h("div", { class: "sp-list" });
  pulseBody.append(
    toggles,
    h("div", { class: "sp-row" }, kindsIn, compIn, textIn,
      h("button", { class: "sp-btn", type: "button", "data-command": "filters.get", onclick: () => void run("filters.get").then((r) => showResult(pulseBody, val(r))) }, "Filters"),
      h("button", { class: "sp-btn", type: "button", "data-command": "events.clear", onclick: () => void run("events.clear").then(() => (list.textContent = "")) }, "Clear"),
      pauseBtn,
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.components", onclick: () => void run("inspect.components").then((r) => showResult(pulseBody, val(r))) }, "Components"),
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.solid", onclick: () => void run("inspect.solid").then((r) => showResult(pulseBody, val(r))) }, "Solid"),
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.focus", onclick: () => void run("inspect.focus").then((r) => showResult(pulseBody, val(r))) }, "Focus"),
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.scrollers", onclick: () => void run("inspect.scrollers").then((r) => showResult(pulseBody, val(r))) }, "Scrollers"),
      h("button", { class: "sp-btn", type: "button", "data-command": "events.list", onclick: () => void run("events.list", { limit: rows }).then((r) => renderList(r.ok ? (r.value as PulseEvent[]) : [])) }, "Reload"),
      h("button", { class: "sp-btn", type: "button", "data-command": "status", onclick: () => void run("status").then((r) => showResult(pulseBody, val(r))) }, "Status"),
      h("button", { class: "sp-btn", type: "button", "data-command": "commands", onclick: () => void run("commands").then((r) => showResult(pulseBody, val(r))) }, "Commands"),
    ),
    list,
  );
  bodies.set("pulse", pulseBody);

  const resultBoxes = new WeakMap<HTMLElement, HTMLPreElement>();
  function showResult(body: HTMLElement, value: unknown) {
    let pre = resultBoxes.get(body);
    if (!pre) {
      pre = h("pre", { class: "sp-dim" });
      pre.style.cssText = "max-height:40%;overflow:auto;margin:0 0 6px;border:1px solid #374151;padding:6px;border-radius:6px";
      body.insertBefore(pre, body.children[body === pulseBody ? 2 : 1] ?? null);
      resultBoxes.set(body, pre);
    }
    pre.textContent = JSON.stringify(value, null, 2);
  }

  function rowFor(e: PulseEvent) {
    const row = h("div", { class: "sp-ev", "data-g": group(e.kind), "data-warn": isWarn(e) ? "1" : undefined, "data-seq": String(e.seq) });
    row.append(h("span", { class: "sp-dim" }, `${(e.t / 1000).toFixed(3)}s `), h("span", {}, `${e.kind} `), h("span", { class: "sp-dim" }, oneLine(e)));
    row.addEventListener("click", () => {
      const existing = row.querySelector("pre");
      if (existing) existing.remove();
      else row.append(h("pre", {}, JSON.stringify(e, null, 2)));
    });
    return row;
  }

  function renderList(events: PulseEvent[]) {
    list.textContent = "";
    for (const e of events.slice(-rows)) list.append(rowFor(e));
    list.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  let autoScroll = true;
  list.addEventListener("scroll", () => {
    autoScroll = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
  });
  cleanups.push(
    controller.bus.subscribe((e) => {
      if (!open || activeTab !== "pulse") return;
      if (!controller.matchesFilters(e)) return;
      list.append(rowFor(e));
      while (list.children.length > rows) list.firstElementChild?.remove();
      if (autoScroll) list.scrollTop = list.scrollHeight;
    }),
  );
  cleanups.push(controller.onFeature((f, on) => {
    const box = featureBoxes.get(f);
    if (box) box.checked = on;
  }));
  cleanups.push(controller.onFilters((f) => {
    kindsIn.value = f.kinds.join(",");
    compIn.value = f.component;
    textIn.value = f.text;
  }));

  // ── Query tab ────────────────────────────────────────────────────
  const queryBody = h("div", { class: "sp-body" });
  const querySlot = h("div", { "data-slot": "query-devtools" });
  const queryHint = h("span", { class: "sp-dim" });
  const refreshQueryHint = () => {
    queryHint.textContent = controller.has("inspect.queries") ? "solid-query adapter attached" : "attach with attachQueryClient(pulse, queryClient) to enable";
  };
  refreshQueryHint();
  queryBody.append(
    h("div", { class: "sp-row" },
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.queries", onclick: () => void run("inspect.queries", { active: true }).then((r) => showResult(queryBody, r.ok ? r.value : r.error)) }, "Active queries"),
      h("button", { class: "sp-btn", type: "button", "data-command": "query.invalidate", onclick: () => void run("query.invalidate").then((r) => showResult(queryBody, r.ok ? r.value : r.error)) }, "Invalidate all"),
      h("button", { class: "sp-btn", type: "button", "data-command": "query.reset", onclick: () => void run("query.reset").then((r) => showResult(queryBody, r.ok ? r.value : r.error)) }, "Reset all"),
      queryHint,
    ),
    querySlot,
  );
  bodies.set("query", queryBody);

  // ── Grab tab ─────────────────────────────────────────────────────
  const grabBody = h("div", { class: "sp-body" });
  const selIn = h("input", { class: "sp-in", placeholder: "CSS selector", "data-arg": "selector" });
  const hasGrab = Boolean((window as unknown as { __SOLID_GRAB__?: unknown }).__SOLID_GRAB__);
  grabBody.append(
    h("div", { class: "sp-row" },
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.element", onclick: () => pickElement() }, "Pick element (click)"),
      selIn,
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.element", "data-arg": "selector", onclick: () => void run("inspect.element", { selector: selIn.value }).then((r) => showResult(grabBody, r.ok ? r.value : r.error)) }, "Inspect selector"),
      h("button", { class: "sp-btn", type: "button", "data-command": "dom.highlight", onclick: () => void run("dom.highlight", { selector: selIn.value, all: true }).then((r) => showResult(grabBody, r.ok ? r.value : r.error)) }, "Highlight"),
      h("span", { class: "sp-dim" }, hasGrab ? "solid-grab detected: Alt+click anywhere copies source context" : "solid-grab not detected (source attributes need its Vite plugin)"),
    ),
  );
  bodies.set("grab", grabBody);

  function pickElement() {
    const onClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener("click", onClick, true);
      void run("inspect.element", { x: ev.clientX, y: ev.clientY }).then((r) => {
        showResult(grabBody, r.ok ? r.value : r.error);
        if (r.ok) void run("dom.highlight", { selector: (r.value as { selector: string }).selector });
      });
    };
    document.addEventListener("click", onClick, true);
  }

  // ── Scenarios tab (present when a scenario client registered commands) ──
  const scenBody = h("div", { class: "sp-body" });
  const scenSelect = h("select", { class: "sp-in", "data-command": "scenario.select", onchange: (e) => void run("scenario.select", { name: (e.target as HTMLSelectElement).value }).then(refreshScenario) });
  const seedIn = h("input", { class: "sp-in", placeholder: "seed (optional)", "data-arg": "seed" });
  const stepIn = h("input", { class: "sp-in", placeholder: "step ms (default 1000)", "data-arg": "ms" });
  const scenStatus = h("pre", { class: "sp-dim" });
  scenBody.append(
    h("div", { class: "sp-row" },
      h("span", {}, "scenario"), scenSelect, seedIn,
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.reset", onclick: () => void run("scenario.reset", { seed: seedIn.value || undefined }).then(refreshScenario) }, "Reset"),
      stepIn,
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.step", onclick: () => void run("scenario.step", { ms: stepIn.value ? Number(stepIn.value) : 1000 }).then(refreshScenario) }, "Step clock"),
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.status", onclick: () => void refreshScenario() }, "Status"),
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.state", onclick: () => void run("scenario.state").then((r) => showResult(scenBody, r.ok ? r.value : r.error)) }, "State"),
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.events", onclick: () => void run("scenario.events", { limit: 100 }).then((r) => showResult(scenBody, r.ok ? r.value : r.error)) }, "Sim events"),
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.streams", onclick: () => void run("scenario.streams").then((r) => showResult(scenBody, r.ok ? r.value : r.error)) }, "Streams"),
      h("button", { class: "sp-btn", type: "button", "data-command": "scenario.list", onclick: () => void refreshScenario() }, "Reload list"),
    ),
    scenStatus,
  );
  bodies.set("scenarios", scenBody);

  async function refreshScenario() {
    if (!controller.has("scenario.list")) {
      scenStatus.textContent = "no scenario simulator attached (attach @omniaura/scenario-sim's pulse adapter)";
      return;
    }
    const listRes = await run("scenario.list");
    const status = await run("scenario.status");
    if (listRes.ok) {
      const scenarios = listRes.value as Array<{ name: string; label?: string }>;
      const current = status.ok ? (status.value as { scenario?: string }).scenario : undefined;
      scenSelect.textContent = "";
      for (const s of scenarios) {
        const opt = h("option", { value: s.name }, s.label ? `${s.name} — ${s.label}` : s.name);
        if (s.name === current) opt.selected = true;
        scenSelect.append(opt);
      }
    }
    scenStatus.textContent = JSON.stringify(status.ok ? status.value : status.error, null, 2);
  }

  // ── Record tab ───────────────────────────────────────────────────
  const recBody = h("div", { class: "sp-body" });
  const noteIn = h("input", { class: "sp-in", placeholder: "note text", "data-arg": "text" });
  const recList = h("pre", { class: "sp-dim" });
  recBody.append(
    h("div", { class: "sp-row" },
      h("button", { class: "sp-btn", type: "button", "data-command": "record.start", onclick: () => void run("record.start").then(() => refreshRecordings()) }, "Start recording"),
      h("button", { class: "sp-btn", type: "button", "data-command": "record.stop", onclick: () => void run("record.stop").then(() => refreshRecordings()) }, "Stop"),
      h("button", { class: "sp-btn", type: "button", "data-command": "record.list", onclick: () => void refreshRecordings() }, "List"),
      h("button", { class: "sp-btn", type: "button", "data-command": "export", onclick: () => void exportJson() }, "Export JSON"),
      noteIn,
      h("button", { class: "sp-btn", type: "button", "data-command": "note", onclick: () => void run("note", { text: noteIn.value }).then(() => (noteIn.value = "")) }, "Add note"),
      h("button", { class: "sp-btn", type: "button", "data-command": "events.resume", onclick: () => void run("events.resume").then(refreshStatus) }, "Resume"),
    ),
    recList,
  );
  bodies.set("record", recBody);

  async function refreshRecordings() {
    const r = await run("record.list");
    recList.textContent = JSON.stringify(val(r), null, 2);
    refreshStatus();
  }
  async function exportJson() {
    const active = controller.bus.currentRecording();
    const last = controller.bus.listRecordings().filter((r) => !r.active).at(-1);
    const r = await run("export", active || !last ? { filtered: false } : { recording: last.id });
    if (!r.ok) return showResult(recBody, r.error);
    const blob = new Blob([JSON.stringify(r.value)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `solid-pulse-${Date.now()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  for (const tab of options.tabs ?? []) {
    const body = h("div", { class: "sp-body" });
    const cleanup = tab.mount(body, pulse);
    if (cleanup) cleanups.push(cleanup);
    bodies.set(tab.id, body);
  }

  // ── Drawer ───────────────────────────────────────────────────────
  const bridgeDot = h("span", { class: "sp-dot", "data-command": "bridge.status", title: "bridge status (solid-pulse bridge.status)" });
  const recDot = h("span", { class: "sp-dot" });
  const statusText = h("span", { "data-command": "panel.status" });
  function refreshStatus() {
    bridgeDot.dataset.on = pulse.bridge?.connected ? "1" : "0";
    recDot.dataset.on = controller.bus.currentRecording() ? "1" : "0";
    fab.dataset.rec = controller.bus.currentRecording() ? "1" : "0";
    pauseBtn.textContent = controller.bus.paused ? "Resume" : "Pause";
    statusText.textContent = `${controller.bus.buffer.size}/${controller.bus.buffer.capacity} buffered · ${controller.bus.buffer.dropped} dropped${pulse.bridge ? ` · ${pulse.bridge.clientId}` : ""}`;
  }
  const statusTimer = setInterval(() => open && refreshStatus(), 1000);
  cleanups.push(() => clearInterval(statusTimer));

  function buildDrawer() {
    const tabs = h("div", { class: "sp-tabs", role: "tablist" });
    const titles: Record<string, string> = { pulse: "Pulse", query: "Query", grab: "Grab", scenarios: "Scenarios", record: "Record" };
    for (const t of options.tabs ?? []) titles[t.id] = t.title;
    for (const [id, body] of bodies) {
      const btn = h("button", { class: "sp-tab", type: "button", role: "tab", "data-command": "panel.tab", "data-tab": id, onclick: () => void run("panel.tab", { name: id }) }, titles[id] ?? id);
      tabButtons.set(id, btn);
      tabs.append(btn);
      body.hidden = id !== activeTab;
    }
    const head = h("div", { class: "sp-head" },
      h("b", {}, "◉ solid-pulse"),
      tabs,
      h("span", { class: "sp-status" }, h("span", {}, bridgeDot, "bridge"), h("span", {}, recDot, "rec"), statusText),
      h("button", { class: "sp-btn", type: "button", "data-command": "panel.close", onclick: () => void run("panel.close") }, "✕"),
    );
    const d = h("div", { class: "sp-drawer", role: "region", "aria-label": "solid-pulse" }, head, ...bodies.values());
    return d;
  }

  function setTab(id: string) {
    if (!bodies.has(id)) throw new Error(`unknown tab: ${id} (${[...bodies.keys()].join(", ")})`);
    activeTab = id;
    for (const [tid, body] of bodies) body.hidden = tid !== id;
    for (const [tid, btn] of tabButtons) btn.setAttribute("aria-selected", tid === id ? "true" : "false");
    if (id === "pulse") void run("events.list", { limit: rows }).then((r) => renderList(r.ok ? (r.value as PulseEvent[]) : []));
    if (id === "query") refreshQueryHint();
    if (id === "scenarios") void refreshScenario();
    if (id === "record") void refreshRecordings();
  }

  function setOpen(next: boolean) {
    if (next === open) return;
    open = next;
    if (open) {
      drawer ??= buildDrawer();
      root.append(drawer);
      fab.hidden = true;
      setTab(activeTab);
      refreshStatus();
    } else {
      drawer?.remove();
      fab.hidden = options.fab === false;
    }
  }

  controller.register({ name: "panel.open", summary: "Open the panel (never moves focus). Alias of panel.toggle/panel.tab for agents.", args: { tab: "pulse|query|grab|scenarios|record|<custom>" } }, (a) => {
    setOpen(true);
    if (a.tab !== undefined) setTab(String(a.tab));
    return { open: true, tab: activeTab };
  });
  controller.register({ name: "panel.close", summary: "Close the panel.", ui: "✕" }, () => {
    setOpen(false);
    return { open: false };
  });
  controller.register({ name: "panel.toggle", summary: "Toggle the panel.", ui: "◉ pulse button" }, () => {
    setOpen(!open);
    return { open, tab: activeTab };
  });
  controller.register({ name: "panel.tab", summary: "Switch the panel tab.", args: { name: "tab id" }, ui: "tab strip" }, (a) => {
    setOpen(true);
    setTab(String(a.name ?? "pulse"));
    return { open, tab: activeTab };
  });
  controller.register({ name: "panel.status", summary: "Is the panel open, which tab, which tabs exist.", ui: "panel header" }, () => ({ open, tab: activeTab, tabs: [...bodies.keys()] }));

  (document.body ?? document.documentElement).append(root);
  if (options.open) setOpen(true);

  return {
    root,
    querySlot,
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      if (hotkey) document.removeEventListener("keydown", onKey, true);
      for (const c of cleanups) c();
      for (const n of ["panel.open", "panel.close", "panel.toggle", "panel.tab", "panel.status"]) controller.unregister(n);
      root.remove();
    },
  };
}
