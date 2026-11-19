// SPDX-License-Identifier: MIT
/** Serializes actual callbacks and spaces their starts using a monotonic clock. */
export class OperationPacer {
  private intervalMs: number;
  private lastStartedAt = -Infinity;
  private queue: Pending[] = [];
  private draining = false;
  private current?: Pending;
  private wake?: () => void;

  constructor(intervalMs: number) {
    this.validate(intervalMs);
    this.intervalMs = intervalMs;
  }
  getInterval(): number { return this.intervalMs; }
  setInterval(intervalMs: number): void {
    this.validate(intervalMs);
    if (intervalMs === this.intervalMs) return;
    this.intervalMs = intervalMs;
    this.wake?.();
  }
  private validate(intervalMs: number): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000)
      throw new Error('Operation interval must be an integer between 0 and 5000ms');
  }
  run<T>(work: () => Promise<T>, signal?: AbortSignal, beforeStart?: () => void, prepare?: () => Promise<void>): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        work, resolve: value => resolve(value as T), reject, signal, beforeStart, prepare,
        started: false, cancelled: false,
      };
      pending.abort = () => {
        // An aborted connection cannot prove that an already-started business callback stopped.
        if (pending.started) return;
        pending.cancelled = true;
        reject(signal?.reason ?? new DOMException('Operation aborted', 'AbortError'));
        signal?.removeEventListener('abort', pending.abort!);
        if (this.current === pending) this.wake?.();
      };
      signal?.addEventListener('abort', pending.abort, {once: true});
      this.queue.push(pending);
      if (!this.draining) void this.drain();
    });
  }
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length) {
        const pending = this.queue.shift()!;
        this.current = pending;
        try {
          if (pending.cancelled) throw pending.signal?.reason;
          // Preparation owns the same serial slot, but never anchors actual business timing.
          await pending.prepare?.();
          while (true) {
            if (pending.cancelled) throw pending.signal?.reason;
            // Round conservatively at the callback boundary; browser timestamps can be quantized.
            const remaining = this.lastStartedAt + this.intervalMs + (this.intervalMs > 0 ? 1 : 0) - performance.now();
            if (remaining <= 0) break;
            await this.wait(remaining);
          }
          if (pending.cancelled) throw pending.signal?.reason;
          pending.beforeStart?.();
          if (pending.cancelled) throw pending.signal?.reason;
          pending.started = true;
          this.lastStartedAt = performance.now();
          pending.resolve(await pending.work());
        } catch (error) {
          pending.reject(error);
        } finally {
          pending.signal?.removeEventListener('abort', pending.abort!);
          this.current = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.ceil(ms));
      this.wake = finish;
    });
  }
}
interface Pending {
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  beforeStart?: () => void;
  prepare?: () => Promise<void>;
  abort?: () => void;
  started: boolean;
  cancelled: boolean;
}
