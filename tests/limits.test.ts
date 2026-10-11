import { describe, expect, it } from "vitest";
import { BoundedMap, LONGEST_WINDOW_MS, MemoryRateLimiter } from "../src/server/limits";
import { seedRefusal } from "../src/server/seed-guard";

// No database here: these are the two small guards that keep the server safe from its own conveniences.

describe("the in-memory limiter store", () => {
  const WINDOW = 1000;
  const make = (maxKeys: number) => new BoundedMap<{ at: number }>({ maxKeys, sweepEveryMs: WINDOW, expired: (v, now) => now - v.at >= WINDOW });

  it("forgets entries once they have expired, also for keys that are never used again", () => {
    const map = make(100);
    for (let i = 0; i < 50; i++) map.set(`stranger-${i}`, { at: 0 }, 0);
    expect(map.size).toBe(50);
    // One unrelated write after the window: the fifty abandoned keys are swept out.
    map.set("someone-else", { at: WINDOW }, WINDOW);
    expect(map.size).toBe(1);
  });

  it("reads an expired entry as absent", () => {
    const map = make(100);
    map.set("a", { at: 0 }, 0);
    expect(map.get("a", WINDOW - 1)).toEqual({ at: 0 });
    expect(map.get("a", WINDOW)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("never holds more keys than its cap, dropping the oldest written when all are still live", () => {
    const map = make(3);
    map.set("a", { at: 1 }, 1);
    map.set("b", { at: 2 }, 2);
    map.set("c", { at: 3 }, 3);
    map.set("a", { at: 4 }, 4); // written again: now the newest
    map.set("d", { at: 5 }, 5);
    expect(map.size).toBe(3);
    expect(map.get("b", 5)).toBeUndefined();
    expect(map.get("a", 5)).toEqual({ at: 4 });
    for (let i = 0; i < 1000; i++) map.set(`flood-${i}`, { at: 6 }, 6);
    expect(map.size).toBe(3);
  });

  it("when full, makes room from expired entries before touching live ones", () => {
    const map = new BoundedMap<{ at: number }>({ maxKeys: 3, sweepEveryMs: 1_000_000, expired: (v, now) => now - v.at >= WINDOW });
    map.set("old-1", { at: 0 }, 0);
    map.set("old-2", { at: 0 }, 0);
    map.set("live", { at: 900 }, 900);
    map.set("new", { at: 1200 }, 1200);
    expect(map.get("live", 1200)).toEqual({ at: 900 });
    expect(map.get("new", 1200)).toEqual({ at: 1200 });
    expect(map.size).toBe(2);
  });
});

describe("the limiter kept in memory (one long-running server)", () => {
  const at = (ms: number) => new Date(1_000_000 + ms);

  it("lets a party through up to the limit within the window, and again once the window has moved on", async () => {
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) expect(await limiter.attempt("login", "a", 3, 1000, at(i * 100))).toBe(true);
    expect(await limiter.attempt("login", "a", 3, 1000, at(300))).toBe(false);
    // Another party, and the same party in the other bucket, are counted apart.
    expect(await limiter.attempt("login", "b", 3, 1000, at(300))).toBe(true);
    expect(await limiter.attempt("booking", "a", 3, 1000, at(300))).toBe(true);
    // The first event leaves the window at 1000; a refused attempt was not counted, so one place is free.
    expect(await limiter.attempt("login", "a", 3, 1000, at(1000))).toBe(true);
    expect(await limiter.attempt("login", "a", 3, 1000, at(1001))).toBe(false);
  });

  it("forgets a party when told to, and stale parties when pruned", async () => {
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) await limiter.attempt("login", "a", 3, 1000, at(0));
    expect(await limiter.attempt("login", "a", 3, 1000, at(1))).toBe(false);
    await limiter.forgive("login", "a");
    expect(await limiter.attempt("login", "a", 3, 1000, at(2))).toBe(true);
    await limiter.attempt("booking", "never-again", 6, 1000, at(2));
    expect(await limiter.prune(at(2 + LONGEST_WINDOW_MS))).toBe(2);
  });
});

describe("the demo seed", () => {
  it("runs on a development machine with the built-in database", () => {
    expect(seedRefusal({})).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "", NODE_ENV: "development" })).toBeNull();
  });

  it("refuses a configured database, and production, unless told to in so many words", () => {
    expect(seedRefusal({ DATABASE_URL: "postgres://db.example/clinic" })).toContain("DATABASE_URL");
    expect(seedRefusal({ NODE_ENV: "production" })).toContain("production");
    // Only the exact word opts in.
    expect(seedRefusal({ DATABASE_URL: "postgres://db.example/clinic", ALLOW_DEMO_SEED: "1" })).not.toBeNull();
    expect(seedRefusal({ DATABASE_URL: "postgres://db.example/clinic", ALLOW_DEMO_SEED: "true" })).not.toBeNull();
    expect(seedRefusal({ DATABASE_URL: "postgres://db.example/clinic", ALLOW_DEMO_SEED: "yes" })).toBeNull();
    expect(seedRefusal({ NODE_ENV: "production", ALLOW_DEMO_SEED: "yes" })).toBeNull();
  });

  it("does not repeat the connection string, which can hold a password", () => {
    expect(seedRefusal({ DATABASE_URL: "postgres://user:sekret@db.example/clinic" })).not.toContain("sekret");
  });
});
