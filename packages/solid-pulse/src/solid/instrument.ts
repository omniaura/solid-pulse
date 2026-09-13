/**
 * Solid instrumentation through the official dev hooks (`DEV.hooks`), which
 * exist only in Solid's development build. In a production build `DEV` is
 * undefined and this module becomes a no-op — nothing is patched.
 *
 * What we see, precisely:
 *  - `afterCreateOwner(owner)` fires for every root, computation and (in dev)
 *    every component: dev components are computations carrying `.component`.
 *  - We wrap each non-component computation's `fn` so we know when a memo /
 *    effect / render-effect actually re-runs. Solid never re-runs component
 *    bodies, so there is no "rerender" to report — only these.
 *  - `afterUpdate()` marks the end of a synchronous update; together with a
 *    microtask fallback it closes a "flush" group used to attribute DOM
 *    mutations to the computations that produced them.
 *  - `sharedConfig.context` is set while hydrating, so mounts during hydration
 *    are labelled as such.
 */

import { DEV, getOwner, sharedConfig } from "solid-js";
import type { PulseController } from "../core/controller.js";
import type { ComponentRef, Rect } from "../core/events.js";

type Fn = (...args: unknown[]) => unknown;

interface OwnerLike {
  fn?: Fn;
  component?: Fn;
  name?: string;
  pure?: boolean;
  user?: boolean;
  comparator?: unknown;
  owner?: OwnerLike | null;
  cleanups?: (() => void)[] | null;
}

export interface ComponentInfo {
  id: number;
  name: string;
  parent: number | null;
  hydrated: boolean;
  mountedAt: number;
  mountedWall: number;
  flush: number;
  disposedAt: number | null;
}

export type ComputationKind = "memo" | "computed" | "effect" | "render";

export interface FlushSummary {
  id: number;
  computations: number;
  byKind: Record<ComputationKind, number>;
  byComponent: Record<string, number>;
  components: ComponentRef[];
}

export interface SolidInstrumentation {
  readonly available: boolean;
  flushId(): number;
  /** Components whose computations ran in the most recently closed flush. */
  lastFlushComponents(): ComponentRef[];
  componentFor(owner: unknown): ComponentRef | null;
  currentComponent(): ComponentRef | null;
  components(): ComponentInfo[];
  attachElement(componentId: number, el: Element): void;
  rectFor(component: ComponentRef): Rect | null;
  elementsFor(componentId: number): Element[];
  dispose(): void;
}

const MAX_RECENT_DISPOSED = 64;
const MAX_ELEMENTS_PER_COMPONENT = 8;

