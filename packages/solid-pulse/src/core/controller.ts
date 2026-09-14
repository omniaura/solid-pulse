import { EventBus, MAX_BUFFER_BYTES, MAX_RECORDING_BYTES } from "./bus.js";
import { expandKinds, type PulseEvent, type PulseEventKind } from "./events.js";

/** Runtime features that can be toggled by humans (panel) and agents (CLI) alike. */
export type Feature =
  | "solid"
  | "dom"
  | "flash"
  | "network"
  | "query"
  | "queryOverlay"
  | "verboseComputations"
  | "captureBodies";

export const FEATURES: Feature[] = [
  "solid",
  "dom",
  "flash",
  "network",
  "query",
  "queryOverlay",
  "verboseComputations",
  "captureBodies",
];

export interface CommandSpec {
  /** Dotted command name, e.g. `features.set`. Also the CLI verb. */
  name: string;
  summary: string;
  /** Argument name → short description. */
  args?: Record<string, string>;
  /** Where the equivalent human control lives in the panel (parity doc). */
  ui?: string;
}

export type CommandHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type CommandResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface Filters {
  /** Kind filters (exact kinds, groups, or `prefix.*`); empty = all. */
  kinds: string[];
  /** Case-insensitive substring on component name. */
  component: string;
  /** Case-insensitive substring on any string in `data` (URLs, keys). */
  text: string;
}

export type FeatureListener = (feature: Feature, on: boolean) => void;

/**
 * The single command surface. The panel's buttons, the bridge's HTTP API and
 * the CLI all call `run()`, so parity between human and agent control is a
 * property of the design rather than a checklist. `describe()` is the
 * machine-readable contract the CLI prints and the parity test asserts on.
 */
export class PulseController {
  readonly bus: EventBus;
  private commands = new Map<string, { spec: CommandSpec; handler: CommandHandler }>();
  private commandListeners = new Set<() => void>();
  private features: Record<Feature, boolean>;
  private featureListeners = new Set<FeatureListener>();
  filters: Filters = { kinds: [], component: "", text: "" };
  private filterListeners = new Set<(f: Filters) => void>();
  readonly startedWall = Date.now();

  constructor(bus = new EventBus(), initial: Partial<Record<Feature, boolean>> = {}) {
    this.bus = bus;
    this.features = {
      solid: true,
      dom: true,
      flash: true,
      network: true,
      query: true,
      queryOverlay: true,
      verboseComputations: false,
      captureBodies: false,
      ...initial,
    };
    this.registerCore();
  }

  // ── features ─────────────────────────────────────────────────────

  isOn(feature: Feature) {
    return this.features[feature];
  }

  setFeature(feature: Feature, on: boolean) {
    if (!FEATURES.includes(feature)) throw new Error(`unknown feature: ${feature}`);
    if (this.features[feature] === on) return;
    this.features[feature] = on;
    for (const l of this.featureListeners) l(feature, on);
    this.bus.emit("pulse.note", { note: `feature ${feature} ${on ? "on" : "off"}` });
  }

  onFeature(listener: FeatureListener) {
    this.featureListeners.add(listener);
    return () => this.featureListeners.delete(listener);
  }

  snapshotFeatures() {
    return { ...this.features };
  }

  // ── filters ──────────────────────────────────────────────────────

  setFilters(next: Partial<Filters>) {
    this.filters = { ...this.filters, ...next };
    for (const l of this.filterListeners) l(this.filters);
  }

  onFilters(listener: (f: Filters) => void) {
    this.filterListeners.add(listener);
    return () => this.filterListeners.delete(listener);
  }

