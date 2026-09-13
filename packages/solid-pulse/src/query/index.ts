/**
 * Solid Query adapter (optional). Subscribes to the QueryCache and
 * MutationCache — read-only, never changes query behaviour — and turns cache
 * notifications into precise events:
 *
 *   query.observe        an observer subscribed. `role` is "initiating" when it
 *                        is the query's first observer (its mount triggers the
 *                        fetch) or "sharing" when the query already had
 *                        observers (no new fetch is caused by this observer).
 *   query.fetch.start    the query started fetching; `trigger` says whether the
 *                        cause was an observer mount in this tick, an
 *                        invalidation, or a background refetch.
 *   query.fetch.success / query.fetch.error / query.invalidate / query.update
 *   query.unobserve / query.added / query.removed
 *   mutation.start / mutation.success / mutation.error
 *
 * Component attribution works because TanStack notifies synchronously inside
 * the subscribing component's reactive owner, where `getOwner()` still points
 * at it. The overlay badge is centred on the component's DOM when known.
 */

import type { Pulse } from "../index.js";
import type { ComponentRef } from "../core/events.js";
import { redactValue } from "../core/redact.js";

/*
 * Structural views of TanStack Query's client/cache/query/observer. Typed this
 * way (instead of importing the classes) so an app's own @tanstack/query-core
 * 5.x — any patch level, with its nominal `#private` fields — is accepted
 * without a version-for-version match with ours.
 */
export interface QueryStateLike {
  status: string;
  fetchStatus: string;
  data: unknown;
  dataUpdatedAt: number;
  isInvalidated: boolean;
  errorUpdateCount: number;
}
export interface QueryObserverLike {
  options: { staleTime?: unknown; enabled?: unknown };
}
export interface QueryLike {
  queryKey: readonly unknown[];
  queryHash: string;
  state: QueryStateLike;
  observers: QueryObserverLike[];
  getObserversCount(): number;
}
export interface QueryCacheNotifyEventLike {
  type: string;
  query: QueryLike;
  observer?: QueryObserverLike;
  action?: { type: string; error?: unknown; manual?: boolean };
}
export interface MutationCacheNotifyEventLike {
  type: string;
  mutation?: { mutationId: number; options: { mutationKey?: readonly unknown[] } };
  action?: { type: string; error?: unknown };
}
export interface QueryClientLike {
  getQueryCache(): { subscribe(listener: (event: QueryCacheNotifyEventLike) => void): () => void; getAll(): QueryLike[] };
  getMutationCache(): { subscribe(listener: (event: MutationCacheNotifyEventLike) => void): () => void };
  invalidateQueries(filters?: { queryKey?: readonly unknown[]; exact?: boolean }): Promise<unknown>;
  resetQueries(filters?: { queryKey?: readonly unknown[] }): Promise<unknown>;
}

export interface QueryAdapterOptions {
  /** Badge duration in ms (default 1200). */
  badgeMs?: number;
  /** Show badges for "sharing" observers too (default true). */
  badgeSharing?: boolean;
}

function keyLabel(key: readonly unknown[]): string {
  try {
    const s = JSON.stringify(redactValue(key));
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
  } catch {
    return String(key);
  }
}

