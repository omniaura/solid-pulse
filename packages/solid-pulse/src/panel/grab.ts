import type { Pulse } from '../index.js';
import { registerTool } from './tools.js';

interface GrabApi {
  status(): { initialized: boolean; picking: boolean; badgeVisible: boolean; key: string };
  setPicking(on: boolean): void;
  setBadgeVisible(on: boolean): void;
  subscribe(listener: () => void): () => void;
  inspect(el: HTMLElement): { formatted: string; tagName: string; elementSource: unknown; components: unknown; timestamp: number };
}

/** Discover the optional runtime, regardless of script load order. No hard dependency. */
export function discoverSolidGrab(pulse: Pulse) {
  let attached: GrabApi | undefined;
  let unregister: (() => void) | undefined;
  function detach() { unregister?.(); unregister = undefined; attached = undefined; }
  function discover() {
    const api = (window as unknown as { __SOLID_GRAB__?: GrabApi }).__SOLID_GRAB__;
    if (!api?.status || !api.setBadgeVisible || !api.setPicking || !api.subscribe || !api.status().initialized || api === attached) return;
    detach();
    attached = api;
    const command = (name: string, summary: string, run: (a: Record<string, unknown>) => unknown, args?: Record<string, string>) => ({ spec: { name, summary, args, ui: 'Solid Grab tab' }, run });
    unregister = registerTool(pulse, {
      id: 'solid-grab', title: 'Solid Grab',
      commands: [
        command('grab.status', 'Read the element picker state.', () => api.status()),
        command('grab.pick', 'Start or cancel element picking.', (a) => {
          if (a.on !== undefined && typeof a.on !== 'boolean') throw new Error('on must be boolean');
          api.setPicking(a.on !== false); return api.status();
        }, { on: 'boolean (default true)' }),
        command('grab.inspect', 'Get source context for a CSS selector.', (a) => {
          if (typeof a.selector !== 'string' || !a.selector) throw new Error('selector required');
          const el = document.querySelector(a.selector);
          if (!(el instanceof HTMLElement)) throw new Error('Element not found');
          const { formatted, tagName, elementSource, components, timestamp } = api.inspect(el);
          return { formatted, tagName, elementSource, components, timestamp };
        }, { selector: 'CSS selector' }),
      ],
      mount(el) {
        const badge = api.status().badgeVisible;
        api.setBadgeVisible(false);
        const pick = document.createElement('button');
        pick.className = 'sp-btn'; pick.type = 'button'; pick.dataset.command = 'grab.pick';
        const state = document.createElement('p'); state.dataset.command = 'grab.status';
        const input = document.createElement('input'); input.className = 'sp-in'; input.placeholder = 'CSS selector'; input.setAttribute('aria-label', 'Source context selector');
        const inspect = document.createElement('button'); inspect.className = 'sp-btn'; inspect.type = 'button'; inspect.textContent = 'Inspect source'; inspect.dataset.command = 'grab.inspect';
        const result = document.createElement('pre'); result.setAttribute('aria-live', 'polite');
        pick.onclick = () => { void pulse.run('grab.pick', { on: !api.status().picking }).then(r => { if (!r.ok) result.textContent = r.error; }); };
        inspect.onclick = () => { void pulse.run('grab.inspect', { selector: input.value }).then(r => { result.textContent = JSON.stringify(r.ok ? r.value : { error: r.error }, null, 2); }); };
        const refresh = () => {
          const status = api.status();
          pick.textContent = status.picking ? 'Cancel picking' : 'Pick element';
          pick.setAttribute('aria-pressed', String(status.picking));
          state.textContent = status.picking ? 'Click an element to copy its source context. Escape cancels.' : 'Pick an element, or hold ' + status.key + ' and click. Source context is copied for your coding agent.';
        };
        el.append(pick, state, input, inspect, result);
        const unsubscribe = api.subscribe(refresh);
        refresh();
        return () => { unsubscribe(); api.setPicking(false); api.setBadgeVisible(badge); };
      },
    });
  }
  window.addEventListener('solid-grab:ready', discover);
  window.addEventListener('solid-grab:destroy', detach);
  discover();
  return () => {
    window.removeEventListener('solid-grab:ready', discover);
    window.removeEventListener('solid-grab:destroy', detach);
    detach();
  };
}
