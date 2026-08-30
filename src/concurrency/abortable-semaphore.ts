export type SemaphorePermit = {
  release: () => void;
};

type SemaphoreWaiter = {
  resolve: (permit: SemaphorePermit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type CapacityProvider = number | (() => number);

export class AbortableSemaphore {
  readonly #capacity: CapacityProvider;
  readonly #waiters: SemaphoreWaiter[] = [];
  #activePermits = 0;

  constructor(capacity: CapacityProvider) {
    this.#capacity = capacity;
  }

  get isIdle(): boolean {
    return this.#activePermits === 0 && this.#waiters.length === 0;
  }

  async acquire(
    signal: AbortSignal | undefined,
    abortMessage: string,
  ): Promise<SemaphorePermit> {
    throwIfAborted(signal, abortMessage);

    if (
      this.#activePermits < this.#currentCapacity() &&
      this.#waiters.length === 0
    ) {
      this.#activePermits += 1;
      return this.#createPermit();
    }

    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          reject(abortError(abortMessage));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.#waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  #createPermit(): SemaphorePermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#releasePermit();
      },
    };
  }

  #releasePermit(): void {
    if (
      this.#waiters.length > 0 &&
      this.#activePermits <= this.#currentCapacity()
    ) {
      const next = this.#waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.resolve(this.#createPermit());
        return;
      }
    }

    this.#activePermits = Math.max(0, this.#activePermits - 1);
  }

  #currentCapacity(): number {
    const configured =
      typeof this.#capacity === "function" ? this.#capacity() : this.#capacity;
    if (!Number.isFinite(configured)) return 1;
    return Math.max(1, Math.floor(configured));
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) throw abortError(message);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
