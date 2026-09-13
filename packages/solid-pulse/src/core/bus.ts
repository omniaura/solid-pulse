import { RingBuffer } from "./ring-buffer.js";
import type { PulseEvent, PulseEventKind } from "./events.js";

export type Listener = (event: PulseEvent) => void;

export interface Recording {
  id: string;
  startedAt: number;
  startedWall: number;
  stoppedAt: number | null;
  events: PulseEvent[];
  /** Hard cap; the recording stops itself when reached. */
  limit: number;
}

/**
 * Bounded event bus. Emission is synchronous and cheap: one ring-buffer push,
 * one optional recording push, then listeners. Filters are applied by
 * consumers (panel/bridge), not here, so the buffer stays a faithful log.
 */
export class EventBus {
  readonly buffer: RingBuffer<PulseEvent>;
  private listeners = new Set<Listener>();
  private seq = 0;
  private recording: Recording | null = null;
  private recordings = new Map<string, Recording>();
  /** Kinds that are muted at the source (never buffered). */
  muted = new Set<PulseEventKind>();
  paused = false;

  constructor(capacity = 2000) {
    this.buffer = new RingBuffer<PulseEvent>(capacity);
  }

  get nextSeq() {
    return this.seq + 1;
  }

  emit(kind: PulseEventKind, data: Record<string, unknown>, extra: Partial<PulseEvent> = {}): PulseEvent | null {
    if (this.paused || this.muted.has(kind)) return null;
    const event: PulseEvent = {
      seq: ++this.seq,
      t: typeof performance !== "undefined" ? performance.now() : Date.now(),
      wall: Date.now(),
      kind,
      data,
      ...extra,
    };
    this.buffer.push(event);
    const rec = this.recording;
    if (rec) {
      rec.events.push(event);
      if (rec.events.length >= rec.limit) this.stopRecording();
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        // A misbehaving listener must never break the app being observed.
        if (typeof console !== "undefined") console.warn("[solid-pulse] listener failed", err);
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events with seq > since (oldest first), optionally filtered by kind. */
  list(opts: { since?: number; kinds?: Set<PulseEventKind> | null; limit?: number } = {}): PulseEvent[] {
    const { since = 0, kinds = null, limit = 500 } = opts;
    const all = this.buffer.toArray();
    const out: PulseEvent[] = [];
    for (const e of all) {
      if (e.seq <= since) continue;
      if (kinds && kinds.size > 0 && !kinds.has(e.kind)) continue;
      out.push(e);
    }
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  clear() {
    this.buffer.clear();
  }

  startRecording(id?: string, limit = 20_000): Recording {
    if (this.recording) this.stopRecording();
    const rec: Recording = {
      id: id ?? `rec-${Date.now().toString(36)}-${(this.seq).toString(36)}`,
      startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
      startedWall: Date.now(),
      stoppedAt: null,
      events: [],
      limit,
    };
    this.recording = rec;
    this.recordings.set(rec.id, rec);
    // Keep only the 5 most recent recordings to bound memory.
    while (this.recordings.size > 5) {
      const oldest = this.recordings.keys().next().value;
      if (oldest === undefined) break;
      this.recordings.delete(oldest);
    }
    return rec;
  }

  stopRecording(): Recording | null {
    const rec = this.recording;
    if (!rec) return null;
    rec.stoppedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.recording = null;
    return rec;
  }

  currentRecording() {
    return this.recording;
  }

  getRecording(id: string) {
    return this.recordings.get(id) ?? null;
  }

  listRecordings() {
    return [...this.recordings.values()].map((r) => ({
      id: r.id,
      startedWall: r.startedWall,
      stoppedAt: r.stoppedAt,
      events: r.events.length,
      active: r === this.recording,
    }));
  }
}
