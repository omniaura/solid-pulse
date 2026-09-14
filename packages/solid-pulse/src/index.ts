/**
 * @omniaura/solid-pulse — runtime entry.
 *
 *   import { initPulse } from "@omniaura/solid-pulse";
 *   if (import.meta.env.DEV) initPulse({ bridge: true });
 *
 * or let `@omniaura/solid-pulse/vite` auto-import it in dev. Never ship it in
 * production: the Vite plugin is `apply: "serve"` and `initPulse` refuses to
 * run twice. Instrumentation is dev-only and everything is bounded (ring
 * buffer, per-frame flash caps, per-stream message caps).
 */

import { PulseController, type Feature } from "./core/controller.js";
import { EventBus } from "./core/bus.js";
import { FlashOverlay } from "./overlay/flash.js";
import { installSolid, type SolidInstrumentation } from "./solid/instrument.js";
import { installDom, type DomInstrumentation } from "./solid/dom.js";
import { installNetwork, type NetworkInstrumentation } from "./solid/network.js";
import { BridgeClient, type BridgeClientOptions } from "./bridge/client.js";
import { restorePreferences } from './preferences.js';

export type { PulseEvent, PulseEventKind, ComponentRef, ElementRef, Rect } from "./core/events.js";
export type { CommandSpec, CommandResult, Feature, Filters } from "./core/controller.js";
export { PulseController } from "./core/controller.js";
export { EventBus } from "./core/bus.js";
export { FlashOverlay } from "./overlay/flash.js";
export type { SolidInstrumentation } from "./solid/instrument.js";
export { describeElement, toSelector } from "./solid/dom.js";

export interface PulseOptions {
  /** Persist feature/filter choices per origin. Saved choices override initial defaults; false opts out. */
  storageKey?: string | false;
  /** Ring-buffer capacity (default 2000 events). */
  bufferSize?: number;
  /** Initial feature flags. */
  features?: Partial<Record<Feature, boolean>>;
  /** Mount the flash/badge overlay (default true). */
  overlay?: boolean;
  /**
   * Connect to a bridge. `true` uses the same origin at `/__pulse/ws` (the
   * Vite plugin mounts one there); a string is an explicit ws:// URL.
   */
  bridge?: boolean | string | BridgeClientOptions;
  /** Print a console banner (default true). */
  banner?: boolean;
}

export interface Pulse {
  controller: PulseController;
  bus: EventBus;
  overlay: FlashOverlay | null;
  solid: SolidInstrumentation | null;
  bridge: BridgeClient | null;
  /** Run a command exactly as the CLI would. */
  run: PulseController["run"];
  onDestroy(listener: () => void): () => void;
  destroy(): void;
}

let instance: Pulse | null = null;

export function getPulse(): Pulse | null {
  return instance;
}

export function initPulse(options: PulseOptions = {}): Pulse {
  if (instance) return instance;
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("solid-pulse runs in the browser only");
  }
  const bus = new EventBus(options.bufferSize ?? 2000);
  const controller = new PulseController(bus, options.features);
  const stopPreferences = restorePreferences(controller, options.storageKey ?? 'solid-pulse:preferences');
  const overlay = options.overlay === false ? null : new FlashOverlay();
  let solid: SolidInstrumentation | null = null;
  let dom: DomInstrumentation | null = null;
  let net: NetworkInstrumentation | null = null;
  let bridge: BridgeClient | null = null;
  const destroyListeners = new Set<() => void>();
  let destroyed = false;

  const bridgeFor = (opts: BridgeClientOptions) => {
    const client = new BridgeClient(controller, opts);
    return client;
  };
  controller.register(
    { name: "bridge.status", summary: "Bridge transport state (url, connected, client id).", ui: "panel header › bridge dot" },
    () => ({ configured: bridge !== null, connected: bridge?.connected ?? false, url: bridge?.url ?? null, clientId: bridge?.clientId ?? null }),
  );
  controller.register(
    {
      name: "bridge.connect",
      summary: "Connect (or reconnect) to a bridge at runtime — for pages started without one, e.g. `window.__SOLID_PULSE__.run('bridge.connect', {url:'ws://127.0.0.1:4567/__pulse/ws'})` from agent-browser eval.",
      args: { url: "ws(s):// URL (default: same origin /__pulse/ws)" },
    },
    (a) => {
      bridge?.disconnect();
      bridge = bridgeFor(a.url ? { url: String(a.url) } : {});
      bridge.connect();
      return { url: bridge.url, clientId: bridge.clientId };
    },
  );
  controller.register({ name: "bridge.disconnect", summary: "Stop the bridge transport (events keep buffering in-page)." }, () => {
    bridge?.disconnect();
    const was = bridge?.url ?? null;
    bridge = null;
    return { disconnected: was };
  });

  const boot = () => {
    overlay?.mount();
    solid = installSolid(controller);
    dom = installDom(controller, solid, overlay);
    // The bridge grabs the native WebSocket before network instrumentation
    // wraps the global, so our own transport never appears in the events.
    if (options.bridge) {
      const opts: BridgeClientOptions =
        options.bridge === true ? {} : typeof options.bridge === "string" ? { url: options.bridge } : options.bridge;
      bridge = bridgeFor(opts);
    }
    net = installNetwork(controller, solid, { ignoreUrl: (url) => url.includes("/__pulse/") });
    bridge?.connect();
    if (options.banner !== false) {
      console.log(
        "%c◉ solid-pulse%c dev instrumentation on · window.__SOLID_PULSE__.run(cmd) · CLI: solid-pulse commands",
        "color:#f59e0b;font-weight:bold",
        "color:inherit",
      );
    }
  };

  const pulse: Pulse = {
    controller,
    bus,
    overlay,
    get solid() {
      return solid;
    },
    get bridge() {
      return bridge;
    },
    run: (name, args) => controller.run(name, args),
    onDestroy(listener) { destroyListeners.add(listener); return () => { destroyListeners.delete(listener); }; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopPreferences();
      for (const listener of [...destroyListeners]) listener();
      destroyListeners.clear();
      bridge?.disconnect();
      net?.dispose();
      dom?.dispose();
      solid?.dispose();
      overlay?.unmount();
      instance = null;
      delete (window as unknown as { __SOLID_PULSE__?: unknown }).__SOLID_PULSE__;
    },
  };
  instance = pulse;
  (window as unknown as { __SOLID_PULSE__: Pulse }).__SOLID_PULSE__ = pulse;

  // Solid hooks must be installed before the app's first render to see the
  // initial mounts; the Vite plugin imports us first for that reason. DOM
  // observation needs a document element, which exists at script time.
  boot();
  return pulse;
}

declare global {
  interface Window {
    __SOLID_PULSE__?: Pulse;
  }
}
