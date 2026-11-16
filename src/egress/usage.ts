// `.openserp/usage.json`: Worker requests made today (UTC). The free plan allows 100k per account per day.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, writePrivate } from "./state.js";

export const USAGE_FILE = join(STATE_DIR, "usage.json");
const FLUSH_MS = 10_000;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** EGRESS_DAILY_LIMIT, default 100000. Throws on a value that is not a positive integer. */
export function dailyLimit(env = process.env.EGRESS_DAILY_LIMIT): number {
  if (!env) return 100_000;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1) throw new Error(`EGRESS_DAILY_LIMIT must be a positive integer, got "${env}"`);
  return n;
}

/** Today's count from `file`; 0 when the file is missing, unreadable or from another day. */
export function readUsage(file = USAGE_FILE, now = Date.now()): number {
  try {
    const u = JSON.parse(readFileSync(file, "utf8")) as { day?: unknown; count?: unknown };
    return u.day === utcDay(now) && Number.isInteger(u.count) ? (u.count as number) : 0;
  } catch {
    return 0;
  }
}

export class UsageCounter {
  private day: string;
  private count: number;
  private dirty = false;
  private lastWrite = 0;
  private warned = false;
  private refused = false;

  constructor(
    private readonly file = USAGE_FILE,
    readonly limit = dailyLimit(),
    private readonly now: () => number = Date.now,
  ) {
    this.day = utcDay(now());
    this.count = readUsage(file, now());
  }

  get today(): number {
    this.roll();
    return this.count;
  }

  /** Count one Worker request. False, with a one-time message, once today's limit is reached. */
  take(): boolean {
    this.roll();
    if (this.count >= this.limit) {
      if (!this.refused) {
        this.refused = true;
        console.error(`egress: daily limit of ${this.limit} Worker requests reached; refusing tunnels until 00:00 UTC (EGRESS_DAILY_LIMIT)`);
      }
      return false;
    }
    this.count++;
    this.dirty = true;
    if (!this.warned && this.count >= this.limit * 0.8) {
      this.warned = true;
      console.error(`egress: ${this.count} of ${this.limit} daily Worker requests used (80%)`);
    }
    if (this.now() - this.lastWrite >= FLUSH_MS) this.flush();
    return true;
  }

  flush(): void {
    if (!this.dirty) return;
    writePrivate(this.file, `${JSON.stringify({ day: this.day, count: this.count })}\n`);
    this.dirty = false;
    this.lastWrite = this.now();
  }

  private roll() {
    const day = utcDay(this.now());
    if (day === this.day) return;
    this.flush(); // keep yesterday's final count on disk until today's first write
    this.day = day;
    this.count = 0;
    this.warned = this.refused = false;
  }
}
