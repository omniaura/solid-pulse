/**
 * Event model. Every observation the runtime makes is one PulseEvent with a
 * precise `kind`. Kinds are deliberately specific: Solid has no "rerender", so
 * we never report one. What actually happens is one of:
 *
 *   solid.flush            a reactive flush completed (n computations re-ran)
 *   solid.computation      one memo/effect/render-effect re-ran (verbose mode)
 *   solid.component.mount  a component function ran (fresh mount, or hydrate)
 *   solid.component.dispose
 *   solid.component.remount same-named component disposed + mounted in one flush
 *   solid.root             a reactive root was created (multiple roots are fine)
 *   dom.mutation           the DOM actually changed (childList/attr/text)
 *   dom.detach             a subtree left the document (with scroll/focus state)
 *   dom.reattach           the same node instance came back (Suspense flip etc.)
 *   focus.lost             the focused element vanished from the document
 *   net.fetch.*            fetch lifecycle (start/end/error), SSE-aware
 *   net.ws.*               WebSocket lifecycle (open/message/close/error)
 *   net.sse.*              EventSource lifecycle
 *   query.*                Solid Query cache/observer events (adapter)
 *   mutation.*             Solid Query mutation cache events (adapter)
 *   pulse.*                runtime lifecycle / control-plane notes
 */

export type PulseEventKind =
  | "solid.flush"
  | "solid.computation"
  | "solid.component.mount"
  | "solid.component.dispose"
  | "solid.component.remount"
  | "solid.root"
  | "dom.mutation"
  | "dom.detach"
  | "dom.reattach"
  | "focus.lost"
  | "net.fetch.start"
  | "net.fetch.end"
  | "net.fetch.error"
  | "net.ws.open"
  | "net.ws.message"
  | "net.ws.close"
  | "net.ws.error"
  | "net.sse.open"
  | "net.sse.message"
  | "net.sse.error"
  | "net.sse.close"
  | "query.added"
  | "query.removed"
  | "query.observe"
  | "query.unobserve"
  | "query.fetch.start"
  | "query.fetch.success"
  | "query.fetch.error"
  | "query.invalidate"
  | "query.update"
  | "mutation.start"
  | "mutation.success"
  | "mutation.error"
  | "pulse.note";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComponentRef {
  id: number;
  name: string;
  /** Component ancestry, innermost first (names only). */
  chain?: string[];
  /** Source location if solid-grab's data-solid-source attribute was found. */
  source?: string | null;
}

export interface ElementRef {
  tag: string;
  id?: string;
  testId?: string;
  classes?: string;
  /** Nearest `data-solid-component` ancestor name, if any. */
  component?: string | null;
  /** Nearest `data-solid-source` value, if any. */
  source?: string | null;
  rect?: Rect;
}

export interface PulseEventBase {
  /** Monotonic per-runtime sequence. */
  seq: number;
  /** performance.now() at capture. */
  t: number;
  /** Date.now() at capture (for cross-process correlation). */
  wall: number;
  kind: PulseEventKind;
  /** Flush group the event belongs to, when attributable. */
  flush?: number;
  /** Component attribution, when known. */
  component?: ComponentRef | null;
  /** Free-form structured payload; shape depends on `kind`. */
  data: Record<string, unknown>;
  /** Payload snapshot exceeded the diagnostic size/depth budget. */
  truncated?: boolean;
}

export type PulseEvent = PulseEventBase;

export const KIND_GROUPS: Record<string, PulseEventKind[]> = {
  solid: [
    "solid.flush",
    "solid.computation",
    "solid.component.mount",
    "solid.component.dispose",
    "solid.component.remount",
    "solid.root",
  ],
  dom: ["dom.mutation", "dom.detach", "dom.reattach", "focus.lost"],
  net: [
    "net.fetch.start",
    "net.fetch.end",
    "net.fetch.error",
    "net.ws.open",
    "net.ws.message",
    "net.ws.close",
    "net.ws.error",
    "net.sse.open",
    "net.sse.message",
    "net.sse.error",
    "net.sse.close",
  ],
  query: [
    "query.added",
    "query.removed",
    "query.observe",
    "query.unobserve",
    "query.fetch.start",
    "query.fetch.success",
    "query.fetch.error",
    "query.invalidate",
    "query.update",
    "mutation.start",
    "mutation.success",
    "mutation.error",
  ],
  pulse: ["pulse.note"],
};

export const ALL_KINDS: PulseEventKind[] = Object.values(KIND_GROUPS).flat();

/** Expand a kind filter: exact kinds, `group` names, or `prefix.*` globs. */
export function expandKinds(filters: readonly string[]): Set<PulseEventKind> {
  const out = new Set<PulseEventKind>();
  for (const raw of filters) {
    const f = raw.trim();
    if (!f) continue;
    if (f === "*" || f === "all") {
      for (const k of ALL_KINDS) out.add(k);
      continue;
    }
    const group = KIND_GROUPS[f];
    if (group) {
      for (const k of group) out.add(k);
      continue;
    }
    if (f.endsWith("*")) {
      const prefix = f.slice(0, -1);
      for (const k of ALL_KINDS) if (k.startsWith(prefix)) out.add(k);
      continue;
    }
    if ((ALL_KINDS as string[]).includes(f)) out.add(f as PulseEventKind);
  }
  return out;
}
