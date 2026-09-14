import { RingBuffer } from "./ring-buffer.js";
import type { PulseEvent, PulseEventKind } from "./events.js";
import { boundedData } from './bounded-data.js';

export const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDING_EVENTS = 20_000;

export type Listener = (event: PulseEvent) => void;

export interface Recording {
  id: string;
  startedAt: number;
  startedWall: number;
  stoppedAt: number | null;
  events: PulseEvent[];
  /** Hard cap; the recording stops itself when reached. */
  limit: number;
  bytes: number;
  stopReason?: 'manual' | 'events' | 'bytes';
}

/**
 * Bounded event bus. Emission is synchronous and cheap: one ring-buffer push,
 * one optional recording push, then listeners. Filters are applied by
 * consumers (panel/bridge), not here, so the buffer stays a faithful log.
 */
export class EventBus {
  readonly buffer: RingBuffer<PulseEvent>;
  private listeners = new Set<Listener>();
  private warned = new WeakSet<Listener>();
  private seq = 0;
  private recording: Recording | null = null;
  private recordings = new Map<string, Recording>();
  /** Kinds that are muted at the source (never buffered). */
  muted = new Set<PulseEventKind>();
  paused = false;
  bytes = 0;
  truncated = 0;
  private sizes = new WeakMap<PulseEvent, number>();

  constructor(capacity = 2000) {
    this.buffer = new RingBuffer<PulseEvent>(capacity);
  }

  get nextSeq() {
    return this.seq + 1;
  }

  emit(kind: PulseEventKind, data: Record<string, unknown>, extra: Partial<PulseEvent> = {}): PulseEvent | null {
    if (this.paused || this.muted.has(kind)) return null;
    const snapshot = boundedData(data);
    const envelope = boundedData(extra, 2048);
    if (snapshot.truncated || envelope.truncated) this.truncated++;
    const event: PulseEvent = {
      ...(envelope.value as Partial<PulseEvent>),
      seq: ++this.seq,
      t: typeof performance !== "undefined" ? performance.now() : Date.now(),
      wall: Date.now(),
      kind,
      data: snapshot.value as Record<string, unknown>,
      ...(snapshot.truncated || envelope.truncated ? { truncated: true } : {}),
    };
    const size = (snapshot.chars + envelope.chars) * 2 + 128;
    while (this.buffer.size && (this.buffer.size >= this.buffer.capacity || this.bytes + size > MAX_BUFFER_BYTES)) {
      const old = this.buffer.shift()!;
      this.bytes -= this.sizes.get(old) ?? 0;
    }
    this.sizes.set(event, size);
    this.bytes += size;
    this.buffer.push(event);
    const rec = this.recording;
    if (rec) {
      if (rec.bytes + size > MAX_RECORDING_BYTES) this.stopRecording('bytes');
      else {
        rec.events.push(event);
        rec.bytes += size;
        if (rec.events.length >= rec.limit) this.stopRecording('events');
      }
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        // A misbehaving listener must never break the app being observed.
        if (!this.warned.has(l) && typeof console !== "undefined") { this.warned.add(l); console.warn("[solid-pulse] listener failed (further errors suppressed)", err); }
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
    this.bytes = 0;
    this.truncated = 0;
  }

  startRecording(id?: string, limit = 20_000): Recording {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDING_EVENTS) throw new RangeError('recording limit must be 1..' + MAX_RECORDING_EVENTS);
    if (this.recording) this.stopRecording();
    const rec: Recording = {
      id: id ?? `rec-${Date.now().toString(36)}-${(this.seq).toString(36)}`,
      startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
      startedWall: Date.now(),
      stoppedAt: null,
      events: [],
      limit,
      bytes: 0,
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

  stopRecording(reason: 'manual' | 'events' | 'bytes' = 'manual'): Recording | null {
    const rec = this.recording;
    if (!rec) return null;
    rec.stoppedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    rec.stopReason = reason;
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
      bytes: r.bytes,
      stopReason: r.stopReason,
    }));
  }
}