  matchesFilters(e: PulseEvent, f: Filters = this.filters): boolean {
    if (f.kinds.length) {
      const kinds = expandKinds(f.kinds);
      if (kinds.size && !kinds.has(e.kind)) return false;
    }
    if (f.component) {
      const name = e.component?.name ?? "";
      const chain = e.component?.chain?.join(" ") ?? "";
      const needle = f.component.toLowerCase();
      if (!name.toLowerCase().includes(needle) && !chain.toLowerCase().includes(needle)) return false;
    }
    if (f.text) {
      const needle = f.text.toLowerCase();
      if (!JSON.stringify(e.data).toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  /** Buffered events after `since`, through the active filters. */
  events(opts: { since?: number; limit?: number; kinds?: string[]; raw?: boolean } = {}) {
    const kinds = opts.kinds ? expandKinds(opts.kinds) : null;
    const list = this.bus.list({ since: opts.since, limit: opts.raw ? opts.limit : 5000, kinds });
    const filtered = opts.raw ? list : list.filter((e) => this.matchesFilters(e));
    const limit = opts.limit ?? 500;
    return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
  }

  // ── commands ─────────────────────────────────────────────────────

  register(spec: CommandSpec, handler: CommandHandler) {
    if (this.commands.has(spec.name)) throw new Error(`command already registered: ${spec.name}`);
    this.commands.set(spec.name, { spec, handler });
    for (const listener of this.commandListeners) listener();
  }

  unregister(name: string) {
    this.commands.delete(name);
    for (const listener of this.commandListeners) listener();
  }

  onCommands(listener: () => void) {
    this.commandListeners.add(listener);
    return () => { this.commandListeners.delete(listener); };
  }

  has(name: string) {
    return this.commands.has(name);
  }

  describe(): CommandSpec[] {
    return [...this.commands.values()].map((c) => c.spec).sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    const cmd = this.commands.get(name);
    if (!cmd) return { ok: false, error: `unknown command: ${name}` };
    try {
      const value = await cmd.handler(args ?? {});
      return { ok: true, value: value === undefined ? null : value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private registerCore() {
    this.register(
      { name: "status", summary: "Runtime status: features, filters, buffer stats, recording.", ui: "panel header" },
      () => ({
        startedWall: this.startedWall,
        features: this.snapshotFeatures(),
        filters: this.filters,
        buffer: { size: this.bus.buffer.size, capacity: this.bus.buffer.capacity, dropped: this.bus.buffer.dropped, seq: this.bus.nextSeq - 1 },
        retention: { bytes: this.bus.bytes, maxBytes: MAX_BUFFER_BYTES, truncatedEvents: this.bus.truncated, recordingMaxBytes: MAX_RECORDING_BYTES },
        paused: this.bus.paused,
        recording: this.bus.currentRecording()?.id ?? null,
        commands: this.commands.size,
      }),
    );
    this.register(
      { name: "commands", summary: "List every command with its panel equivalent (the parity contract)." },
      () => this.describe(),
    );
    this.register(
      { name: "features.list", summary: "Feature flags and their current state.", ui: "Pulse tab › toggles" },
      () => this.snapshotFeatures(),
    );
    this.register(
      {
        name: "features.set",
        summary: "Turn a feature on/off.",
        args: { name: FEATURES.join("|"), on: "true|false (default true)" },
        ui: "Pulse tab › toggles",
      },
      (a) => {
        const name = String(a.name ?? "") as Feature;
        const on = a.on === undefined ? true : a.on === true || a.on === "true" || a.on === "on" || a.on === 1;
        this.setFeature(name, on);
        return this.snapshotFeatures();
      },
    );
    this.register(
      {
        name: "filters.set",
        summary: "Set event filters (kinds list, component substring, text substring). Empty string clears.",
        args: { kinds: "comma list: solid,dom,net,query or kinds/globs", component: "substring", text: "substring" },
        ui: "Pulse tab › filter bar",
      },
      (a) => {
        const next: Partial<Filters> = {};
        if (a.kinds !== undefined) {
          next.kinds = Array.isArray(a.kinds)
            ? (a.kinds as unknown[]).map(String)
            : String(a.kinds).split(",").map((s) => s.trim()).filter(Boolean);
        }
        if (a.component !== undefined) next.component = String(a.component);
        if (a.text !== undefined) next.text = String(a.text);
        this.setFilters(next);
        return this.filters;
      },
    );
    this.register({ name: "filters.get", summary: "Current filters.", ui: "Pulse tab › filter bar" }, () => this.filters);
    this.register(
      {
        name: "events.list",
        summary: "Buffered events (oldest first) through the active filters.",
        args: { since: "seq to start after", limit: "max rows (default 200)", kinds: "override kind filter", raw: "true = ignore filters" },
        ui: "Pulse tab › event list",
      },
      (a) => {
        const kinds = a.kinds === undefined ? undefined : String(a.kinds).split(",").map((s) => s.trim()).filter(Boolean);
        return this.events({
          since: a.since === undefined ? undefined : Number(a.since),
          limit: a.limit === undefined ? 200 : Number(a.limit),
          kinds,
          raw: a.raw === true || a.raw === "true",
        });
      },
    );
    this.register({ name: "events.clear", summary: "Clear the event buffer.", ui: "Pulse tab › Clear" }, () => {
      this.bus.clear();
      return { cleared: true };
    });
    this.register({ name: "events.pause", summary: "Stop capturing new events (buffer kept).", ui: "Pulse tab › Pause" }, () => {
      this.bus.paused = true;
      return { paused: true };
    });
    this.register({ name: "events.resume", summary: "Resume capturing.", ui: "Pulse tab › Pause" }, () => {
      this.bus.paused = false;
      return { paused: false };
    });
    this.register(
      { name: "note", summary: "Append a marker note to the timeline (agents: label a QA step).", args: { text: "note text" }, ui: "Record tab › Note" },
      (a) => this.bus.emit("pulse.note", { note: String(a.text ?? "") }),
    );
    this.register(
      { name: "record.start", summary: "Start a recording (stops at event or payload budget).", args: { id: "optional id", limit: "1..20000 events; also bounded by 4 MiB estimated payload" }, ui: "Record tab › Start" },
      (a) => {
        const rec = this.bus.startRecording(a.id === undefined ? undefined : String(a.id), a.limit === undefined ? undefined : Number(a.limit));
        return { id: rec.id, startedWall: rec.startedWall };
      },
    );
    this.register({ name: "record.stop", summary: "Stop the active recording.", ui: "Record tab › Stop" }, () => {
      const rec = this.bus.stopRecording();
      return rec ? { id: rec.id, events: rec.events.length } : null;
    });
    this.register({ name: "record.list", summary: "Recordings kept in memory (last 5).", ui: "Record tab › Recordings in this page" }, () => this.bus.listRecordings());
    this.register(
      {
        name: "export",
        summary: "Export a recording (or the live buffer) as JSON: {meta, events}.",
        args: { recording: "recording id; omit for the live buffer", filtered: "true = apply filters to the live buffer" },
        ui: "Record tab › Download JSON / Download snapshot / Download live log",
      },
      (a) => {
        const id = a.recording === undefined ? null : String(a.recording);
        const rec = id ? this.bus.getRecording(id) : null;
        if (id && !rec) throw new Error(`unknown recording: ${id}`);
        const events = rec ? rec.events.slice() : a.filtered === true || a.filtered === "true" ? this.events({ limit: 100_000 }) : this.bus.list({ limit: 100_000 });
        return {
          meta: {
            tool: "@omniaura/solid-pulse",
            exportedWall: Date.now(),
            recording: rec ? { id: rec.id, startedWall: rec.startedWall, stoppedAt: rec.stoppedAt, active: rec === this.bus.currentRecording(), stopReason: rec.stopReason ?? null, limit: rec.limit, bytes: rec.bytes } : null,
            filtered: !rec && (a.filtered === true || a.filtered === "true"),
            features: this.snapshotFeatures(),
            filters: this.filters,
            count: events.length,
          },
          events,
        };
      },
    );
  }
}

export type { PulseEvent, PulseEventKind };
