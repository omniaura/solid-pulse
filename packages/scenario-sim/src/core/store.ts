/**
 * Per-run state. Collections of records keyed by id, with every mutation
 * appended to a bounded event log and delivered to listeners — that is how
 * "a PATCH publishes a stream event" is wired without coupling routes to
 * transports: routes mutate state, stream routes subscribe to state.
 */

export type Record_ = Record<string, unknown> & { id: string };

export type StoreEventKind = "insert" | "update" | "remove" | "clear" | "custom";

export interface StoreEvent {
  seq: number;
  /** Virtual clock ms when it happened. */
  t: number;
  kind: StoreEventKind;
  collection: string;
  id?: string;
  record?: Record_;
  previous?: Record_;
  /** For `custom` events. */
  name?: string;
  data?: unknown;
}

export type StoreListener = (event: StoreEvent) => void;

export class Store {
  private collections = new Map<string, Map<string, Record_>>();
  private listeners = new Set<StoreListener>();
  private log: StoreEvent[] = [];
  private seq = 0;

  constructor(private now: () => number, private logLimit = 5000) {}

  collection(name: string): Map<string, Record_> {
    let c = this.collections.get(name);
    if (!c) {
      c = new Map();
      this.collections.set(name, c);
    }
    return c;
  }

  collections_(): string[] {
    return [...this.collections.keys()];
  }

  insert<T extends Record_>(collection: string, record: T): T {
    const c = this.collection(collection);
    if (c.has(record.id)) throw new Error(`duplicate id ${record.id} in ${collection}`);
    c.set(record.id, record);
    this.emit({ kind: "insert", collection, id: record.id, record });
    return record;
  }

  upsert<T extends Record_>(collection: string, record: T): T {
    const c = this.collection(collection);
    const previous = c.get(record.id);
    c.set(record.id, record);
    this.emit(previous ? { kind: "update", collection, id: record.id, record, previous } : { kind: "insert", collection, id: record.id, record });
    return record;
  }

  get<T extends Record_ = Record_>(collection: string, id: string): T | undefined {
    return this.collections.get(collection)?.get(id) as T | undefined;
  }

  list<T extends Record_ = Record_>(collection: string, opts: { where?: (r: T) => boolean; sort?: (a: T, b: T) => number; offset?: number; limit?: number } = {}): T[] {
    let out = [...(this.collections.get(collection)?.values() ?? [])] as T[];
    if (opts.where) out = out.filter(opts.where);
    if (opts.sort) out.sort(opts.sort);
    if (opts.offset) out = out.slice(opts.offset);
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out;
  }

  count(collection: string): number {
    return this.collections.get(collection)?.size ?? 0;
  }

  update<T extends Record_ = Record_>(collection: string, id: string, patch: Partial<T> | ((current: T) => T)): T | undefined {
    const c = this.collection(collection);
    const previous = c.get(id) as T | undefined;
    if (!previous) return undefined;
    const next = typeof patch === "function" ? patch(previous) : ({ ...previous, ...patch, id } as T);
    c.set(id, next);
    this.emit({ kind: "update", collection, id, record: next, previous });
    return next;
  }

  remove(collection: string, id: string): Record_ | undefined {
    const c = this.collection(collection);
    const previous = c.get(id);
    if (!previous) return undefined;
    c.delete(id);
    this.emit({ kind: "remove", collection, id, previous });
    return previous;
  }

  clear(collection?: string) {
    if (collection) this.collection(collection).clear();
    else this.collections.clear();
    this.emit({ kind: "clear", collection: collection ?? "*" });
  }

  /** Application-level event (not tied to a record), e.g. "job.progress". */
  custom(collection: string, name: string, data?: unknown, id?: string) {
    this.emit({ kind: "custom", collection, name, data, id });
  }

  on(listener: StoreListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  events(opts: { since?: number; collection?: string; limit?: number } = {}): StoreEvent[] {
    const out = this.log.filter((e) => e.seq > (opts.since ?? 0) && (!opts.collection || e.collection === opts.collection));
    const limit = opts.limit ?? 200;
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  get lastSeq() {
    return this.seq;
  }

  snapshot(): Record<string, Record_[]> {
    const out: Record<string, Record_[]> = {};
    for (const [name, c] of this.collections) out[name] = [...c.values()];
    return out;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, c] of this.collections) out[name] = c.size;
    return out;
  }

  private emit(partial: Omit<StoreEvent, "seq" | "t">) {
    const event: StoreEvent = { seq: ++this.seq, t: this.now(), ...partial };
    this.log.push(event);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.warn("[scenario-sim] store listener threw", err);
      }
    }
  }
}
