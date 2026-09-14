/**
 * DOM observation. A MutationObserver tells us what actually changed on
 * screen; nothing here infers "rerenders". Beyond plain mutations it detects
 * the pattern that costs people days: a subtree is removed and the *same node
 * instance* is re-inserted moments later (a Suspense boundary flipping to its
 * fallback and back, a keyed <Show>/<Switch> toggling). That detach/reattach
 * silently resets scroll positions to 0 and drops focus to <body>, with no
 * component cleanup running — so we record scrollTop and focus at detach time
 * and compare after reattach.
 */

import type { PulseController } from "../core/controller.js";
import type { ComponentRef, ElementRef, Rect } from "../core/events.js";
import { FlashOverlay, OWN_ATTR } from "../overlay/flash.js";
import type { SolidInstrumentation } from "./instrument.js";

const MAX_TARGETS_PER_BATCH = 40;
const MAX_TARGETS_IN_EVENT = 25;
const MAX_TRACKED_SCROLLERS = 50;
const MAX_DETACHED = 200;
const DETACHED_TTL_MS = 3000;

interface DetachRecord {
  t: number;
  desc: ElementRef;
  scrollers: { el: Element; desc: ElementRef; scrollTop: number }[];
  hadFocus: boolean;
  focused: ElementRef | null;
  component: ComponentRef | null;
}

export function describeElement(el: Element, withRect = true): ElementRef {
  const out: ElementRef = { tag: el.tagName.toLowerCase() };
  if (el.id) out.id = el.id;
  const testId = el.getAttribute("data-testid");
  if (testId) out.testId = testId;
  const cls = typeof el.className === "string" ? el.className.trim() : "";
  if (cls) out.classes = cls.length > 80 ? cls.slice(0, 77) + "..." : cls;
  const comp = el.closest("[data-solid-component]");
  out.component = comp ? comp.getAttribute("data-solid-component") : null;
  const src = el.closest("[data-solid-source]");
  out.source = src ? src.getAttribute("data-solid-source") : null;
  if (withRect) {
    const r = el.getBoundingClientRect();
    out.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  return out;
}

export function toSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 5 && cur !== document.documentElement) {
    const parent: Element | null = cur.parentElement;
    let part = cur.tagName.toLowerCase();
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    if (cur.id) {
      parts[0] = `#${cssEscape(cur.id)}`;
      break;
    }
    cur = parent;
  }
  return parts.join(" > ");
}

function cssEscape(s: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export interface DomInstrumentation {
  dispose(): void;
}

/**
 * Run after the next paint — or after 50 ms if no frame comes (hidden tabs and
 * headless runs throttle requestAnimationFrame, and a reattach report must not
 * wait for the tab to be foregrounded).
 */
function nextFrame(fn: () => void) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, 50);
}

