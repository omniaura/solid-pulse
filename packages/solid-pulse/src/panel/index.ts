/**
 * The panel: a raw-DOM floating drawer (no Solid, so it never shows up in the
 * events it displays). Every control carries `data-command="<name>"` and calls
 * `controller.run(name, args)` — exactly what the CLI does. The parity test
 * asserts that every command that declares a `ui` location has a control here
 * and that every control maps to a registered command.
 */

import type { Pulse } from "../index.js";
import type { PulseEvent } from "../core/events.js";
import { RingBuffer } from '../core/ring-buffer.js';
import { MAX_BUFFER_BYTES } from '../core/bus.js';
import { OWN_ATTR } from "../overlay/flash.js";
import { FEATURES, type Feature } from "../core/controller.js";
import { onTools, registeredTools } from './tools.js';
import { discoverSolidGrab } from './grab.js';
import { mountRecordings } from './recordings.js';
export { registerTool, type Devtool } from './tools.js';

export type PanelCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
const CORNERS: PanelCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const mountedPanels = new WeakMap<Pulse, () => void>();

export interface PanelTab {
  id: string;
  title: string;
  /** Called once when the tab body is created; return a cleanup. */
  mount: (el: HTMLElement, pulse: Pulse) => void | (() => void);
}

export interface PanelOptions {
  tabs?: PanelTab[];
  /** Native query devtools mounted inside Query, alongside the agent command controls. */
  queryDevtools?: PanelTab;
  /** Start open (default false). Opening never moves focus. */
  open?: boolean;
  position?: PanelCorner;
  /** Launcher clearance from viewport edges (for app bars), at least 12px. */
  launcherInset?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Persist placement, open state and selected tab; false disables storage. */
  storageKey?: string | false;
  /** Optional live context (for example the active simulator scenario). */
  statusLabel?: () => string;
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
.sp-fab{pointer-events:auto;position:fixed;width:auto;max-width:calc(100vw - 24px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 12px;border-radius:8px;border:1px solid #f59e0b;background:#111827;color:#fbbf24;cursor:pointer;font:inherit}
.sp-fab[hidden]{display:none}
.sp-fab[data-rec="1"]{border-color:#ef4444;color:#fca5a5}
.sp-drawer{pointer-events:auto;position:fixed;width:min(640px,calc(100vw - 24px));height:min(520px,calc(100dvh - 24px));max-height:calc(100dvh - 24px);background:#111827;border:1px solid #4b5563;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;color-scheme:dark}
.sp-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;border-bottom:1px solid #374151;cursor:move;touch-action:none}
.sp-head b{color:#fbbf24}
.sp-tabs{display:flex;flex-wrap:wrap;gap:4px;flex:0 0 100%;order:3;min-width:0}
.sp-tab{background:transparent;border:1px solid transparent;color:#b6c0ce;padding:5px 8px;min-height:30px;border-radius:6px;cursor:pointer;font:inherit}
.sp-tab[aria-selected="true"]{color:#fff;border-color:#4b5563;background:#1f2937}
.sp-body{flex:1;min-height:0;overflow:auto;padding:10px;overflow-wrap:anywhere}
.sp-body[hidden]{display:none}
.sp-row{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-bottom:6px}
.sp-btn{background:#1f2937;border:1px solid #4b5563;color:#e5e7eb;padding:3px 8px;border-radius:6px;cursor:pointer;font:inherit}
.sp-btn:hover{border-color:#9ca3af}
.sp-in{background:#111827;border:1px solid #4b5563;color:#e5e7eb;padding:5px 6px;border-radius:6px;font:inherit;min-width:100px;max-width:100%}
.sp-in::placeholder{color:#9ca3af}
.sp-head .sp-in{min-width:0}
.sp-head [data-command="panel.close"]{margin-left:auto;min-width:32px;min-height:32px}
.sp-body pre{white-space:pre-wrap;overflow-wrap:anywhere}
.sp-btn:focus-visible,.sp-tab:focus-visible,.sp-fab:focus-visible,.sp-in:focus-visible{outline:2px solid #fbbf24;outline-offset:2px}
.sp-list{font-size:11px;white-space:pre-wrap;word-break:break-word}
.sp-ev{padding:2px 4px;border-left:3px solid transparent;cursor:pointer}
.sp-ev:hover{background:#1f2937}
.sp-ev[data-g="solid"]{border-color:#22c55e}.sp-ev[data-g="dom"]{border-color:#f59e0b}.sp-ev[data-g="net"]{border-color:#a78bfa}.sp-ev[data-g="query"]{border-color:#3b82f6}.sp-ev[data-g="pulse"]{border-color:#6b7280}
.sp-ev[data-warn="1"]{background:rgba(239,68,68,.15)}
.sp-ev pre{margin:4px 0 6px 10px;color:#9ca3af;max-height:220px;overflow:auto}
.sp-dim{color:#9ca3af}
.sp-status{display:flex;flex-wrap:wrap;gap:8px;color:#b6c0ce;font-size:12px;flex:0 0 100%;order:4}
.sp-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#6b7280;margin-right:4px}
.sp-dot[data-on="1"]{background:#22c55e}
.sp-record h3{margin:0 0 6px;font-size:14px}.sp-record h4{margin:20px 0 6px;font-size:12px}
.sp-record p{margin:6px 0 10px}.sp-record .sp-btn{min-height:32px}.sp-record .sp-btn:disabled{opacity:.55;cursor:default}
.sp-record [hidden]{display:none}.sp-record progress{display:block;width:100%;height:6px;margin:10px 0 14px;accent-color:#fbbf24}
.sp-record [data-record-state][data-active="true"]{color:#fca5a5}
.sp-record-primary{border-color:#fbbf24;color:#fbbf24}.sp-record .sp-in{flex:1;min-width:160px}
.sp-record-message:empty{display:none}.sp-record-message{color:#fbbf24}
.sp-record-item{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 0;border-bottom:1px solid #374151}
.sp-record-item>div{flex:1;min-width:180px}.sp-record-item p{margin:4px 0 0}
.sp-record-live{margin-top:18px;padding-top:14px;border-top:1px solid #374151}
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
    if (e.truncated) return Boolean(e.data.focusLost);
    const d = e.data as { scrollReset?: Array<{ reset: boolean }>; focusLost?: boolean };
    return Boolean(d.focusLost || d.scrollReset?.some((s) => s.reset));
  }
  return e.kind === "focus.lost" || e.kind.endsWith(".error") || e.kind === "solid.component.remount";
}

function oneLine(e: PulseEvent): string {
  if (e.truncated) return '[truncated] ' + JSON.stringify(e.data).slice(0, 140);
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
  mountedPanels.get(pulse)?.();
  const { controller } = pulse;
  const rows = Math.max(1, Math.min(500, Math.floor(options.rows ?? 150) || 150));
  const root = h("div", { [OWN_ATTR]: "panel-root" });
  const style = h("style");
  style.textContent = CSS;
  root.append(style);
  const fab = h("button", { class: "sp-fab", type: "button", title: "Open developer tools (Alt+Shift+P)", 'aria-label': 'Open developer tools', "data-command": "panel.toggle", onclick: () => void controller.run("panel.toggle") }, "◉ Devtools");
  const storageKey = options.storageKey === undefined ? 'solid-pulse:panel-corner' : options.storageKey;
  let corner: PanelCorner = options.position ?? 'bottom-right';
  try {
    const stored = storageKey && localStorage.getItem(storageKey);
    if (CORNERS.includes(stored as PanelCorner)) corner = stored as PanelCorner;
  } catch { /* storage may be denied */ }
  let floating: { x: number; y: number } | null = null;
  try {
    const stored = storageKey && localStorage.getItem(storageKey + ':floating');
    const point = stored ? JSON.parse(stored) : null;
    if (point && typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)) floating = { x: point.x, y: point.y };
  } catch { /* invalid or unavailable storage */ }
  function savePlacement() {
    try {
      if (!storageKey) return;
      localStorage.setItem(storageKey, corner);
      if (floating) localStorage.setItem(storageKey + ':floating', JSON.stringify(floating));
      else localStorage.removeItem(storageKey + ':floating');
    } catch { /* storage denied */ }
  }
  const pinSelect = h('select', { class: 'sp-in', 'aria-label': 'Pin panel to corner', 'data-command': 'panel.pin', onchange: (e) => void controller.run('panel.pin', { corner: (e.target as HTMLSelectElement).value }) });
  pinSelect.append(h('option', { value: '', disabled: true }, 'Floating — pin to…'));
  for (const c of CORNERS) pinSelect.append(h('option', { value: c }, 'Pin ' + c.replace('-', ' ')));
  function place(el: HTMLElement, free = false) {
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) el.style[edge] = '';
    if (free && floating) {
      floating = {
        x: Math.max(12, Math.min(floating.x, innerWidth - (el.offsetWidth || Math.min(640, innerWidth - 24)) - 12)),
        y: Math.max(12, Math.min(floating.y, innerHeight - (el.offsetHeight || Math.min(520, innerHeight - 24)) - 12)),
      };
      el.style.left = floating.x + 'px';
      el.style.top = floating.y + 'px';
      savePlacement();
    } else {
      for (const edge of [corner.startsWith('top') ? 'top' : 'bottom', corner.endsWith('left') ? 'left' : 'right'] as const) {
        const requested = el === fab ? options.launcherInset?.[edge] : undefined;
        const inset = typeof requested === 'number' && Number.isFinite(requested) ? Math.max(12, requested) : 12;
        el.style[edge] = 'max(' + inset + 'px, env(safe-area-inset-' + edge + '))';
      }
    }
    el.dataset.corner = free && floating ? 'floating' : corner;
  }
  place(fab);
  pinSelect.value = floating ? '' : corner;
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
  let savedView: { open?: boolean; tab?: string } = {};
  try {
    const value = storageKey && JSON.parse(localStorage.getItem(storageKey + ':view') ?? 'null');
    if (value?.version === 1) savedView = { open: typeof value.open === 'boolean' ? value.open : undefined, tab: typeof value.tab === 'string' ? value.tab : undefined };
  } catch { /* Storage is optional. */ }
  function saveView() {
    try { if (storageKey) localStorage.setItem(storageKey + ':view', JSON.stringify({ version: 1, open, tab: savedView.tab ?? activeTab })); }
    catch { /* Storage denied. */ }
  }
  const bodies = new Map<string, HTMLElement>();
  const tabButtons = new Map<string, HTMLButtonElement>();
  const cleanups: Array<() => void> = [];
  const titles: Record<string, string> = { pulse: 'Pulse', query: 'Query', grab: 'Inspect', scenarios: 'Scenarios', record: 'Record' };
  let tabs: HTMLDivElement | null = null;
  let disposed = false;
  const toolCleanups = new Map<string, () => void>();
  const toolBodies = new Map<string, HTMLElement>();

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
  kindsIn.value = controller.filters.kinds.join(',');
  compIn.value = controller.filters.component;
  textIn.value = controller.filters.text;
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
    pending.clear();
    list.textContent = "";
    for (const e of events.slice(-rows)) list.append(rowFor(e));
    list.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  const pending = new RingBuffer<PulseEvent>(rows);
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let autoScroll = true;
  function flushRows() {
    renderTimer = undefined;
    const retained = new Set(controller.bus.list({ limit: controller.bus.buffer.capacity }).map(e => e.seq));
    const events = pending.toArray().filter(e => retained.has(e.seq));
    pending.clear();
    if (!open || activeTab !== 'pulse' || document.hidden || !events.length) return;
    const fragment = document.createDocumentFragment();
    for (const e of events) fragment.append(rowFor(e));
    while (list.children.length + events.length > rows) list.firstElementChild?.remove();
    list.append(fragment);
    if (autoScroll) pulseBody.scrollTop = pulseBody.scrollHeight;
  }
  cleanups.push(() => { if (renderTimer) clearTimeout(renderTimer); pending.clear(); });
  pulseBody.addEventListener("scroll", () => {
    autoScroll = pulseBody.scrollTop + pulseBody.clientHeight >= pulseBody.scrollHeight - 24;
  });
  cleanups.push(
    controller.bus.subscribe((e) => {
      if (!open || activeTab !== "pulse" || document.hidden) return;
      if (!controller.matchesFilters(e)) return;
      pending.push(e);
      if (!renderTimer) renderTimer = setTimeout(flushRows, 100);
    }),
  );
  cleanups.push(controller.onFeature((f, on) => {
    const box = featureBoxes.get(f);
    if (box) box.checked = on;
  }));
  cleanups.push(controller.onFilters((f) => {
    pending.clear();
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
  let queryMounted = false;

  // ── Grab tab ─────────────────────────────────────────────────────
  const grabBody = h("div", { class: "sp-body" });
  const selIn = h("input", { class: "sp-in", placeholder: "CSS selector", "data-arg": "selector" });
  const inspectSlot = h('div', { 'data-slot': 'inspect-tools' });
  const fallbackPicker = h("button", { class: "sp-btn", type: "button", "data-command": "inspect.element", onclick: () => pickElement() }, "Pick element (click)");
  grabBody.append(
    h("div", { class: "sp-row" },
      fallbackPicker,
      selIn,
      h("button", { class: "sp-btn", type: "button", "data-command": "inspect.element", "data-arg": "selector", onclick: () => void run("inspect.element", { selector: selIn.value }).then((r) => showResult(grabBody, r.ok ? r.value : r.error)) }, "Inspect selector"),
      h("button", { class: "sp-btn", type: "button", "data-command": "dom.highlight", onclick: () => void run("dom.highlight", { selector: selIn.value, all: true }).then((r) => showResult(grabBody, r.ok ? r.value : r.error)) }, "Highlight"),
    ),
  );
  grabBody.prepend(inspectSlot);
  bodies.set("grab", grabBody);

  let cancelPick: (() => void) | undefined;
  cleanups.push(() => cancelPick?.());
  function pickElement() {
    cancelPick?.();
    const cancel = () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onEscape, true);
      cancelPick = undefined;
    };
    const onEscape = (ev: KeyboardEvent) => { if (ev.key === 'Escape') cancel(); };
    const onClick = (ev: MouseEvent) => {
      if ((ev.target as Element).closest('[data-solid-pulse]')) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      cancel();
      void run("inspect.element", { x: ev.clientX, y: ev.clientY }).then((r) => {
        showResult(grabBody, r.ok ? r.value : r.error);
        if (r.ok) void run("dom.highlight", { selector: (r.value as { selector: string }).selector });
      });
    };
    cancelPick = cancel;
    document.addEventListener('keydown', onEscape, true);
    document.addEventListener("click", onClick, true);
  }

  // ── Scenarios tab (present when a scenario client registered commands) ──
  const scenBody = h("div", { class: "sp-body" });
  const scenSelect = h("select", { class: "sp-in", "data-command": "scenario.select", onchange: (e) => void run("scenario.select", { name: (e.target as HTMLSelectElement).value }).then(refreshScenario) });
  const seedIn = h("input", { class: "sp-in", placeholder: "seed (optional)", "data-arg": "seed" });
  const stepIn = h("input", { class: "sp-in", placeholder: "step ms (default 1000)", "data-arg": "ms" });
  const scenStatus = h("pre", { class: "sp-dim" });
  const latencyIn = h('input', { class: 'sp-in', type: 'number', min: '0', placeholder: 'Latency ms', 'aria-label': 'Latency milliseconds' });
  const failIn = h('select', { class: 'sp-in', 'aria-label': 'Failure mode' });
  for (const mode of ['off', 'data', 'all']) failIn.append(h('option', { value: mode }, mode === 'off' ? 'Failures off' : 'Fail ' + mode + ' requests'));
  const faultRow = h('div', { class: 'sp-row' }, latencyIn, failIn,
    h('button', { class: 'sp-btn', type: 'button', 'data-command': 'scenario.faults', onclick: () => {
      void run('scenario.faults', { latencyMs: latencyIn.value ? Number(latencyIn.value) : undefined, failMode: failIn.value }).then(r => {
        if (!r.ok) showResult(scenBody, { error: r.error }); else void refreshScenario();
      });
    } }, 'Apply faults'));
  const advanced = h('details');
  advanced.append(h('summary', {}, 'All simulator commands'));
  const commandForms = h('div');
  advanced.append(commandForms);
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
    faultRow, advanced, scenStatus,
  );
  bodies.set("scenarios", scenBody);

  async function refreshScenario() {
    if (!controller.has("scenario.list")) {
      scenStatus.textContent = "no scenario simulator attached (attach @omniaura/scenario-sim's pulse adapter)";
      return;
    }
    const listRes = await run("scenario.list");
    const status = await run("scenario.status");
    if (disposed) return;
    if (status.ok) {
      const faults = (status.value as { faults?: { latencyMs?: number; failMode?: string } }).faults;
      if (faults) { latencyIn.value = String(faults.latencyMs ?? 0); failIn.value = faults.failMode ?? 'off'; }
    }
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
  const recordings = mountRecordings(pulse, () => open && activeTab === "record");
  bodies.set("record", recordings.body);
  cleanups.push(recordings.dispose);

  for (const tab of options.tabs ?? []) {
    if (bodies.has(tab.id)) throw new Error('Duplicate tab: ' + tab.id);
    titles[tab.id] = tab.title;
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
    const label = options.statusLabel?.();
    fab.textContent = '◉ Devtools' + (label ? ' · ' + label : '');
    fab.setAttribute('aria-label', 'Open developer tools' + (label ? ': ' + label : ''));
    bridgeDot.dataset.on = pulse.bridge?.connected ? "1" : "0";
    recDot.dataset.on = controller.bus.currentRecording() ? "1" : "0";
    fab.dataset.rec = controller.bus.currentRecording() ? "1" : "0";
    pauseBtn.textContent = controller.bus.paused ? "Resume" : "Pause";
    statusText.textContent = `${controller.bus.buffer.size}/${controller.bus.buffer.capacity} buffered · ~${(controller.bus.bytes / 1048576).toFixed(1)}/${MAX_BUFFER_BYTES / 1048576} MiB · ${controller.bus.buffer.dropped} evicted · ${controller.bus.truncated} truncated${pulse.bridge ? ` · bridge ${pulse.bridge.dropped} dropped` : ""}`;
  }
  const statusTimer = setInterval(refreshStatus, 1000);
  cleanups.push(() => clearInterval(statusTimer));

  function buildDrawer() {
    tabs = h("div", { class: "sp-tabs", role: "tablist", 'aria-label': 'Developer tools' });
    renderTabs();
    const head = h("div", { class: "sp-head" },
      h("b", {}, "◉ Devtools"),
      pinSelect,
      h("button", { class: "sp-btn", type: "button", 'aria-label': 'Close developer tools', "data-command": "panel.close", onclick: () => void run("panel.close") }, "✕"),
      tabs,
      h("span", { class: "sp-status" }, h("span", {}, bridgeDot, "bridge"), h("span", {}, recDot, "rec"), statusText),
    );
    const d = h("div", { class: "sp-drawer", role: "region", "aria-label": "solid-pulse" }, head, ...bodies.values());
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('button,select,input')) return;
      const rect = d.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      void run('panel.move', { x: drag.left + e.clientX - drag.x, y: drag.top + e.clientY - drag.y });
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) head.addEventListener(event, () => { drag = null; });
    return d;
  }

  function available(id: string) {
    return id === 'query' ? Boolean(options.queryDevtools) || controller.has('inspect.queries') : id === 'scenarios' ? controller.has('scenario.list') : true;
  }
  function renderTabs() {
    if (!tabs) return;
    tabs.replaceChildren();
    tabButtons.clear();
    for (const [id, body] of bodies) {
      if (!available(id)) { body.hidden = true; continue; }
      const btn = h("button", { class: "sp-tab", type: "button", role: "tab", "data-command": "panel.tab", "data-tab": id, onclick: () => void run("panel.tab", { name: id }) }, titles[id] ?? id);
      btn.setAttribute('aria-selected', String(id === activeTab));
      tabButtons.set(id, btn);
      tabs.append(btn);
      body.hidden = id !== activeTab;
    }
  }

  function setTab(id: string) {
    if (id === 'solid-grab') id = 'grab'; // Backward-compatible agent/bookmark alias.
    if (id === 'tanstack' && options.queryDevtools) id = 'query';
    if (!bodies.has(id) || !available(id)) throw new Error(`unknown tab: ${id} (${[...bodies.keys()].filter(available).join(", ")})`);
    activeTab = id;
    saveView();
    for (const [tid, body] of bodies) body.hidden = tid !== id;
    for (const [tid, btn] of tabButtons) btn.setAttribute("aria-selected", tid === id ? "true" : "false");
    if (id === "pulse") void run("events.list", { limit: rows }).then((r) => renderList(r.ok ? (r.value as PulseEvent[]) : []));
    if (id === "query") {
      refreshQueryHint();
      if (options.queryDevtools && !queryMounted) {
        queryMounted = true;
        const cleanup = options.queryDevtools.mount(querySlot, pulse);
        if (cleanup) cleanups.push(cleanup);
      }
    }
    if (id === "scenarios") void refreshScenario();
    if (id === "record") recordings.refresh();
  }

  function setOpen(next: boolean) {
    if (next === open) return;
    open = next;
    saveView();
    if (open) {
      drawer ??= buildDrawer();
      root.append(drawer);
      place(drawer, true);
      fab.hidden = true;
      setTab(activeTab);
      refreshStatus();
    } else {
      cancelPick?.();
      drawer?.remove();
      fab.hidden = options.fab === false;
    }
  }

  controller.register({ name: "panel.open", summary: "Open the panel (never moves focus). Alias of panel.toggle/panel.tab for agents.", args: { tab: "pulse|query|grab|scenarios|record|<custom>" } }, (a) => {
    setOpen(true);
    if (a.tab !== undefined) { savedView.tab = undefined; setTab(String(a.tab)); }
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
    savedView.tab = undefined;
    setOpen(true);
    setTab(String(a.name ?? "pulse"));
    return { open, tab: activeTab };
  });
  controller.register({ name: "panel.status", summary: "Panel visibility, available tools and floating/pinned placement.", ui: "panel header" }, () => ({ open, tab: activeTab, tabs: [...bodies.keys()].filter(available), corner, floating }));
  controller.register({ name: 'panel.pin', summary: 'Pin panel and launcher to a viewport corner.', args: { corner: CORNERS.join('|') }, ui: 'panel corner selector' }, (a) => {
    if (!CORNERS.includes(a.corner as PanelCorner)) throw new Error('Invalid corner');
    corner = a.corner as PanelCorner;
    floating = null;
    pinSelect.value = corner;
    place(fab);
    if (drawer) place(drawer);
    savePlacement();
    return { corner };
  });
  controller.register({ name: 'panel.move', summary: 'Float the panel at viewport coordinates.', args: { x: 'pixels', y: 'pixels' } }, (a) => {
    if (typeof a.x !== 'number' || typeof a.y !== 'number' || !Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error('Finite x/y required');
    floating = { x: a.x, y: a.y };
    pinSelect.value = '';
    setOpen(true);
    place(drawer!, true);
    return { floating };
  });
  const resize = () => { place(fab); if (drawer && open) place(drawer, true); };
  window.addEventListener('resize', resize);
  cleanups.push(() => window.removeEventListener('resize', resize));
  function syncTools() {
    const tools = registeredTools(pulse);
    for (const [id, cleanup] of toolCleanups) {
      if (tools.some(t => t.id === id)) continue;
      cleanup();
      toolCleanups.delete(id);
      toolBodies.get(id)?.remove();
      toolBodies.delete(id);
      bodies.delete(id);
    }
    for (const tool of tools) {
      if (toolCleanups.has(tool.id)) continue;
      const body = h('div', { class: 'sp-body' });
      let cleanup: void | (() => void) = undefined;
      try { cleanup = tool.mount(body, pulse); }
      catch (error) { body.textContent = tool.title + ' could not mount: ' + String(error); }
      toolCleanups.set(tool.id, cleanup ?? (() => {}));
      toolBodies.set(tool.id, body);
      if (tool.slot === 'inspect') {
        body.className = '';
        inspectSlot.append(body);
        continue;
      }
      titles[tool.id] = tool.title;
      bodies.set(tool.id, body);
      body.hidden = tool.id !== activeTab;
      drawer?.append(body);
    }
    fallbackPicker.hidden = tools.some(t => t.id === 'solid-grab');
    if (fallbackPicker.hidden) cancelPick?.();
    if (savedView.tab) {
      const desired = savedView.tab === 'solid-grab' ? 'grab' : savedView.tab;
      if (bodies.has(desired) && available(desired)) { activeTab = desired; savedView.tab = undefined; if (open) setTab(desired); }
    }
    if (!bodies.has(activeTab) || !available(activeTab)) activeTab = 'pulse';
    queryBody.hidden = activeTab !== 'query' || !available('query');
    scenBody.hidden = activeTab !== 'scenarios' || !available('scenarios');
    if (controller.has('scenario.faults')) {
      if (!faultRow.isConnected) scenBody.insertBefore(faultRow, advanced);
    } else faultRow.remove();
    const existing = new Set([...commandForms.children].map(el => (el as HTMLElement).dataset.name));
    for (const spec of controller.describe().filter(s => s.name.startsWith('scenario.'))) {
      if (existing.has(spec.name)) continue;
      const fields = new Map<string, HTMLInputElement>();
      const form = h('form', { 'data-name': spec.name });
      form.append(h('p', {}, spec.summary));
      for (const [key, description] of Object.entries(spec.args ?? {})) {
        const input = h('input', { class: 'sp-in', placeholder: description, 'aria-label': spec.name + ' ' + key });
        fields.set(key, input);
        form.append(h('label', {}, key + ' ', input));
      }
      const output = h('pre', { 'aria-live': 'polite' });
      form.append(h('button', { class: 'sp-btn', type: 'submit', 'data-command': spec.name }, spec.name), output);
      form.addEventListener('submit', e => {
        e.preventDefault();
        const args: Record<string, unknown> = {};
        for (const [key, input] of fields) if (input.value !== '') {
          try { args[key] = JSON.parse(input.value); } catch { args[key] = input.value; }
        }
        void run(spec.name, args).then(r => { output.textContent = JSON.stringify(r.ok ? r.value : { error: r.error }, null, 2); });
      });
      commandForms.append(form);
    }
    for (const el of [...commandForms.children]) if (!controller.has((el as HTMLElement).dataset.name!)) el.remove();
    renderTabs();
  }
  cleanups.push(onTools(pulse, syncTools));
  cleanups.push(controller.onCommands(() => queueMicrotask(() => { if (!disposed) syncTools(); })));
  syncTools();
  cleanups.push(discoverSolidGrab(pulse));

  (document.body ?? document.documentElement).append(root);
  refreshStatus();
  if (options.open ?? savedView.open) setOpen(true);

  const panel = {
    root,
    querySlot,
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      if (disposed) return;
      disposed = true;
      if (hotkey) document.removeEventListener("keydown", onKey, true);
      for (const c of cleanups) c();
      for (const cleanup of toolCleanups.values()) cleanup();
      for (const n of ["panel.open", "panel.close", "panel.toggle", "panel.tab", "panel.status", 'panel.pin', 'panel.move']) controller.unregister(n);
      root.remove();
      mountedPanels.delete(pulse);
    },
  };
  mountedPanels.set(pulse, panel.destroy);
  cleanups.push(pulse.onDestroy(panel.destroy));
  return panel;
}
