import type { Pulse } from '../index.js';
import { MAX_RECORDING_BYTES, MAX_RECORDING_EVENTS } from '../core/bus.js';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
const size = (bytes: number) => bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB';

/** Separate, bounded recording view. Refreshes reuse rows, preserving keyboard focus. */
export function mountRecordings(pulse: Pulse, visible: () => boolean) {
  const { controller, bus } = pulse;
  const body = el('div', '', 'sp-body sp-record');
  const message = el('p', '', 'sp-record-message');
  message.setAttribute('role', 'status');
  const state = el('strong');
  state.setAttribute('data-record-state', '');
  const detail = el('p', '', 'sp-dim');
  const progress = el('progress');
  progress.max = 1;
  progress.setAttribute('aria-label', 'Recording budget used');
  const rows = new Map<string, { node: HTMLElement; info: HTMLElement; download: HTMLButtonElement }>();
  const list = el('div');
  list.setAttribute('data-command', 'record.list');
  const empty = el('p', 'No recordings yet. Start recording, reproduce the issue, then stop and download the JSON.', 'sp-dim');
  let disposed = false;
  let busy = false;
  let lastActive: string | null = null;

  async function command(name: string, args: Record<string, unknown> = {}) {
    const result = await controller.run(name, args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async function act(action: () => Promise<void>) {
    if (busy || disposed) return;
    busy = true;
    message.textContent = '';
    refresh();
    try { await action(); }
    catch (error) { if (!disposed) message.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; if (!disposed) refresh(); }
  }
  function button(label: string, name: string, action: () => Promise<void>) {
    const b = el('button', label, 'sp-btn');
    b.type = 'button';
    b.dataset.command = name;
    b.addEventListener('click', () => void act(action));
    return b;
  }
  const start = button('Start recording', 'record.start', async () => {
    if (bus.paused) throw new Error('Resume capture before starting a recording.');
    await command('record.start');
    message.textContent = 'Recording started. Reproduce the issue, then stop and download.';
  });
  start.classList.add('sp-record-primary');
  const stop = button('Stop recording', 'record.stop', async () => { await command('record.stop'); message.textContent = 'Recording stopped. Download its JSON below.'; });
  const resume = button('Resume capture', 'events.resume', async () => { await command('events.resume'); message.textContent = 'Capture resumed.'; });
  const actions = el('div', '', 'sp-row');
  actions.append(start, stop, resume);
  const hint = el('p', 'Records new events from enabled instruments, regardless of log filters. Stopping a recording leaves the live log running.', 'sp-dim');
  const limits = el('p', 'Stops automatically at ' + MAX_RECORDING_EVENTS.toLocaleString() + ' events or ' + size(MAX_RECORDING_BYTES) + ' of estimated payload. Keeps the latest 5 recordings in this page only; download before reloading.', 'sp-dim');
  const note = el('input', '', 'sp-in');
  note.placeholder = 'e.g. Clicked Save; spinner stayed visible';
  note.setAttribute('aria-label', 'Recording marker');
  note.dataset.arg = 'text';
  const addNote = button('Add marker', 'note', async () => {
    const value = note.value.trim();
    if (!value || bus.paused || !bus.currentRecording()) throw new Error('Start an unpaused recording before adding a marker.');
    await command('note', { text: value });
    note.value = '';
    message.textContent = 'Marker added to the active recording.';
  });
  note.addEventListener('input', () => { addNote.disabled = busy || !note.value.trim() || bus.paused || !bus.currentRecording(); });
  note.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addNote.click(); } });
  const noteRow = el('div', '', 'sp-row');
  noteRow.append(note, addNote);

  async function download(id?: string) {
    const value = await command('export', id === undefined ? { filtered: false } : { recording: id });
    if (disposed) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = 'solid-pulse-' + (id === undefined ? 'live-log' : 'recording') + '-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.textContent = id === undefined ? 'Live log download requested.' : 'Recording download requested.';
  }
  const live = button('Download live log', 'export', () => download());
  const liveRow = el('div', '', 'sp-record-live');
  liveRow.append(live, el('p', 'Only the events still in the rolling buffer, without display filters. This is not a recording.', 'sp-dim'));
  body.append(el('h3', 'Record a reproduction'), hint, state, detail, progress, actions, noteRow, message,
    el('h4', 'Recordings in this page'), limits, empty, list, liveRow);

  function refresh() {
    if (disposed) return;
    const active = bus.currentRecording();
    const recordings = bus.listRecordings();
    const focused = document.activeElement;
    if (lastActive && !active) {
      const stopped = recordings.find(r => r.id === lastActive);
      if (stopped?.stopReason === 'bytes' || stopped?.stopReason === 'events') message.textContent = 'Recording stopped automatically: ' + (stopped.stopReason === 'bytes' ? 'size' : 'event') + ' limit reached. Download its JSON below.';
    }
    lastActive = active?.id ?? null;
    state.textContent = active ? (bus.paused ? 'Recording · capture paused' : 'Recording in progress') : (bus.paused ? 'Capture is paused' : 'Ready to record');
    state.dataset.active = active ? 'true' : 'false';
    detail.textContent = active
      ? active.events.length.toLocaleString() + ' / ' + active.limit.toLocaleString() + ' events · ~' + size(active.bytes) + ' / ' + size(MAX_RECORDING_BYTES) + (bus.paused ? ' · No new events until you resume capture.' : '')
      : bus.paused ? 'Resume capture to collect new events. Existing recordings are still available below.' : 'The live log runs independently. Start a recording to keep a bounded trace of your next steps.';
    progress.hidden = !active;
    progress.value = active ? Math.max(active.events.length / active.limit, active.bytes / MAX_RECORDING_BYTES) : 0;
    start.hidden = !!active;
    start.disabled = bus.paused;
    stop.hidden = !active;
    stop.disabled = false;
    resume.hidden = !bus.paused;
    resume.disabled = false;
    note.disabled = !active || bus.paused;
    addNote.disabled = !active || bus.paused || !note.value.trim();
    live.disabled = bus.buffer.size === 0;
    empty.hidden = recordings.length > 0;
    const ids = new Set(recordings.map(r => r.id));
    for (const [id, row] of rows) if (!ids.has(id)) { if (row.node.contains(focused)) (active ? stop : start).focus(); row.node.remove(); rows.delete(id); }
    for (const rec of recordings) {
      let row = rows.get(rec.id);
      if (!row) {
        const node = el('div', '', 'sp-record-item');
        node.dataset.recordingId = rec.id;
        const title = el('strong', 'Started ' + new Date(rec.startedWall).toLocaleTimeString());
        title.title = rec.id;
        const info = el('p', '', 'sp-dim');
        const text = el('div');
        text.append(title, info);
        const save = button('Download JSON', 'export', () => download(rec.id));
        save.setAttribute('aria-label', 'Download recording ' + rec.id);
        node.append(text, save);
        row = { node, info, download: save };
        rows.set(rec.id, row);
        list.prepend(node);
      }
      const reason = rec.active ? (bus.paused ? 'Capture paused' : 'Recording') : rec.stopReason === 'bytes' ? 'Stopped automatically · size limit reached' : rec.stopReason === 'events' ? 'Stopped automatically · event limit reached' : 'Stopped';
      row.info.textContent = reason + ' · ' + rec.events.toLocaleString() + ' events · ~' + size(rec.bytes);
      row.download.textContent = rec.active ? 'Download snapshot' : 'Download JSON';
      row.download.setAttribute('aria-disabled', String(busy));
    }
    // Only restore focus when the focused control itself disappeared/disabled;
    // agent actions must never steal focus from the application.
    if ((focused === start && start.hidden) || (focused === resume && resume.hidden)) (active ? stop : start).focus();
    else if ((focused === stop && stop.hidden) || (focused === note && note.disabled) || (focused === addNote && addNote.disabled)) (bus.paused ? resume : active ? stop : start).focus();
  }
  const timer = setInterval(() => { if (visible() && !document.hidden) refresh(); }, 500);
  refresh();
  return { body, refresh, dispose() { disposed = true; clearInterval(timer); } };
}
