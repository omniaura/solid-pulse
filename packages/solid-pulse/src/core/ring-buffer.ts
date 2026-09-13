/** Fixed-capacity FIFO. Overwrites the oldest entry; never grows. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  private count = 0;
  /** Total number of pushes since creation (dropped + retained). */
  pushed = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.items = new Array(capacity);
  }

  get size() {
    return this.count;
  }

  get dropped() {
    return this.pushed - this.count;
  }

  push(item: T) {
    const idx = (this.head + this.count) % this.capacity;
    if (this.count === this.capacity) {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.items[idx] = item;
      this.count++;
    }
    this.pushed++;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.items[(this.head + i) % this.capacity] as T;
    }
    return out;
  }

  clear() {
    this.items = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
