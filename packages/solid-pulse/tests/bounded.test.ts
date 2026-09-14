import { describe, expect, test } from 'bun:test';
import { EventBus, MAX_BUFFER_BYTES, MAX_RECORDING_BYTES } from '../src/core/bus.js';
import { initPulse } from '../src/index.js';
import { mountPanel } from '../src/panel/index.js';
import { BridgeClient } from '../src/bridge/client.js';
import { PulseController } from '../src/core/controller.js';
const wait = () => new Promise(r => setTimeout(r, 150));

describe('bounded sustained capture', () => {
  test('bounds retained payloads and recordings, snapshots objects, rejects unlimited recordings', () => {
    const bus = new EventBus();
    const data = { nested: { label: 'before' } };
    const first = bus.emit('pulse.note', data)!;
    data.nested.label = 'after';
    expect(first.data).toEqual({ nested: { label: 'before' } });
    const circular: any = {}; circular.self = circular;
    expect(() => JSON.stringify(bus.emit('pulse.note', circular))).not.toThrow();
    const rec = bus.startRecording();
    for (let i=0;i<10_000;i++) bus.emit('net.ws.message', { preview: 'x'.repeat(100_000) });
    expect(bus.buffer.size).toBeLessThan(2000);
    expect(bus.bytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    expect(bus.truncated).toBe(10_000);
    expect(rec.bytes).toBeLessThanOrEqual(MAX_RECORDING_BYTES);
    expect(rec.stopReason).toBe('bytes');
    expect(bus.currentRecording()).toBeNull();
    expect(JSON.stringify(bus.list({limit:bus.buffer.capacity})).length).toBeLessThan(MAX_BUFFER_BYTES);
    for(const bad of [NaN, Infinity, -1, 0, 1.5, 20_001]) expect(()=>bus.startRecording('bad',bad)).toThrow();
    for(let i=0;i<20;i++) bus.startRecording('rec-'+i,1);
    expect(bus.listRecordings()).toHaveLength(5);
    bus.clear(); expect(bus.bytes).toBe(0);
  });

  test('a burst creates bounded DOM only on a render tick; clear and close do not replay stale events', async () => {
    const pulse = initPulse({banner:false,storageKey:false,features:{solid:false,dom:false,network:false,flash:false}});
    const panel = mountPanel(pulse,{open:true,storageKey:false,rows:50});
    try {
      await pulse.run('events.clear');
      await wait();
      let added=0;
      const observer=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n instanceof Element)added+=Number(n.matches('.sp-ev'))+n.querySelectorAll('.sp-ev').length;});
      observer.observe(panel.root,{subtree:true,childList:true});
      for(let i=0;i<5000;i++)pulse.bus.emit('pulse.note',{note:'burst '+i});
      await Promise.resolve();
      expect(added).toBe(0);
      await wait();
      expect(added).toBeLessThanOrEqual(50);
      expect(panel.root.querySelectorAll('.sp-ev')).toHaveLength(50);
      expect(panel.root.textContent).toContain('burst 4999');
      await pulse.run('filters.set',{kinds:'net'});
      pulse.bus.emit('net.fetch.start',{url:'/filtered',method:'GET'});
      for(let i=0;i<300;i++)pulse.bus.emit('pulse.note',{note:'unmatched'});
      await wait(); expect(panel.root.textContent).toContain('/filtered');
      await pulse.run('filters.set',{kinds:''});
      const heavy = pulse.bus.emit('dom.mutation',{summary:Array.from({length:25},()=>({tag:'div',types:['attributes'],attributes:'x'.repeat(1000)}))},{component:{id:1,name:'HeavyComponent'},flush:7})!;
      expect(heavy.truncated).toBe(true);
      expect(heavy.component?.name).toBe('HeavyComponent'); expect(heavy.flush).toBe(7);
      await wait(); expect(panel.root.textContent).toContain('[truncated]');
      pulse.bus.emit('pulse.note',{note:'cleared pending'});
      await pulse.run('events.clear'); await wait();
      expect(panel.root.textContent).not.toContain('cleared pending');
      await pulse.run('panel.close'); added=0;
      for(let i=0;i<5000;i++)pulse.bus.emit('pulse.note',{note:'closed'});
      await wait(); expect(added).toBe(0);
      observer.disconnect();
    }finally{pulse.destroy();}
  });

  test('slow bridge bounds pending history, counts loss and resumes without blocking commands', async () => {
    const original=globalThis.WebSocket;
    let socket: any;
    class SlowSocket {
      static OPEN=1;
      readyState=1; bufferedAmount=1_000_000;
      sent:any[]=[];
      onopen?:()=>void; onclose?:()=>void;
      constructor(){socket=this;queueMicrotask(()=>this.onopen?.());}
      send(s:string){this.sent.push(JSON.parse(s));}
      close(){this.readyState=3;this.onclose?.();}
    }
    globalThis.WebSocket=SlowSocket as unknown as typeof WebSocket;
    const bus=new EventBus(); const controller=new PulseController(bus);
    const bridge=new BridgeClient(controller,{url:'ws://localhost/test',clientId:'bounded'});
    try{
      bridge.connect();await Promise.resolve();
      for(let i=0;i<10_000;i++)bus.emit('pulse.note',{note:String(i)});
      expect(bridge.queued).toBe(200); expect(bridge.dropped).toBeGreaterThan(9000);
      await wait();expect(bridge.queued).toBe(200);
      expect(socket.sent.filter((f:any)=>f.type==='events')).toHaveLength(0);
      socket.bufferedAmount=0;await wait();
      expect(bridge.queued).toBeLessThan(200);
      const batches=socket.sent.filter((f:any)=>f.type==='events');
      expect(batches.length).toBeGreaterThan(0);
      expect(batches.every((f:any)=>f.events.length<=20)).toBe(true);
      bridge.disconnect();expect(bridge.queued).toBe(0);
    }finally{bridge.disconnect();globalThis.WebSocket=original;}
  });
});
