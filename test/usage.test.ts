import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dailyLimit, readUsage, UsageCounter } from "../src/egress/usage.js";

const file = () => join(mkdtempSync(join(tmpdir(), "openserp-usage-")), "usage.json");
const at = (iso: string) => Date.parse(iso);
const onDisk = (f: string) => JSON.parse(readFileSync(f, "utf8"));

describe("UsageCounter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("counts, writes at most every 10 s with mode 0600, and flushes on demand", () => {
    const f = file();
    let now = at("2026-11-16T10:00:00Z");
    const u = new UsageCounter(f, 100, () => now);
    expect(u.take()).toBe(true); // first take writes
    expect(onDisk(f)).toEqual({ day: "2026-11-16", count: 1 });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    u.take();
    now += 5_000;
    u.take();
    expect(onDisk(f).count).toBe(1);
    now += 5_000;
    u.take();
    expect(onDisk(f).count).toBe(4);
    u.take();
    u.flush();
    expect(onDisk(f).count).toBe(5);
    expect(new UsageCounter(f, 100, () => now).today).toBe(5); // survives a restart
  });

  it("rolls over at 00:00 UTC", () => {
    const f = file();
    let now = at("2026-11-16T23:59:59Z");
    const u = new UsageCounter(f, 100, () => now);
    u.take();
    u.take();
    now = at("2026-11-17T00:00:01Z");
    expect(u.today).toBe(0);
    expect(onDisk(f)).toEqual({ day: "2026-11-16", count: 2 });
    expect(readUsage(f, now)).toBe(0);
    u.take();
    u.flush();
    expect(onDisk(f)).toEqual({ day: "2026-11-17", count: 1 });
  });

  it("warns once at 80% and refuses at 100%, with one message each", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const u = new UsageCounter(file(), 10, () => at("2026-11-16T10:00:00Z"));
    for (let i = 0; i < 7; i++) u.take();
    expect(err).not.toHaveBeenCalled();
    u.take();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toMatch(/8 of 10.*80%/);
    expect(u.take()).toBe(true);
    expect(u.take()).toBe(true);
    expect(err).toHaveBeenCalledTimes(1);
    expect(u.take()).toBe(false);
    expect(u.take()).toBe(false);
    expect(err).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[1]![0]).toMatch(/daily limit of 10/);
    expect(u.today).toBe(10);
  });

  it("ignores a missing or malformed file", () => {
    expect(readUsage(file())).toBe(0);
  });
});

describe("dailyLimit", () => {
  it("defaults to 100000 and rejects bad values", () => {
    expect(dailyLimit(undefined)).toBe(100_000);
    expect(dailyLimit("")).toBe(100_000);
    expect(dailyLimit("500")).toBe(500);
    expect(() => dailyLimit("0")).toThrow(/positive integer/);
    expect(() => dailyLimit("abc")).toThrow(/positive integer/);
  });
});
