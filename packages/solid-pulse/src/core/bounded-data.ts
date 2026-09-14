/** Snapshot data without retaining live objects or allowing a single event to grow arbitrarily. */
export function boundedData(value: unknown, maxChars = 8192): { value: unknown; chars: number; truncated: boolean } {
  let left = maxChars;
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  const cut = () => { truncated = true; return '[truncated]'; };
  function visit(v: unknown, depth: number): unknown {
    if (left <= 0 || ++nodes > 256 || depth > 8) return cut();
    if (typeof v === 'string') { const s = v.slice(0, left); left -= s.length; return s.length < v.length ? (truncated = true, s + '…') : s; }
    left -= 8;
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'undefined') return undefined;
    if (typeof v !== 'object') return String(v).slice(0, 80);
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        if (left <= 0 || nodes >= 256) { out.push(cut()); break; }
        out.push(visit(v[i], depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const key in v) {
      if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
      if (left <= 0 || nodes >= 256) { out['[truncated]'] = cut(); break; }
      const safeKey = key.slice(0, Math.min(left, 256)); left -= safeKey.length;
      if (safeKey !== key) truncated = true;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      out[safeKey] = descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[accessor]';
    }
    return out;
  }
  try { return { value: visit(value, 0), chars: maxChars - Math.max(0, left) + nodes * 16, truncated }; }
  catch { return { value: { error: '[uninspectable]' }, chars: 64, truncated: true }; }
}