export function attachQueryClient(pulse: Pulse, client: QueryClientLike, options: QueryAdapterOptions = {}): () => void {
  const { controller, bus, overlay } = pulse;
  const observers = new WeakMap<QueryObserverLike, ComponentRef | null>();
  const fetchStarts = new Map<string, number>();
  // The fetch an observer's mount triggers is dispatched synchronously, right
  // after `observerAdded`, so the initiator is only valid for the current tick.
  let pendingInitiator: { hash: string; component: ComponentRef | null } | null = null;

  const badge = (title: string, body: string, component: ComponentRef | null) => {
    if (!overlay || !controller.isOn("queryOverlay")) return;
    const rect = component && pulse.solid ? pulse.solid.rectFor(component) : null;
    overlay.badge({ title, body }, rect, { ms: options.badgeMs ?? 1200, kind: "query" });
    if (rect && controller.isOn("flash")) overlay.flash([rect], "query", { ms: 700 });
  };

  const onQuery = (e: QueryCacheNotifyEventLike) => {
    if (!controller.isOn("query")) return;
    const q = e.query;
    const key = q.queryKey as readonly unknown[];
    const hash = q.queryHash;
    const label = keyLabel(key);
    switch (e.type) {
      case "added":
        bus.emit("query.added", { hash, key: redactValue(key), label, state: q.state.status });
        break;
      case "removed":
        bus.emit("query.removed", { hash, key: redactValue(key), label });
        break;
      case "observerAdded": {
        if (!e.observer) break;
        const component = pulse.solid?.currentComponent() ?? null;
        observers.set(e.observer, component);
        const count = q.getObserversCount();
        const role = count <= 1 ? "initiating" : "sharing";
        pendingInitiator = { hash, component };
        queueMicrotask(() => {
          if (pendingInitiator?.hash === hash) pendingInitiator = null;
        });
        bus.emit(
          "query.observe",
          { hash, key: redactValue(key), label, role, observers: count, status: q.state.status, fetchStatus: q.state.fetchStatus, staleTime: e.observer.options.staleTime ?? null, enabled: e.observer.options.enabled ?? true },
          { component },
        );
        if (role === "initiating" || options.badgeSharing !== false) {
          badge(`${component?.name ?? "(no component)"} ${role === "initiating" ? "⚡ initiates" : "👁 observes"}`, label, component);
        }
        break;
      }
      case "observerRemoved": {
        if (!e.observer) break;
        const component = observers.get(e.observer) ?? null;
        observers.delete(e.observer);
        bus.emit("query.unobserve", { hash, key: redactValue(key), label, observers: q.getObserversCount() }, { component });
        break;
      }
      case "updated": {
        if (!e.action) break;
        const action = e.action;
        if (action.type === "fetch") {
          fetchStarts.set(hash, performance.now());
          const recent = pendingInitiator && pendingInitiator.hash === hash ? pendingInitiator : null;
          if (recent) pendingInitiator = null;
          const trigger = recent ? "observer-mount" : q.state.isInvalidated ? "invalidation" : q.state.dataUpdatedAt ? "background-refetch" : "initial";
          bus.emit(
            "query.fetch.start",
            { hash, key: redactValue(key), label, trigger, observers: q.getObserversCount(), hadData: q.state.data !== undefined },
            { component: recent?.component ?? null },
          );
          if (trigger !== "observer-mount") badge(`↻ fetching (${trigger})`, label, null);
        } else if (action.type === "success") {
          const started = fetchStarts.get(hash);
          fetchStarts.delete(hash);
          bus.emit("query.fetch.success", { hash, key: redactValue(key), label, ms: started ? Math.round(performance.now() - started) : null, manual: action.manual ?? false, observers: q.getObserversCount() });
        } else if (action.type === "error") {
          const started = fetchStarts.get(hash);
          fetchStarts.delete(hash);
          const err = action.error as { name?: string; message?: string } | undefined;
          bus.emit("query.fetch.error", { hash, key: redactValue(key), label, ms: started ? Math.round(performance.now() - started) : null, name: err?.name ?? "Error", message: String(err?.message ?? err ?? ""), observers: q.getObserversCount(), hadData: q.state.data !== undefined });
        } else if (action.type === "invalidate") {
          bus.emit("query.invalidate", { hash, key: redactValue(key), label, observers: q.getObserversCount() });
        } else {
          bus.emit("query.update", { hash, key: redactValue(key), label, action: action.type });
        }
        break;
      }
      default:
        break;
    }
  };

  const unsubQuery = client.getQueryCache().subscribe(onQuery);
  const unsubMutation = client.getMutationCache().subscribe((e) => {
    if (!controller.isOn("query")) return;
    if (e.type !== "updated" || !e.action || !e.mutation) return;
    const action = e.action;
    const key = e.mutation.options.mutationKey ?? null;
    const data = { id: e.mutation.mutationId, key: redactValue(key), label: key ? keyLabel(key as readonly unknown[]) : null };
    if (action.type === "pending") bus.emit("mutation.start", data);
    else if (action.type === "success") bus.emit("mutation.success", data);
    else if (action.type === "error") {
      const err = action.error as { message?: string } | undefined;
      bus.emit("mutation.error", { ...data, message: String(err?.message ?? err ?? "") });
    }
  });

  controller.register(
    {
      name: "inspect.queries",
      summary: "Queries in the cache with observers, status, fetch status, data age and the components observing them.",
      args: { text: "substring on the key", active: "true = only queries with observers" },
      ui: "Query tab › list",
    },
    (a) => {
      const needle = a.text === undefined ? "" : String(a.text).toLowerCase();
      const activeOnly = a.active === true || a.active === "true";
      return client
        .getQueryCache()
        .getAll()
        .filter((q) => (!needle || keyLabel(q.queryKey).toLowerCase().includes(needle)) && (!activeOnly || q.getObserversCount() > 0))
        .map((q) => ({
          hash: q.queryHash,
          key: redactValue(q.queryKey),
          status: q.state.status,
          fetchStatus: q.state.fetchStatus,
          observers: q.getObserversCount(),
          components: q.observers.map((o) => observers.get(o)?.name ?? null),
          dataAgeMs: q.state.dataUpdatedAt ? Date.now() - q.state.dataUpdatedAt : null,
          isInvalidated: q.state.isInvalidated,
          errorUpdateCount: q.state.errorUpdateCount,
        }));
    },
  );
  controller.register(
    { name: "query.invalidate", summary: "Invalidate queries matching a key prefix (JSON array) — same as the Query tab's Invalidate button.", args: { key: 'JSON array, e.g. ["conversations"]', exact: "true = exact key" }, ui: "Query tab › Invalidate" },
    async (a) => {
      const key = a.key === undefined ? undefined : typeof a.key === "string" ? (JSON.parse(String(a.key)) as unknown[]) : (a.key as unknown[]);
      await client.invalidateQueries(key ? { queryKey: key, exact: a.exact === true || a.exact === "true" } : undefined);
      return { invalidated: true, key: key ?? "*" };
    },
  );
  controller.register(
    { name: "query.reset", summary: "Reset queries matching a key prefix to their initial state (clears data → next fetch is a first load).", args: { key: "JSON array" }, ui: "Query tab › Reset" },
    async (a) => {
      const key = a.key === undefined ? undefined : typeof a.key === "string" ? (JSON.parse(String(a.key)) as unknown[]) : (a.key as unknown[]);
      await client.resetQueries(key ? { queryKey: key } : undefined);
      return { reset: true, key: key ?? "*" };
    },
  );

  bus.emit("pulse.note", { note: "solid-query adapter attached" });
  return () => {
    unsubQuery();
    unsubMutation();
    controller.unregister("inspect.queries");
    controller.unregister("query.invalidate");
    controller.unregister("query.reset");
  };
}
