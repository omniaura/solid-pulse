import { describe, expect, test } from 'bun:test';
import { initPulse } from '../src/index.js';
import { mountRecordings } from '../src/panel/recordings.js';
const settle = () => new Promise(r => setTimeout(r, 0));

describe('recording workflow', () => {
  test('state, limits, marker and explicit snapshot export preserve command parity', async () => {
    const pulse = initPulse({ bridge: false, banner: false, storageKey: false, features: { dom: false, solid: false, network: false } });
    const view = mountRecordings(pulse, () => true);
    document.body.append(view.body);
    const button = (name: string) => view.body.querySelector<HTMLButtonElement>('[data-command="' + name + '"]')!;
    const originalExport = pulse.controller.run.bind(pulse.controller);
    const exports: unknown[] = [];
    pulse.controller.run = async (name, args) => {
      if (name === 'export') exports.push(args);
      return originalExport(name, args);
    };
    const originalURL = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:test';
    try {
      expect(view.body.textContent).toContain('No recordings yet');
      expect(button('record.stop').hidden).toBe(true);
      pulse.bus.paused = true; view.refresh();
      expect(button('record.start').disabled).toBe(true);
      expect(button('events.resume').hidden).toBe(false);
      button('events.resume').click(); await settle();
      button('record.start').click(); await settle();
      const id = pulse.bus.currentRecording()!.id;
      expect(button('record.start').hidden).toBe(true);
      const note = view.body.querySelector<HTMLInputElement>('input')!;
      note.value = 'Reproduced'; note.dispatchEvent(new Event('input'));
      button('note').click(); await settle();
      expect(pulse.bus.getRecording(id)!.events.some(e => e.data.note === 'Reproduced')).toBe(true);
      const save = view.body.querySelector<HTMLButtonElement>('[data-recording-id] button')!;
      save.focus(); view.refresh();
      expect(document.activeElement).toBe(save);
      save.click(); await settle();
      expect(exports.at(-1)).toEqual({ recording: id });
      expect(pulse.bus.currentRecording()!.id).toBe(id);
      const snapshot = await originalExport('export', { recording: id });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw new Error(snapshot.error);
      const frozen = snapshot.value as { meta: { count: number; recording: { active: boolean } }; events: unknown[] };
      pulse.bus.emit('pulse.note', { note: 'after snapshot' });
      expect(frozen.events.length).toBe(frozen.meta.count);
      expect(frozen.meta.recording.active).toBe(true);
      button('record.stop').click(); await settle();
      expect(view.body.textContent).toContain('Stopped');
      expect(pulse.bus.paused).toBe(false);
      const auto = pulse.bus.startRecording('auto', 1);
      pulse.bus.emit('pulse.note', { note: 'limit' }); view.refresh();
      expect(auto.stopReason).toBe('events');
      expect(view.body.textContent).toContain('Stopped automatically · event limit reached');
      const bytes = pulse.bus.startRecording('byte-limit');
      for (let i = 0; i < 2000 && !bytes.stoppedAt; i++) pulse.bus.emit('pulse.note', { note: 'x'.repeat(8000) });
      view.refresh();
      expect(view.body.textContent).toContain('Stopped automatically · size limit reached');
      for (let i = 0; i < 6; i++) pulse.bus.startRecording('extra-' + i);
      view.refresh();
      expect(view.body.querySelectorAll('[data-recording-id]').length).toBe(5);
      expect(view.body.querySelector('[data-recording-id="auto"]')).toBeNull();
      pulse.bus.paused = true; view.refresh();
      expect(view.body.textContent).toContain('Recording · capture paused');
      expect(button('note').disabled).toBe(true);
      // Command failure stays visible instead of silently looking successful.
      pulse.controller.run = async () => ({ ok: false, error: 'test failure' });
      button('record.stop').click(); await settle();
      expect(view.body.querySelector('[role="status"]')!.textContent).toBe('test failure');
    } finally {
      URL.createObjectURL = originalURL;
      view.dispose(); view.body.remove(); pulse.destroy();
    }
  });
});
