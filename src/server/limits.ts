import { createHmac } from "node:crypto";
import type { Db } from "./db";

// In-memory counters for rate limiting (failed logins, online bookings). They are keyed by things a stranger
// controls (an address, a typed email), so they must not be able to grow without end.

export interface BoundedMapOptions<V> {
  /** Most keys ever held. When full, entries that have expired go first, then the oldest written. */
  maxKeys: number;
  /** How often, at most, the whole map is swept for expired entries. */
  sweepEveryMs: number;
  /** True when an entry no longer matters and can be dropped. */
  expired: (value: V, nowMs: number) => boolean;
}

export class BoundedMap<V> {
  private readonly map = new Map<string, V>();
  private lastSweep = 0;

  constructor(private readonly options: BoundedMapOptions<V>) {}

  get size(): number {
    return this.map.size;
  }

  /** The live entry for `key`. An expired one is dropped and reads as absent. */
  get(key: string, nowMs: number): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined && this.options.expired(value, nowMs)) {
      this.map.delete(key);
      return undefined;
    }
    return value;
  }

  set(key: string, value: V, nowMs: number): void {
    if (nowMs - this.lastSweep >= this.options.sweepEveryMs) this.sweep(nowMs);
    // Written again means newest: a Map keeps insertion order, so the first key is the one written longest ago.
    this.map.delete(key);
    if (this.map.size >= this.options.maxKeys) this.sweep(nowMs);
    while (this.map.size >= this.options.maxKeys) {
      // Still full of live entries. Dropping the oldest forgets one counter early, which is the lesser harm
      // next to letting anyone fill the server's memory.
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Drops every expired entry. */
  sweep(nowMs: number): void {
    this.lastSweep = nowMs;
    for (const [key, value] of this.map) {
      if (this.options.expired(value, nowMs)) this.map.delete(key);
    }
  }
}

/** Keys kept per limiter. Each entry is a few dozen bytes, so this is a few megabytes at the very worst. */
export const MAX_LIMITER_KEYS = 10_000;

// ---- the limiter the routes use --------------------------------------------------------------------------
//
// One question, asked the same way wherever the counters live: "may this party do this once more?".
// Asking counts. The check and the count are one step, so many requests arriving together cannot each see
// "still under the limit" and all go through.

export type Bucket = "login" | "booking" | "reset";

export interface RateLimiter {
  /**
   * Counts one more event for `key` unless `max` have already been counted within the last `windowMs`.
   * True: counted, go ahead. False: at the limit, nothing counted.
   */
  attempt(bucket: Bucket, key: string, max: number, windowMs: number, now: Date): Promise<boolean>;
  /** Forgets what was counted for `key` (a successful login wipes the failed attempts before it). */
  forgive(bucket: Bucket, key: string): Promise<void>;
  /** Drops everything that can no longer matter. Called now and then by the server's housekeeping. */
  prune(now: Date): Promise<number>;
  /** Forgets a whole bucket. For tests. */
  reset(bucket: Bucket): Promise<void>;
}

/** No window is longer than this, so anything older is dead weight. */
export const LONGEST_WINDOW_MS = 60 * 60 * 1000;

/**
 * Counters in this process's memory. Right for one long-running server on the built-in database; wrong for
 * anything that runs as several instances, where each would count for itself.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly events = new BoundedMap<number[]>({
    maxKeys: MAX_LIMITER_KEYS,
    sweepEveryMs: LONGEST_WINDOW_MS,
    expired: (times, nowMs) => times.every((t) => nowMs - t >= LONGEST_WINDOW_MS),
  });

  async attempt(bucket: Bucket, key: string, max: number, windowMs: number, now: Date): Promise<boolean> {
    const id = `${bucket}|${key}`;
    const nowMs = now.getTime();
    const live = (this.events.get(id, nowMs) ?? []).filter((t) => nowMs - t < windowMs);
    if (live.length >= max) return false;
    live.push(nowMs);
    this.events.set(id, live, nowMs);
    return true;
  }

  async forgive(bucket: Bucket, key: string): Promise<void> {
    this.events.delete(`${bucket}|${key}`);
  }

  async prune(now: Date): Promise<number> {
    const before = this.events.size;
    this.events.sweep(now.getTime());
    return before - this.events.size;
  }

  async reset(): Promise<void> {
    this.events.clear();
  }
}

/**
 * Counters in the database, shared by every instance of the application.
 * Who a counter belongs to is stored as an HMAC under `secret`: the table holds no email address and no
 * network address, and cannot be turned back into either without the secret.
 */
export class DatabaseRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  private hash(bucket: Bucket, key: string): string {
    return createHmac("sha256", this.secret).update(`${bucket}|${key}`).digest("hex");
  }

  async attempt(bucket: Bucket, key: string, max: number, windowMs: number, now: Date): Promise<boolean> {
    const hash = this.hash(bucket, key);
    return this.db.tx(async (q) => {
      // One party is counted by one request at a time, on whichever instance it lands: the lock is held by
      // the database until this transaction ends. Different parties do not wait for each other.
      await q.query("SELECT pg_advisory_xact_lock(('x' || substr($1, 1, 16))::bit(64)::bigint)", [hash]);
      const since = new Date(now.getTime() - windowMs);
      // What has run out of its window goes, so a party's rows never pile up.
      await q.query("DELETE FROM rate_events WHERE bucket = $1 AND key_hash = $2 AND at <= $3", [bucket, hash, since]);
      const counted = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM rate_events WHERE bucket = $1 AND key_hash = $2", [bucket, hash]);
      if (counted[0]!.n >= max) return false;
      await q.query("INSERT INTO rate_events (bucket, key_hash, at) VALUES ($1, $2, $3)", [bucket, hash, now]);
      return true;
    });
  }

  async forgive(bucket: Bucket, key: string): Promise<void> {
    await this.db.query("DELETE FROM rate_events WHERE bucket = $1 AND key_hash = $2", [bucket, this.hash(bucket, key)]);
  }

  /** Parties that never came back leave rows behind; this removes them once no window can still hold them. */
  async prune(now: Date): Promise<number> {
    const gone = await this.db.query("DELETE FROM rate_events WHERE at <= $1 RETURNING id", [new Date(now.getTime() - LONGEST_WINDOW_MS)]);
    return gone.length;
  }

  async reset(bucket: Bucket): Promise<void> {
    await this.db.query("DELETE FROM rate_events WHERE bucket = $1", [bucket]);
  }
}