export function installSolid(controller: PulseController): SolidInstrumentation {
  const bus = controller.bus;
  const hooks = (DEV as { hooks?: Record<string, Fn | null> } | undefined)?.hooks;

  const compByOwner = new WeakMap<object, ComponentInfo>();
  const live = new Map<number, ComponentInfo>();
  const elements = new Map<number, WeakRef<Element>[]>();
  const recentDisposed = new Map<string, { t: number; flush: number }>();
  let nextId = 1;
  let flushId = 0;
  let flushOpen = false;
  let runs = 0;
  let byKind: Record<ComputationKind, number> = { memo: 0, computed: 0, effect: 0, render: 0 };
  let byComponent = new Map<string, number>();
  let componentsRan = new Map<number, ComponentRef>();
  let lastClosed: ComponentRef[] = [];
  let roots = 0;

  const now = () => performance.now();

  function toRef(info: ComponentInfo | null): ComponentRef | null {
    if (!info) return null;
    const chain: string[] = [];
    let cur: ComponentInfo | undefined = info;
    while (cur && chain.length < 8) {
      chain.push(cur.name);
      cur = cur.parent === null ? undefined : live.get(cur.parent);
    }
    return { id: info.id, name: info.name, chain };
  }

  function componentInfoFor(owner: unknown): ComponentInfo | null {
    let cur = owner as OwnerLike | null | undefined;
    let hops = 0;
    while (cur && hops++ < 200) {
      const info = compByOwner.get(cur as object);
      if (info) return info;
      cur = cur.owner;
    }
    return null;
  }

  function ensureFlush() {
    if (flushOpen) return;
    flushOpen = true;
    flushId++;
    queueMicrotask(closeFlush);
  }

  function closeFlush() {
    if (!flushOpen) return;
    flushOpen = false;
    lastClosed = [...componentsRan.values()];
    if (runs > 0 || componentsRan.size > 0) {
      const topComponents: Record<string, number> = {};
      const sorted = [...byComponent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [name, n] of sorted) topComponents[name] = n;
      bus.emit(
        "solid.flush",
        {
          computations: runs,
          byKind: { ...byKind },
          byComponent: topComponents,
          components: lastClosed.map((c) => c.name),
        },
        { flush: flushId, component: lastClosed.length === 1 ? lastClosed[0] : null },
      );
    }
    runs = 0;
    byKind = { memo: 0, computed: 0, effect: 0, render: 0 };
    byComponent = new Map();
    componentsRan = new Map();
  }

  function kindOf(owner: OwnerLike): ComputationKind {
    if (owner.pure) return owner.comparator !== undefined ? "memo" : "computed";
    return owner.user ? "effect" : "render";
  }

  function wrapComputation(owner: OwnerLike) {
    const orig = owner.fn;
    if (typeof orig !== "function") return;
    // `comparator` (memos) and `user` (effects) are assigned by their creators
    // after createComputation returns, so the kind is settled at the first run.
    let kind: ComputationKind = "render";
    let first = true;
    let isComponent = false;
    owner.fn = function pulseWrapped(this: unknown, ...args: unknown[]) {
      if (first) {
        first = false;
        // Dev components are computations too: `devComponent` creates the
        // computation (our hook fires here, before `.component` is assigned)
        // and then runs it once with `.component` set. So the creation run is
        // where a component reveals itself — that run is its mount. For every
        // other computation the creation run is a mount as well, not an update.
        if (owner.component) {
          isComponent = true;
          registerComponent(owner);
        } else {
          kind = kindOf(owner);
        }
        return orig.apply(this, args);
      }
      if (isComponent) {
        // Solid never re-runs a component body; if it ever did we would still
        // not call it a rerender — report it for what it is.
        if (controller.isOn("solid")) bus.emit("pulse.note", { note: `component body re-executed: ${owner.name ?? "?"}` });
        return orig.apply(this, args);
      }
      if (controller.isOn("solid")) {
        ensureFlush();
        runs++;
        byKind[kind]++;
        const info = componentInfoFor(owner);
        if (info) {
          byComponent.set(info.name, (byComponent.get(info.name) ?? 0) + 1);
          if (!componentsRan.has(info.id)) componentsRan.set(info.id, toRef(info)!);
        }
        if (controller.isOn("verboseComputations")) {
          bus.emit("solid.computation", { kind, name: owner.name ?? null }, { flush: flushId, component: toRef(info) });
        }
      }
      return orig.apply(this, args);
    };
  }

  function registerComponent(owner: OwnerLike) {
    const name = owner.name || owner.component?.name || "Anonymous";
    const parent = componentInfoFor(owner.owner);
    const t = now();
    const info: ComponentInfo = {
      id: nextId++,
      name,
      parent: parent?.id ?? null,
      hydrated: Boolean((sharedConfig as { context?: unknown }).context),
      mountedAt: t,
      mountedWall: Date.now(),
      flush: flushId,
      disposedAt: null,
    };
    compByOwner.set(owner as object, info);
    live.set(info.id, info);
    const key = `${name}|${parent?.name ?? ""}`;
    // Open the flush first so `flushId` is the one this mount belongs to.
    if (controller.isOn("solid")) ensureFlush();
    const disposed = recentDisposed.get(key);
    const remount = disposed !== undefined && flushId - disposed.flush <= 1 && t - disposed.t < 250;
    if (disposed) recentDisposed.delete(key);
    if (controller.isOn("solid")) {
      ensureFlush();
      const ref = toRef(info)!;
      componentsRan.set(info.id, ref);
      bus.emit(
        remount ? "solid.component.remount" : "solid.component.mount",
        {
          name,
          parent: parent?.name ?? null,
          hydrated: info.hydrated,
          id: info.id,
          ...(remount ? { gapMs: Math.round((t - disposed!.t) * 100) / 100 } : {}),
        },
        { flush: flushId, component: ref },
      );
    }
    (owner.cleanups ||= []).push(() => {
      const d = now();
      if (controller.isOn("solid")) ensureFlush();
      info.disposedAt = d;
      live.delete(info.id);
      elements.delete(info.id);
      recentDisposed.set(key, { t: d, flush: flushId });
      while (recentDisposed.size > MAX_RECENT_DISPOSED) {
        const oldest = recentDisposed.keys().next().value;
        if (oldest === undefined) break;
        recentDisposed.delete(oldest);
      }
      if (controller.isOn("solid")) {
        ensureFlush();
        bus.emit(
          "solid.component.dispose",
          { name, parent: parent?.name ?? null, id: info.id, lifetimeMs: Math.round((d - info.mountedAt) * 100) / 100 },
          { flush: flushId, component: toRef(info) },
        );
      }
    });
  }

  let prevAfterCreateOwner: Fn | null = null;
  let prevAfterUpdate: Fn | null = null;
  const available = Boolean(hooks);

  if (hooks) {
    prevAfterCreateOwner = hooks.afterCreateOwner ?? null;
    prevAfterUpdate = hooks.afterUpdate ?? null;
    hooks.afterCreateOwner = ((owner: OwnerLike) => {
      prevAfterCreateOwner?.(owner);
      try {
        if (typeof owner.fn === "function") wrapComputation(owner);
        else if (!owner.owner) {
          roots++;
          if (controller.isOn("solid")) bus.emit("solid.root", { roots });
        }
      } catch (err) {
        console.warn("[solid-pulse] instrumentation error", err);
      }
    }) as Fn;
    hooks.afterUpdate = () => {
      prevAfterUpdate?.();
      closeFlush();
    };
  }

  const api: SolidInstrumentation = {
    available,
    flushId: () => flushId,
    lastFlushComponents: () => (flushOpen ? [...componentsRan.values()] : lastClosed),
    componentFor: (owner) => toRef(componentInfoFor(owner)),
    currentComponent: () => toRef(componentInfoFor(getOwner())),
    components: () => [...live.values()],
    attachElement(componentId, el) {
      const list = elements.get(componentId) ?? [];
      if (list.some((r) => r.deref() === el)) return;
      list.push(new WeakRef(el));
      while (list.length > MAX_ELEMENTS_PER_COMPONENT) list.shift();
      elements.set(componentId, list);
    },
    elementsFor(componentId) {
      const out: Element[] = [];
      for (const ref of elements.get(componentId) ?? []) {
        const el = ref.deref();
        if (el && el.isConnected) out.push(el);
      }
      return out;
    },
    rectFor(component) {
      let els = api.elementsFor(component.id);
      if (els.length === 0 && typeof document !== "undefined") {
        // Fallback: solid-grab's build-time attribute, when present.
        const escaped = component.name.replace(/["\\]/g, "\\$&");
        els = [...document.querySelectorAll(`[data-solid-component="${escaped}"]`)].slice(0, 4);
      }
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        x1 = Math.min(x1, r.left);
        y1 = Math.min(y1, r.top);
        x2 = Math.max(x2, r.right);
        y2 = Math.max(y2, r.bottom);
      }
      if (!Number.isFinite(x1)) return null;
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    },
    dispose() {
      if (hooks) {
        hooks.afterCreateOwner = prevAfterCreateOwner;
        hooks.afterUpdate = prevAfterUpdate;
      }
    },
  };

  controller.register(
    { name: "inspect.components", summary: "Live component instances (name, parent, hydrated, age).", args: { name: "substring filter" }, ui: "Pulse tab › Components" },
    (a) => {
      const needle = a.name === undefined ? "" : String(a.name).toLowerCase();
      const t = now();
      return api
        .components()
        .filter((c) => !needle || c.name.toLowerCase().includes(needle))
        .map((c) => ({ id: c.id, name: c.name, parent: c.parent === null ? null : live.get(c.parent)?.name ?? null, hydrated: c.hydrated, ageMs: Math.round(t - c.mountedAt), elements: api.elementsFor(c.id).length }));
    },
  );
  controller.register(
    { name: "inspect.solid", summary: "Solid dev-hook availability, root count, live component count, current flush id." },
    () => ({ available, roots, liveComponents: live.size, flush: flushId }),
  );

  if (!available) {
    bus.emit("pulse.note", { note: "solid-js DEV hooks unavailable (production build?) — Solid instrumentation disabled" });
  }

  return api;
}
