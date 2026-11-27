import type { Observation } from './types.js';

/**
 * Bounded in-process event store. When a budget is exceeded the oldest events are evicted and counted,
 * so a reference to an evicted event resolves to "unavailable" instead of silently disappearing.
 */
export class EventStore {
  private events: Observation[] = [];
  private index = new Map<string, Observation>();
  private sizes = new Map<string, number>();
  sequence = 0;
  bytes = 0;
  dropped = 0;

  constructor(readonly maxEvents: number, readonly maxBytes: number) {}

  add(e: Omit<Observation, 'eventId' | 'sequence' | 'schemaVersion'>): Observation {
    const sequence = ++this.sequence;
    const ev: Observation = { schemaVersion: 1, eventId: `E-${sequence}`, sequence, ...e };
    const size = 220 + JSON.stringify(ev.data).length + ev.action.reason.length;
    while (this.events.length && (this.events.length >= this.maxEvents || this.bytes + size > this.maxBytes)) this.evict();
    this.events.push(ev); this.index.set(ev.eventId, ev); this.sizes.set(ev.eventId, size); this.bytes += size;
    return ev;
  }

  private evict() {
    const old = this.events.shift()!;
    this.index.delete(old.eventId);
    this.bytes -= this.sizes.get(old.eventId) ?? 0; this.sizes.delete(old.eventId);
    this.dropped++;
  }

  get(id: string): Observation | undefined { return this.index.get(id); }
  /** 'evicted' when the id was issued but is no longer retained */
  availability(id: string): 'available' | 'evicted' | 'unknown' {
    if (this.index.has(id)) return 'available';
    const n = Number(id.replace(/^E-/, ''));
    return Number.isInteger(n) && n >= 1 && n <= this.sequence ? 'evicted' : 'unknown';
  }
  all(): readonly Observation[] { return this.events; }
  get size() { return this.events.length; }
  clear() { this.events = []; this.index.clear(); this.sizes.clear(); this.bytes = 0; }
}
