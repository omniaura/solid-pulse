import { describe, expect, test } from 'bun:test';
import { initPulse } from '../src/index.js';
import { mountPanel, registerTool } from '../src/panel/index.js';

describe('unified developer panel', () => {
  test('fallback picking cancels on Escape, close and destruction', async () => {
    const pulse = initPulse({ banner: false, storageKey: false });
    const panel = mountPanel(pulse, { storageKey: false, open: true });
    const target = document.createElement('button'); document.body.append(target);
    const click = () => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    };
    try {
      const picker = panel.root.querySelector<HTMLButtonElement>('[data-command="inspect.element"]')!;
      picker.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); click();
      picker.click(); await pulse.run('panel.close'); click();
      await pulse.run('panel.open'); picker.click(); panel.destroy(); click();
    } finally { pulse.destroy(); target.remove(); }
  });
  test('an open restored panel waits for its late tool without losing intent', async () => {
    const key = 'late-view-test';
    localStorage.setItem(key + ':view', JSON.stringify({ version: 1, open: true, tab: 'example-tool' }));
    const pulse = initPulse({ banner: false, storageKey: false });
    const panel = mountPanel(pulse, { storageKey: key });
    try {
      expect(JSON.parse(localStorage.getItem(key + ':view')!).tab).toBe('example-tool');
      const remove = registerTool(pulse, { id: 'example-tool', title: 'Late', mount(el) { el.textContent = 'late tool'; } });
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { open: true, tab: 'example-tool' } });
      remove();
    } finally { panel.destroy(); pulse.destroy(); localStorage.removeItem(key + ':view'); }
  });
  test('corner pins persist and invalid coordinates fail closed', async () => {
    document.body.innerHTML = '<input id="focused">';
    const pulse = initPulse({ bridge: false, banner: false });
    const key = 'panel-corner-test';
    localStorage.removeItem(key);
    let panel = mountPanel(pulse, { storageKey: key });
    try {
      const input = document.querySelector<HTMLInputElement>('#focused')!; input.focus();
      await pulse.run('panel.open');
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
        const select = panel.root.querySelector<HTMLSelectElement>('[data-command="panel.pin"]')!;
        select.value = corner; select.dispatchEvent(new Event('change'));
        expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { corner, floating: null } });
        expect(panel.root.querySelector<HTMLElement>('.sp-drawer')!.dataset.corner).toBe(corner);
        expect(localStorage.getItem(key)).toBe(corner);
      }
      expect(document.activeElement).toBe(input);
      expect(await pulse.run('panel.pin', { corner: 'middle' })).toMatchObject({ ok: false });
      expect(await pulse.run('panel.move', { x: Infinity, y: 0 })).toMatchObject({ ok: false });
      expect(await pulse.run('panel.move', { x: 80, y: 40 })).toMatchObject({ ok: true });
      expect(panel.root.querySelector<HTMLElement>('.sp-drawer')!.dataset.corner).toBe('floating');
      await pulse.run('panel.move', { x: 99999, y: 99999 });
      const drawer = panel.root.querySelector<HTMLElement>('.sp-drawer')!;
      const effective = { x: Number.parseFloat(drawer.style.left), y: Number.parseFloat(drawer.style.top) };
      expect(effective.x).toBeLessThan(99999);
      expect(effective.y).toBeLessThan(99999);
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { floating: effective } });
      panel.destroy();
      panel = mountPanel(pulse, { storageKey: key, open: true });
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { floating: effective } });
      await pulse.run('panel.pin', { corner: 'top-left' });
      panel.destroy();
      panel = mountPanel(pulse, { storageKey: key });
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { corner: 'top-left' } });
    } finally { panel.destroy(); pulse.destroy(); localStorage.removeItem(key); }
  });

  test('remount and pulse destruction leave one panel and no commands', async () => {
    const pulse = initPulse({ bridge: false, banner: false });
    const first = mountPanel(pulse, { storageKey: false });
    const second = mountPanel(pulse, { storageKey: false, open: true });
    expect(first.root.isConnected).toBe(false);
    expect(second.root.isConnected).toBe(true);
    expect(document.querySelectorAll('[data-solid-pulse="panel-root"]')).toHaveLength(1);
    first.destroy();
    expect(await pulse.run('panel.status')).toMatchObject({ ok: true });
    pulse.destroy();
    expect(second.root.isConnected).toBe(false);
    expect(pulse.controller.has('panel.open')).toBe(false);
    second.destroy();
  });

  test('a broken optional view does not prevent other tools or detach', () => {
    const pulse = initPulse({ bridge: false, banner: false });
    const panel = mountPanel(pulse, { storageKey: false, open: true });
    try {
      const remove = registerTool(pulse, { id: 'broken', title: 'Broken', mount() { throw new Error('test mount failure'); } });
      expect(panel.root.textContent).toContain('Broken could not mount');
      remove();
      expect(panel.root.querySelector('[data-tab="broken"]')).toBeNull();
    } finally { pulse.destroy(); }
  });

  test('late tools register commands and tabs, then cleanly detach', async () => {
    const pulse = initPulse({ bridge: false, banner: false });
    const panel = mountPanel(pulse, { open: true, storageKey: false });
    let mounts = 0, cleanups = 0;
    try {
      expect(await pulse.run('panel.tab', { name: 'scenarios' })).toMatchObject({ ok: false });
      const unregister = registerTool(pulse, {
        id: 'example-tool', title: 'Example tool',
        commands: [{ spec: { name: 'example.status', summary: 'Example', ui: 'Example tool' }, run: () => 42 }],
        mount(el) { mounts++; el.innerHTML = '<button data-command="example.status">Status</button>'; return () => { cleanups++; }; },
      });
      expect(mounts).toBe(1);
      expect(await pulse.run('panel.tab', { name: 'example-tool' })).toMatchObject({ ok: true });
      expect(await pulse.run('example.status')).toEqual({ ok: true, value: 42 });
      expect(() => registerTool(pulse, { id: 'example-tool', title: 'duplicate', mount() {} })).toThrow();
      unregister(); unregister();
      expect(cleanups).toBe(1);
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { tab: 'pulse' } });
      expect(await pulse.run('example.status')).toMatchObject({ ok: false });
    } finally { panel.destroy(); pulse.destroy(); }
  });

  test('late solid-grab is hosted once and restored on teardown', async () => {
    const pulse = initPulse({ bridge: false, banner: false });
    const panel = mountPanel(pulse, { open: true, storageKey: false });
    let picking = false, badgeVisible = true;
    const listeners = new Set<() => void>();
    const win = window as unknown as { __SOLID_GRAB__?: unknown };
    const old = win.__SOLID_GRAB__;
    win.__SOLID_GRAB__ = {
      status: () => ({ initialized: true, picking, badgeVisible, key: 'Alt' }),
      setPicking(on: boolean) { picking = on; for (const fn of listeners) fn(); },
      setBadgeVisible(on: boolean) { badgeVisible = on; },
      subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
      inspect: () => ({ formatted: 'source', tagName: 'BUTTON', elementSource: null, components: [], timestamp: 1 }),
    };
    try {
      window.dispatchEvent(new CustomEvent('solid-grab:ready'));
      window.dispatchEvent(new CustomEvent('solid-grab:ready'));
      expect(badgeVisible).toBe(false);
      expect(panel.root.querySelectorAll('[data-tab="solid-grab"]').length).toBe(0);
      expect(panel.root.querySelectorAll('[data-slot="inspect-tools"] [data-command="grab.pick"]')).toHaveLength(1);
      expect(await pulse.run('panel.tab', { name: 'solid-grab' })).toMatchObject({ ok: true, value: { tab: 'grab' } });
      expect(panel.root.querySelector<HTMLButtonElement>('[data-command="inspect.element"]')!.hidden).toBe(true);
      expect(await pulse.run('grab.pick', { on: true })).toMatchObject({ ok: true, value: { picking: true } });
      expect(await pulse.run('grab.inspect', { selector: 'no-such-element' })).toMatchObject({ ok: false });
      window.dispatchEvent(new CustomEvent('solid-grab:destroy'));
      expect(panel.root.querySelector('[data-command="grab.pick"]')).toBeNull();
      expect(panel.root.querySelector<HTMLButtonElement>('[data-command="inspect.element"]')!.hidden).toBe(false);
      panel.destroy();
      expect(badgeVisible).toBe(true);
      expect(picking).toBe(false);
      expect(listeners.size).toBe(0);
      expect(pulse.controller.has('grab.pick')).toBe(false);
    } finally { win.__SOLID_GRAB__ = old; pulse.destroy(); }
  });
});
