import { describe, expect, test } from 'bun:test';
import { initPulse } from '../src/index.js';
import { mountPanel } from '../src/panel/index.js';
import { FEATURES } from '../src/core/controller.js';

describe('durable devtools preferences', () => {
  test('human and agent preferences survive runtime recreation without persisting captured data', async () => {
    const key = 'preferences-test';
    localStorage.clear();
    let pulse = initPulse({ banner: false, bridge: false, storageKey: key });
    let panel = mountPanel(pulse, { storageKey: key + ':panel', open: true });
    try {
      for (const feature of FEATURES) {
        const box = panel.root.querySelector<HTMLInputElement>('[data-feature="' + feature + '"]')!;
        box.checked = !pulse.controller.isOn(feature);
        box.dispatchEvent(new Event('change'));
      }
      const features = pulse.controller.snapshotFeatures();
      await pulse.run('filters.set', { kinds: 'net,dom', component: 'Widget', text: 'example' });
      await pulse.run('panel.tab', { name: 'grab' });
      await pulse.run('panel.pin', { corner: 'top-left' });
      await pulse.run('note', { text: 'MUST_NOT_PERSIST' });
      await pulse.run('record.start');
      expect(localStorage.getItem(key)).not.toContain('MUST_NOT_PERSIST');
      pulse.destroy();
      pulse = initPulse({ banner: false, bridge: false, storageKey: key, features: { solid: true } });
      panel = mountPanel(pulse, { storageKey: key + ':panel' });
      expect(pulse.controller.snapshotFeatures()).toEqual(features);
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { open: true, tab: 'grab', corner: 'top-left' } });
      expect(await pulse.run('filters.get')).toMatchObject({ ok: true, value: { kinds: ['net', 'dom'], component: 'Widget', text: 'example' } });
      expect(panel.root.querySelector<HTMLInputElement>('[data-arg="component"]')!.value).toBe('Widget');
      expect(pulse.bus.currentRecording()).toBeNull();
      expect(JSON.stringify(pulse.bus.list())).not.toContain('MUST_NOT_PERSIST');
      await pulse.run('panel.close');
      pulse.destroy();
      pulse = initPulse({ banner: false, storageKey: key });
      panel = mountPanel(pulse, { storageKey: key + ':panel' });
      expect(await pulse.run('panel.status')).toMatchObject({ ok: true, value: { open: false, tab: 'grab' } });
    } finally { pulse.destroy(); localStorage.clear(); }
  });

  test('invalid storage, invalid fields and opt-out do not break defaults', () => {
    const key = 'bad-preferences';
    for (const saved of ['{', 'null', '{"version":2,"features":{"solid":false}}', '{"version":1,"features":{"solid":"false"},"filters":{"kinds":[42],"text":false}}']) {
      localStorage.setItem(key, saved);
      const pulse = initPulse({ banner: false, storageKey: key });
      expect(pulse.controller.isOn('solid')).toBe(true);
      expect(pulse.controller.filters).toEqual({ kinds: [], component: '', text: '' });
      pulse.destroy();
    }
    localStorage.setItem('solid-pulse:preferences', '{"version":1,"features":{"solid":false}}');
    const pulse = initPulse({ banner: false, storageKey: false });
    expect(pulse.controller.isOn('solid')).toBe(true);
    pulse.destroy();
    localStorage.clear();
  });
});