export function installDom(controller: PulseController, solid: SolidInstrumentation | null, overlay: FlashOverlay | null): DomInstrumentation {
  const bus = controller.bus;
  const scrollTops = new Map<Element, number>();
  let lastFocused: Element | null = null;
  const detached = new Map<Node, DetachRecord>();
  const now = () => performance.now();

  const isOwn = (n: Node): boolean => {
    const el = n instanceof Element ? n : n.parentElement;
    return el ? el.closest(`[${OWN_ATTR}]`) !== null : false;
  };

  const onScroll = (e: Event) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    scrollTops.delete(t);
    scrollTops.set(t, t.scrollTop);
    if (scrollTops.size > MAX_TRACKED_SCROLLERS) {
      const oldest = scrollTops.keys().next().value;
      if (oldest) scrollTops.delete(oldest);
    }
  };
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Element && !isOwn(e.target)) lastFocused = e.target;
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("focusin", onFocusIn, true);
  // Headless/background pages often do not dispatch focusin for programmatic
  // `el.focus()` (the window has no system focus), so also sample the active
  // element cheaply; agent-driven QA relies on this.
  const focusPoll = setInterval(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement && !isOwn(active)) lastFocused = active;
  }, 200);

  function attributionFor(target: Element, flushComps: ComponentRef[]): ComponentRef | null {
    if (flushComps.length === 1) return flushComps[0]!;
    const named = target.closest("[data-solid-component]")?.getAttribute("data-solid-component");
    if (named) {
      const match = flushComps.find((c) => c.name === named);
      if (match) return match;
      return { id: -1, name: named };
    }
    return flushComps.length > 1 ? null : null;
  }

  function pruneDetached(t: number) {
    for (const [node, rec] of detached) {
      if (t - rec.t > DETACHED_TTL_MS) detached.delete(node);
      else break;
    }
    while (detached.size > MAX_DETACHED) {
      const oldest = detached.keys().next().value;
      if (oldest === undefined) break;
      detached.delete(oldest);
    }
  }
  const pruneTimer = setInterval(() => pruneDetached(now()), DETACHED_TTL_MS);

  const observer = new MutationObserver((records) => {
    if ((globalThis as { __PULSE_DEBUG?: boolean }).__PULSE_DEBUG) console.error("DBG-MO", records.map((r) => `${r.type}:${(r.target as Element).tagName ?? "?"}:+${r.addedNodes.length}/-${r.removedNodes.length}`).join(" "), "dom on:", controller.isOn("dom"));
    if (!controller.isOn("dom")) return;
    const t = now();
    const flush = solid?.flushId() ?? 0;
    const flushComps = solid?.lastFlushComponents() ?? [];
    const targets = new Map<Element, { types: Set<string>; attrs: Set<string>; added: number; removed: number }>();
    const detachedNow: DetachRecord[] = [];
    const reattached: { node: Element; rec: DetachRecord }[] = [];

    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!target || isOwn(target)) continue;
      let info = targets.get(target);
      if (!info) {
        if (targets.size >= MAX_TARGETS_PER_BATCH) continue;
        info = { types: new Set(), attrs: new Set(), added: 0, removed: 0 };
        targets.set(target, info);
      }
      info.types.add(r.type);
      if (r.type === "attributes" && r.attributeName) info.attrs.add(r.attributeName);
      info.added += r.addedNodes.length;
      info.removed += r.removedNodes.length;

      for (const n of r.removedNodes) {
        if (!(n instanceof Element) || isOwn(n)) continue;
        const scrollers: DetachRecord["scrollers"] = [];
        for (const [el, top] of scrollTops) {
          if (top > 0 && (n === el || n.contains(el))) scrollers.push({ el, desc: describeElement(el, false), scrollTop: top });
        }
        const hadFocus = lastFocused !== null && (n === lastFocused || n.contains(lastFocused));
        const rec: DetachRecord = {
          t,
          desc: describeElement(n, false),
          scrollers,
          hadFocus,
          focused: hadFocus && lastFocused ? describeElement(lastFocused, false) : null,
          component: attributionFor(n, flushComps),
        };
        detached.set(n, rec);
        if (scrollers.length || hadFocus) detachedNow.push(rec);
      }
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue;
        const rec = detached.get(n);
        if (rec) {
          detached.delete(n);
          reattached.push({ node: n, rec });
        }
      }
    }
    pruneDetached(t);

    if (targets.size > 0) {
      // Never measure inside the observer callback: a forced layout here (a
      // microtask between frames) can feed a positioning library's
      // ResizeObserver/autoUpdate loop and keep the page's own elements moving.
      // Rects for flashing are read once, in the next animation frame.
      const wantRects = Boolean(overlay && controller.isOn("flash"));
      const flashTargets: Element[] = [];
      const summary: Array<ElementRef & { types: string[]; attrs?: string[]; added?: number; removed?: number }> = [];
      let attributed: ComponentRef | null = null;
      let i = 0;
      for (const [el, info] of targets) {
        if (wantRects && flashTargets.length < MAX_TARGETS_IN_EVENT) flashTargets.push(el);
        if (i < MAX_TARGETS_IN_EVENT) {
          const desc = describeElement(el, false);
          {
            summary.push({
              ...desc,
              types: [...info.types],
              ...(info.attrs.size ? { attrs: [...info.attrs] } : {}),
              ...(info.added ? { added: info.added } : {}),
              ...(info.removed ? { removed: info.removed } : {}),
            });
          }
        }
        const comp = attributionFor(el, flushComps);
        if (comp && !attributed) attributed = comp;
        if (solid && comp && comp.id > 0 && el.isConnected) solid.attachElement(comp.id, el);
        i++;
      }
      bus.emit(
        "dom.mutation",
        {
          records: records.length,
          targets: targets.size,
          summary,
          attributedTo: flushComps.length === 1 ? "single-component-flush" : flushComps.length > 1 ? "multi-component-flush" : "outside-solid-flush",
        },
        { flush, component: attributed },
      );
      if (wantRects && flashTargets.length) {
        const label = attributed?.name;
        nextFrame(() => {
          const rects: Rect[] = [];
          for (const el of flashTargets) {
            if (!el.isConnected) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
          }
          if (rects.length) overlay!.flash(rects, "dom", { label });
        });
      }
    }

    for (const rec of detachedNow) {
      bus.emit(
        "dom.detach",
        {
          element: rec.desc,
          scrollers: rec.scrollers.map((s) => ({ element: s.desc, scrollTop: s.scrollTop })),
          hadFocus: rec.hadFocus,
          focused: rec.focused,
        },
        { flush, component: rec.component },
      );
    }

    if (reattached.length) {
      nextFrame(() => {
        const t2 = now();
        for (const { node, rec } of reattached) {
          const scrollReset = rec.scrollers.map((s) => ({
            element: s.desc,
            before: s.scrollTop,
            after: s.el.scrollTop,
            reset: s.scrollTop > 0 && s.el.scrollTop === 0,
          }));
          const focusLost = rec.hadFocus && !node.contains(document.activeElement);
          const chain = rec.component?.chain ?? [];
          const data = {
            element: rec.desc,
            gapMs: Math.round((t2 - rec.t) * 100) / 100,
            scrollReset,
            focusLost,
            suspenseInChain: chain.includes("Suspense"),
            selector: toSelector(node),
          };
          bus.emit("dom.reattach", data, { flush, component: rec.component });
          if (overlay && controller.isOn("flash") && node.isConnected) {
            const r = node.getBoundingClientRect();
            overlay.flash([{ x: r.left, y: r.top, w: r.width, h: r.height }], "reattach", {
              ms: 900,
              label: `reattach ${scrollReset.some((s) => s.reset) ? "· scroll reset" : ""}${focusLost ? " · focus lost" : ""}`.trim(),
            });
          }
        }
      });
    }

    if (lastFocused && !lastFocused.isConnected) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        bus.emit("focus.lost", { element: describeElement(lastFocused, false), cause: "element removed from document" }, { flush });
      }
      lastFocused = null;
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

  // ── commands ─────────────────────────────────────────────────────

  function grabContext(el: Element) {
    const grab = (window as unknown as { __SOLID_GRAB__?: { inspect?: (el: HTMLElement) => { formatted: string; elementSource: unknown; components: unknown } } }).__SOLID_GRAB__;
    const desc = describeElement(el);
    const ctx = grab?.inspect && el instanceof HTMLElement ? grab.inspect(el) : null;
    return {
      element: desc,
      selector: toSelector(el),
      pulseComponent: solid ? (() => {
        for (const c of solid.components()) if (solid.elementsFor(c.id).includes(el)) return { id: c.id, name: c.name };
        return null;
      })() : null,
      grab: ctx ? { formatted: ctx.formatted, elementSource: ctx.elementSource, components: ctx.components } : null,
      html: el.outerHTML.length > 500 ? el.outerHTML.slice(0, 500) + "..." : el.outerHTML,
    };
  }

  controller.register(
    {
      name: "inspect.element",
      summary: "Element → source context: data-solid-source/component, solid-grab formatted context when installed, pulse component attribution.",
      args: { selector: "CSS selector (first match)", x: "viewport x (with y, instead of selector)", y: "viewport y" },
      ui: "Grab tab › Pick element (Alt+click via solid-grab)",
    },
    (a) => {
      let el: Element | null = null;
      if (a.selector !== undefined) el = document.querySelector(String(a.selector));
      else if (a.x !== undefined && a.y !== undefined) {
        const hit = document.elementsFromPoint(Number(a.x), Number(a.y)).find((e) => !isOwn(e));
        el = hit ?? null;
      }
      if (!el) throw new Error("no element matched");
      return grabContext(el);
    },
  );
  controller.register(
    { name: "dom.highlight", summary: "Flash an outline around matching elements so a human can see what an agent is looking at.", args: { selector: "CSS selector", ms: "duration (default 1200)", all: "true = every match (max 20)" }, ui: "Grab tab › Highlight" },
    (a) => {
      if (!overlay) throw new Error("overlay not mounted");
      const all = a.all === true || a.all === "true";
      const nodes = all ? [...document.querySelectorAll(String(a.selector))].slice(0, 20) : [document.querySelector(String(a.selector))].filter(Boolean) as Element[];
      const rects = nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      overlay.flash(rects, "highlight", { ms: a.ms === undefined ? 1200 : Number(a.ms), label: String(a.selector) });
      return { matched: nodes.length, rects };
    },
  );
  controller.register(
    { name: "inspect.focus", summary: "Active element and the last element that had focus.", ui: "Pulse tab › footer" },
    () => ({
      active: document.activeElement && document.activeElement !== document.body ? describeElement(document.activeElement) : null,
      lastFocused: lastFocused ? describeElement(lastFocused) : null,
    }),
  );
  controller.register(
    { name: "inspect.scrollers", summary: "Elements that have scrolled recently with their last scrollTop.", ui: "Pulse tab › footer" },
    () => [...scrollTops].map(([el, top]) => ({ element: describeElement(el, false), selector: toSelector(el), scrollTop: top, connected: el.isConnected })),
  );

  return {
    dispose() {
      observer.disconnect();
      clearInterval(focusPoll);
      clearInterval(pruneTimer);
      detached.clear();
      scrollTops.clear();
      lastFocused = null;
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("focusin", onFocusIn, true);
      controller.unregister("inspect.element");
      controller.unregister("dom.highlight");
      controller.unregister("inspect.focus");
      controller.unregister("inspect.scrollers");
    },
  };
}
