export class QueueFullError extends Error {}
export class JobTimeoutError extends Error {}

/** At most `maxConcurrency` jobs run and `maxQueue` wait; each job has a deadline from enqueue. */
export class Queue {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
    private readonly timeoutMs: number,
  ) {}

  get full(): boolean {
    return this.running >= this.maxConcurrency && this.waiting.length >= this.maxQueue;
  }

  async run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.full) throw new QueueFullError("server is busy, try again later");
    const signal = AbortSignal.timeout(this.timeoutMs);
    const timedOut = new Promise<never>((_, reject) => {
      const fail = () => reject(new JobTimeoutError(`no answer within ${this.timeoutMs} ms`));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    timedOut.catch(() => {});

    if (this.running < this.maxConcurrency) {
      this.running++;
    } else {
      let turn!: () => void;
      const ready = new Promise<void>((resolve) => (turn = resolve));
      this.waiting.push(turn);
      try {
        await Promise.race([ready, timedOut]);
      } catch (err) {
        const i = this.waiting.indexOf(turn);
        if (i >= 0) this.waiting.splice(i, 1);
        else this.release(); // the slot was handed over in the same tick the deadline fired
        throw err;
      }
    }

    // The slot is held until the job really settles, so a job that ignores its signal still counts.
    const work = job(signal);
    work.then(
      () => this.release(),
      () => this.release(),
    );
    return Promise.race([work, timedOut]);
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // hand the slot over; running stays the same
    else this.running--;
  }
}
