import type { Pulse } from '../index.js';
import type { CommandSpec, CommandHandler } from '../core/controller.js';

/** An optional tool contributes one view and the same commands used by agents. */
export interface Devtool {
  id: string;
  title: string;
  /** Contribute inside an existing view instead of adding another tab. */
  slot?: 'inspect';
  commands?: Array<{ spec: CommandSpec; run: CommandHandler }>;
  mount(el: HTMLElement, pulse: Pulse): void | (() => void);
}
type Registry = { tools: Map<string, Devtool>; listeners: Set<() => void> };
const registries = new WeakMap<Pulse, Registry>();
function registry(pulse: Pulse): Registry {
  let value = registries.get(pulse);
  if (!value) {
    value = { tools: new Map(), listeners: new Set() };
    registries.set(pulse, value);
  }
  return value;
}
export function registeredTools(pulse: Pulse): Devtool[] { return [...registry(pulse).tools.values()]; }
export function onTools(pulse: Pulse, listener: () => void) {
  const listeners = registry(pulse).listeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function registerTool(pulse: Pulse, tool: Devtool): () => void {
  const r = registry(pulse);
  if (!/^[a-z][a-z0-9-]*$/.test(tool.id) || ['pulse', 'query', 'grab', 'scenarios', 'record'].includes(tool.id)) throw new Error('Invalid or reserved tool id: ' + tool.id);
  if (r.tools.has(tool.id)) throw new Error('Tool already registered: ' + tool.id);
  const names = new Set<string>();
  for (const { spec } of tool.commands ?? []) {
    if (names.has(spec.name) || pulse.controller.has(spec.name)) throw new Error('Command already registered: ' + spec.name);
    names.add(spec.name);
  }
  for (const { spec, run } of tool.commands ?? []) pulse.controller.register(spec, run);
  r.tools.set(tool.id, tool);
  for (const notify of r.listeners) notify();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    r.tools.delete(tool.id);
    for (const notify of r.listeners) notify();
    for (const name of names) pulse.controller.unregister(name);
  };
}
