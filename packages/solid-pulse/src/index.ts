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

export type { PulseEvent, PulseEventKind, ComponentRef, ElementRef, Rect } from "./core/events.js";
export type { CommandSpec, CommandResult, Feature, Filters } from "./core/controller.js";
export { PulseController } from "./core/controller.js";
export { EventBus } from "./core/bus.js";
export { FlashOverlay } from "./overlay/flash.js";
export type { SolidInstrumentation } from "./solid/instrument.js";
export { describeElement, toSelector } from "./solid/dom.js";

export interface PulseOptions {
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
  const overlay = options.overlay === false ? null : new FlashOverlay();
  let solid: SolidInstrumentation | null = null;
  let dom: DomInstrumentation | null = null;
  let net: NetworkInstrumentation | null = null;
  let bridge: BridgeClient | null = null;

  const boot = () => {
    overlay?.mount();
    solid = installSolid(controller);
    dom = installDom(controller, solid, overlay);
    net = installNetwork(controller, solid);
    if (options.bridge) {
      const opts: BridgeClientOptions =
        options.bridge === true ? {} : typeof options.bridge === "string" ? { url: options.bridge } : options.bridge;
      bridge = new BridgeClient(controller, opts);
      bridge.connect();
    }
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
    destroy() {
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
