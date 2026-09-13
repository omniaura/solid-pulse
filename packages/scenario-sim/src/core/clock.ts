/**
 * Virtual clock. Everything time-related in a scenario — response delays,
 * scheduled stream events, disconnects, timestamps in fixtures — goes through
 * the run's clock so it can be replayed:
 *
 *   realtime  timers fire on real setTimeout scaled by `speed` (default 1)
 *   manual    nothing fires until `step(ms)` advances the clock (tests, and
 *             "step" in the control plane / panel / CLI)
 *
 * `now()` is virtual milliseconds since the run started, and `wall()` maps it
 * onto a fixed epoch so fixture timestamps are stable across runs.
 */

export type ClockMode = "realtime" | "manual";

export interface ClockTimer {
  id: number;
  at: number;
  label: string;
  cancel(): void;
}

interface Entry {
  id: number;
  at: number;
  label: string;
  fn: () => void;
  handle: ReturnType<typeof setTimeout> | null;
}

/** 2026-01-01T00:00:00Z — the virtual epoch every run starts at. */
export const VIRTUAL_EPOCH = Date.UTC(2026, 0, 1);

export class VirtualClock {
  private entries = new Map<number, Entry>();
  private nextId = 1;
  private base = 0;
  private startedReal = typeof performance !== "undefined" ? performance.now() : Date.now();
  private manualNow = 0;

  constructor(public mode: ClockMode = "realtime", public speed = 1, public readonly epoch = VIRTUAL_EPOCH) {}

  /** Virtual ms since the run started. */
  now(): number {
    if (this.mode === "manual") return this.manualNow;
    const real = (typeof performance !== "undefined" ? performance.now() : Date.now()) - this.startedReal;
    return this.base + real * this.speed;
  }

  /** Virtual wall-clock ms (epoch + now). */
  wall(): number {
    return this.epoch + Math.round(this.now());
  }

  iso(offsetMs = 0): string {
    return new Date(this.wall() + offsetMs).toISOString();
  }

  after(ms: number, fn: () => void, label = "timer"): ClockTimer {
    const id = this.nextId++;
    const at = this.now() + Math.max(0, ms);
    const entry: Entry = { id, at, label, fn, handle: null };
    this.entries.set(id, entry);
    if (this.mode === "realtime") {
      entry.handle = setTimeout(() => this.fire(entry), Math.max(0, ms) / (this.speed || 1));
    }
    return { id, at, label, cancel: () => this.cancel(id) };
  }

  /** Promise that resolves after `ms` virtual milliseconds. */
  sleep(ms: number, label = "sleep"): Promise<void> {
    return new Promise((resolve) => void this.after(ms, resolve, label));
  }

  cancel(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.handle) clearTimeout(e.handle);
    this.entries.delete(id);
  }

  /** Manual mode: advance by `ms`, firing due timers in order. Returns what fired. */
  step(ms: number): { now: number; fired: { id: number; at: number; label: string }[] } {
    if (this.mode !== "manual") throw new Error("step() requires manual clock mode");
    const target = this.manualNow + Math.max(0, ms);
    const fired: { id: number; at: number; label: string }[] = [];
    for (;;) {
      let next: Entry | null = null;
      for (const e of this.entries.values()) if (e.at <= target && (!next || e.at < next.at || (e.at === next.at && e.id < next.id))) next = e;
      if (!next) break;
      this.manualNow = Math.max(this.manualNow, next.at);
      fired.push({ id: next.id, at: next.at, label: next.label });
      this.fire(next);
    }
    this.manualNow = target;
    return { now: this.manualNow, fired };
  }

  /** Switch modes; pending timers are re-armed (realtime) or parked (manual). */
  setMode(mode: ClockMode) {
    if (mode === this.mode) return;
    const now = this.now();
    this.mode = mode;
    if (mode === "manual") {
      this.manualNow = now;
      for (const e of this.entries.values()) {
        if (e.handle) clearTimeout(e.handle);
        e.handle = null;
      }
    } else {
      this.base = now;
      this.startedReal = typeof performance !== "undefined" ? performance.now() : Date.now();
      for (const e of this.entries.values()) e.handle = setTimeout(() => this.fire(e), Math.max(0, e.at - now) / (this.speed || 1));
    }
  }

  pending(): { id: number; at: number; label: string }[] {
    return [...this.entries.values()].sort((a, b) => a.at - b.at || a.id - b.id).map(({ id, at, label }) => ({ id, at, label }));
  }

  clear() {
    for (const e of this.entries.values()) if (e.handle) clearTimeout(e.handle);
    this.entries.clear();
  }

  private fire(e: Entry) {
    if (!this.entries.has(e.id)) return;
    this.entries.delete(e.id);
    try {
      e.fn();
    } catch (err) {
      console.warn(`[scenario-sim] timer "${e.label}" threw`, err);
    }
  }
}
